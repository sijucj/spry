/**
 * Create a strongly-typed event bus built directly on top of the standard
 * Web/Deno `EventTarget`/`CustomEvent` primitives.
 *
 * Unlike many ad-hoc emitter utilities, this bus:
 * - Uses the platform event loop via `EventTarget.dispatchEvent`, so it behaves
 *   like native DOM/Deno events (bubble/capture aren’t used, but delivery and
 *   microtask timing match platform semantics).
 * - Emits `CustomEvent<Detail>` and adapts user listeners to/from DOM
 *   `EventListener` functions, preserving interop with any code expecting a real
 *   `EventTarget` (e.g., `addEventListener`, `AbortSignal`, `DOMException`).
 * - Derives listener call signatures from a generic event map `M`. If an event
 *   detail type is `void`, the listener is invoked with no arguments; otherwise
 *   it receives exactly one argument of the mapped detail type.
 *
 * @template M extends Record<string, unknown | void>
 * A map of event names to their payload ("detail") types. Keys must be `string`.
 * For example:
 *
 * ```ts
 * type BusEvents = {
 *   "ready": void;                    // no payload
 *   "log": { level: "info"|"warn"; message: string };
 *   "progress": number;
 * };
 *
 * const bus = eventBus<BusEvents>();
 * ```
 *
 * ## Listener shapes
 * A listener can be either a function or an object with a `handle` method:
 *
 * - Function form: `(detail) => void | Promise<void>`
 * - Object form: `{ handle(detail) { … } }`
 *
 * The detail parameter is omitted entirely when the mapped type is `void`.
 *
 * ## Delivery modes
 * - `emit(type, detail?)`: sync dispatch via `EventTarget.dispatchEvent(...)`.
 *   Exceptions thrown by listeners will surface as usual (like DOM events).
 * - `emitParallel(type, detail?)`: invoke current listeners concurrently and
 *   await all of them; errors reject the returned promise.
 * - `emitSerial(type, detail?)`: invoke current listeners in registration order
 *   and await each one; errors reject the returned promise.
 * - `emitSafe(type, detail?)`: like parallel, but collects and returns an array
 *   of thrown errors instead of rejecting.
 *
 * ## Control utilities
 * - `on(type, listener, opts?)` / `once(type, listener)`: add listeners
 *   (de-duped per identity) and return an unsubscribe function.
 * - `off(type, listener)`: remove a specific listener.
 * - `removeAllListeners(type?)`: remove listeners for one event or all events.
 * - `listenerCount(type)` / `hasListener(type)`: quick introspection.
 * - `rawListeners(type)`: snapshot of the current listeners for an event.
 * - `eventNames()`: list of event names with listeners.
 * - `mute(type)` / `unmute(type)`: temporarily suppress emits for an event.
 * - `suspend()` / `resume()`: globally suppress all emits.
 * - `waitFor(type, { signal }?)`: promise that resolves with the next detail
 *   (abortable via `AbortSignal`; rejects with `DOMException('AbortError')`).
 * - `timeoutWaitFor(type, ms)`: like `waitFor` but rejects with
 *   `DOMException('TimeoutError')` if not received in time.
 * - `all(listener)`: register a catch-all `(type, detail) => …` observer.
 * - `debugListeners()`: returns a `{ [eventName]: count }` snapshot.
 *
 * ## Interop notes (the “unobvious” bit)
 * - The returned object exposes a real `target: EventTarget`. You can intermix
 *   native listeners (`addEventListener`) with bus listeners (`on/once`).
 * - Events are delivered as `CustomEvent<Detail>` where `detail` carries your
 *   payload, so external code that inspects `event.detail` will work.
 * - Because dispatch uses the platform, timing and error behaviors match what
 *   you expect from web/Deno events instead of reinvented semantics.
 *
 * @returns An immutable API for registering, emitting, and observing events,
 * including the underlying `target: EventTarget` for direct interop.
 *
 * @example Basic usage (no-arg event)
 * ```ts
 * type E = { ready: void };
 * const bus = eventBus<E>();
 *
 * bus.once("ready", () => console.log("system ready"));
 * bus.emit("ready"); // no payload required for void
 * ```
 *
 * @example Typed payloads and parallel delivery
 * ```ts
 * type E = {
 *   log: { level: "info"|"warn"; message: string };
 *   progress: number;
 * };
 * const bus = eventBus<E>();
 *
 * const off = bus.on("log", ({ level, message }) => {
 *   console[level](`[${level}] ${message}`);
 * });
 *
 * await bus.emitParallel("log", { level: "info", message: "hello" });
 * off();
 * ```
 *
 * @example Interop with native EventTarget listeners
 * ```ts
 * type E = { tick: number };
 * const bus = eventBus<E>();
 *
 * // Native listener sees a CustomEvent<number>
 * bus.target.addEventListener("tick", (ev) => {
 *   const n = (ev as CustomEvent<number>).detail;
 *   // …
 * });
 *
 * bus.emit("tick", 42);
 * ```
 */
export function eventBus<M extends Record<string, unknown | void>>() {
  type Key = Extract<keyof M, string>;
  type Detail<K extends Key> = M[K];
  type Args<K extends Key> = Detail<K> extends void ? [] : [Detail<K>];

  type ListenerFn<K extends Key> = (...args: Args<K>) => void | Promise<void>;
  type ListenerObj<K extends Key> = { handle: ListenerFn<K> };
  type Listener<K extends Key> = ListenerFn<K> | ListenerObj<K>;

  // Internal listener type (no `any`)
  type UnknownListener =
    | ((...args: readonly unknown[]) => void | Promise<void>)
    | { handle: (...args: readonly unknown[]) => void | Promise<void> };

  type AllFn = <K extends Key>(
    type: K,
    detail: Detail<K>,
  ) => void | Promise<void>;

  const target = new EventTarget();
  const listenerMap = new Map<Key, Map<UnknownListener, EventListener>>();
  const muted = new Set<Key>();
  const allListeners = new Set<AllFn>();
  let suspended = false;

  const ensureMap = <K extends Key>(type: K) => {
    if (!listenerMap.has(type)) listenerMap.set(type, new Map());
    return listenerMap.get(type)! as unknown as Map<Listener<K>, EventListener>;
  };

  const callUser = <K extends Key>(l: Listener<K>, args: Args<K>) => {
    if (typeof l === "function") return l(...args);
    return l.handle(...args);
  };

  const toDomHandler = <K extends Key>(
    type: K,
    listener: Listener<K>,
    onceCleanup?: boolean,
  ): EventListener => {
    return (ev) => {
      const ce = ev as CustomEvent<Detail<K>>;
      const args = (ce.detail === undefined ? [] : [ce.detail]) as Args<K>;
      void callUser(listener, args);
      if (onceCleanup) {
        const map = listenerMap.get(type);
        map?.delete(listener as unknown as UnknownListener);
      }
    };
  };

  const notifyAll = <K extends Key>(type: K, detail: Detail<K>) => {
    for (const fn of allListeners) void fn(type, detail);
  };

  const api = {
    on<K extends Key>(
      type: K,
      listener: Listener<K>,
      opts?: boolean | AddEventListenerOptions,
    ) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener); // de-dupe
      const h = toDomHandler(type, listener);
      map.set(listener, h);
      target.addEventListener(type, h, opts);
      return () => api.off(type, listener);
    },

    once<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener);
      const h = toDomHandler(type, listener, true);
      map.set(listener, h);
      target.addEventListener(type, h, { once: true });
      return () => api.off(type, listener);
    },

    off<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      const h = map.get(listener);
      if (h) {
        target.removeEventListener(type, h);
        map.delete(listener);
        if (map.size === 0) listenerMap.delete(type);
      }
    },

    emit<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return false;
      const d = (detail.length ? detail[0] : undefined) as Detail<K>;
      const dispatched = target.dispatchEvent(
        new CustomEvent(type, { detail: d }),
      );
      // Notify catch-all regardless of per-event listeners
      notifyAll(type, d);
      return dispatched;
    },

    async emitParallel<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return;
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      await Promise.all(handlers.map((l) => callUser(l, args)));
      // Catch-all after listeners
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
    },

    async emitSerial<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return;
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      for (const l of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await callUser(l, args);
      }
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
    },

    async emitSafe<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return [] as unknown[];
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      const errors: unknown[] = [];
      await Promise.all(
        handlers.map(async (l) => {
          try {
            await callUser(l, args);
          } catch (e) {
            errors.push(e);
          }
        }),
      );
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
      return errors;
    },

    listenerCount<K extends Key>(type: K) {
      return listenerMap.get(type)?.size ?? 0;
    },

    hasListener<K extends Key>(type: K) {
      return (listenerMap.get(type)?.size ?? 0) > 0;
    },

    removeAllListeners(type?: Key) {
      if (type) {
        const map = listenerMap.get(type);
        if (map) {
          for (const h of map.values()) target.removeEventListener(type, h);
          listenerMap.delete(type);
        }
      } else {
        for (const [k, map] of listenerMap.entries()) {
          for (const h of map.values()) target.removeEventListener(k, h);
        }
        listenerMap.clear();
        allListeners.clear();
      }
    },

    waitFor<K extends Key>(type: K, opts?: { signal?: AbortSignal }) {
      return new Promise<Detail<K>>((resolve, reject) => {
        const handler = (ev: Event) =>
          resolve((ev as CustomEvent<Detail<K>>).detail);
        target.addEventListener(type, handler, { once: true });
        if (opts?.signal) {
          const onAbort = () => {
            target.removeEventListener(type, handler);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },

    timeoutWaitFor<K extends Key>(type: K, ms: number) {
      return new Promise<Detail<K>>((resolve, reject) => {
        const handler = (ev: Event) => {
          clearTimeout(timer);
          resolve((ev as CustomEvent<Detail<K>>).detail);
        };
        const timer = setTimeout(() => {
          target.removeEventListener(type, handler);
          reject(new DOMException("Timeout", "TimeoutError"));
        }, ms);
        target.addEventListener(type, handler, { once: true });
      });
    },

    all(listener: AllFn) {
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
      };
    },

    eventNames() {
      return Object.freeze(Array.from(listenerMap.keys())) as readonly Key[];
    },

    rawListeners<K extends Key>(type: K) {
      const map = ensureMap(type);
      return Object.freeze(Array.from(map.keys())) as readonly Listener<K>[];
    },

    mute<K extends Key>(type: K) {
      muted.add(type);
    },
    unmute<K extends Key>(type: K) {
      muted.delete(type);
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
    },

    debugListeners() {
      const out: Record<string, number> = {};
      for (const [k, map] of listenerMap.entries()) out[k] = map.size;
      return out as Readonly<typeof out>;
    },

    target,
  } as const;

  return api;
}
