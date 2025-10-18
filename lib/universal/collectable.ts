/**
 * collectable.ts — tiny iterable/async-iterable normalization helpers.
 *
 * Why this exists:
 * In real-world libraries and apps you often want to accept either a synchronous
 * Iterable<T> (e.g., arrays, Sets) or an AsyncIterable<T> (e.g., async generators,
 * streamed sources). Downstream, however, consuming both forms complicates code:
 * you need two code paths or a bunch of instanceof/feature checks.
 *
 * This module provides a minimal, dependency-free way to:
 * 1) Detect whether a value is AsyncIterable (via a proper ES check),
 * 2) Normalize any Iterable | AsyncIterable into an AsyncIterable so you can
 *    always `for await (...)` over inputs—cleaner control flow and single-path DX.
 *
 * Notes:
 * - These helpers are not part of the Deno stdlib or TypeScript runtime.
 * - They work in Deno, Node, and modern browsers (ES2018+ with async iterators).
 * - `toAsync()` is zero-overhead for already-async inputs; for sync inputs it wraps
 *   them in an async generator that yields in order without buffering everything.
 */

/**
 * A convenience type for APIs that accept either a synchronous Iterable<T> or
 * an asynchronous AsyncIterable<T>. Useful for ergonomic function signatures.
 */
export type Asyncish<T> = AsyncIterable<T> | Iterable<T>;

/**
 * Type guard that checks whether an unknown value implements AsyncIterable<T>.
 *
 * Rationale:
 * - The canonical way to detect async iterability is to look for a function-valued
 *   property keyed by Symbol.asyncIterator per the ECMAScript spec.
 * - `instanceof` checks aren't reliable across realms or transpiled code,
 *   so feature detection is preferred.
 *
 * @example
 * if (isAsyncIterable(source)) {
 *   // Safe to use `for await` directly
 *   for await (const item of source) { ... }
 * } else {
 *   // Fallback for sync iterables
 *   for (const item of source as Iterable<unknown>) { ... }
 * }
 *
 * @param obj - A value that may or may not be AsyncIterable.
 * @returns True if `obj` has a function at Symbol.asyncIterator.
 */
export function isAsyncIterable<T>(obj: unknown): obj is AsyncIterable<T> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
        Symbol.asyncIterator
      ] === "function"
  );
}

export function isAsyncIterator(x: unknown): x is AsyncIterator<unknown> {
  return !!x && typeof (x as { next?: unknown }).next === "function";
}

/**
 * Normalize any Iterable or AsyncIterable into an AsyncIterable.
 *
 * Why you need this:
 * - It lets your API accept `Asyncish<T>` but internally operate on a single
 *   abstraction: `AsyncIterable<T>`. That means downstream code always uses
 *   `for await (...)` and never needs branches for sync vs async inputs.
 * - For already-async inputs, it returns the input unchanged (no extra wrapping).
 * - For sync inputs, it returns an async generator that yields items in order.
 *
 * Guarantees:
 * - Order is preserved.
 * - No pre-buffering of the entire input; items are yielded lazily.
 * - Zero-copy for AsyncIterable inputs.
 *
 * @example
 * async function consume<T>(input: Asyncish<T>) {
 *   for await (const x of toAsync(input)) {
 *     console.log(x);
 *   }
 * }
 *
 * @param it - An Iterable<T> or AsyncIterable<T>.
 * @returns An AsyncIterable<T> view over `it`.
 */
export function toAsync<T>(it: Asyncish<T>): AsyncIterable<T> {
  if (isAsyncIterable<T>(it)) return it;
  return (async function* () {
    for (const x of it as Iterable<T>) yield x;
  })();
}

/**
 * Consumes an entire async generator and collects:
 *   1. all items it yields, and
 *   2. the final value it returns.
 *
 * This is useful when you need both the stream of yielded results
 * and the generator’s eventual return (which `for await...of` discards).
 *
 * @template T,R
 * @param {AsyncGenerator<T, R, unknown>} gen
 *   The async generator to fully iterate.
 *
 * @returns {Promise<{ items: T[]; result: R }>}
 *   A promise resolving to an object with:
 *   - `items`: array of all yielded values
 *   - `result`: the final return value from the generator
 *
 * @example
 * async function* makeNumbers() {
 *   yield 1; yield 2; return 3;
 * }
 *
 * const { items, result } = await collectAsyncGenerator(makeNumbers());
 * // items = [1, 2]
 * // result = 3
 *
 * @example
 * const gen = this.sqlPageFiles({ mdSources, srcRelTo, state });
 * const { items: files, result: prepared } = await collectAsyncGenerator(gen);
 * // `files` are all yielded SqlPageFile objects
 * // `prepared` is the final state returned by sqlPageFiles()
 */
export async function collectAsyncGenerated<T, R>(
  gen: AsyncGenerator<T, R, unknown>,
): Promise<{ items: T[]; result: R }> {
  const items: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { items, result: value as R };
    items.push(value);
  }
}
