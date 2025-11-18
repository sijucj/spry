/**
 * Lazy text-loading abstractions for heterogeneous sources.
 *
 * This module turns arbitrary “provenance” specs into typed, lazy `Source`s:
 *
 * - `sources()` classifies each provenance as either:
 *   - `"remote-url"` → loaded via `fetch()`
 *   - `"local-fs"`   → loaded via `Deno.readTextFile()`
 * - `textSources()` then materializes text for each `Source`, with a hook
 *   for centralized error handling (`onError`).
 *
 * Nothing is loaded eagerly — text is only fetched/read when `text()` or
 * `safeText()` is awaited. This makes it suitable for large batches and
 * streaming-style pipelines.
 *
 * @module
 */

/**
 * A minimal, extensible type describing where a resource originates.
 *
 * `SourceProvenance` supports two forms:
 *
 * 1. A bare string — typically a URL or file path.
 * 2. An object whose single string property is a caller-defined key
 *    (default: `"path"`), e.g. `{ path: "…" }`, `{ filePath: "…" }`,
 *    `{ href: "…" }`, etc.
 *
 * The generic `PathKey` parameter allows callers to match the provenance
 * shape used in their own domain without Spry imposing a mandatory field
 * name. This keeps the API simple while enabling future extensibility and
 * strong typing across the entire loading pipeline.
 *
 * @typeParam PathKey - The property name to use when provenance is provided
 *                      as an object. Defaults to `"path"`.
 */
export type SourceProvenance<PathKey extends string = "path"> =
  | string
  | { [K in PathKey]: string };

export type SourceLabel = string;

export interface AnySource<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
> {
  readonly nature: "remote-url" | "local-fs";
  readonly provenance: SP;
  readonly label: SourceLabel;

  /** Load the underlying resource as text. May throw. */
  readonly text: () => Promise<string>;

  /**
   * A safe loader that never throws.
   *
   * - If defaultText provided → return text or defaultText
   * - If no defaultText → return text or an Error
   */
  readonly safeText: (defaultText?: string) => Promise<string | Error>;
}

export type Source<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
> =
  | AnySource<PathKey, SP>
  | AnySource<PathKey, SP> & {
    readonly nature: "remote-url";
    readonly url: URL;
  };

/**
 * Classify provenance specs into lazy text-loading Sources.
 *
 * - remote-url → loaded by fetch()
 * - local-fs  → loaded by Deno.readTextFile()
 *
 * Accepts either a synchronous Iterable or an AsyncIterable of `provenance`.
 * Nothing is loaded eagerly — only when text()/safeText() is awaited.
 */
export async function* sources<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
>(src: Iterable<SP> | AsyncIterable<SP>, pathKey: PathKey = "path" as PathKey) {
  /** Only treat http(s) as remote URLs. */
  function tryParseUrl(spec: SP): URL | undefined {
    try {
      const raw = typeof spec === "string"
        ? spec
        : (spec as Record<PathKey, string>)[pathKey];

      const url = new URL(raw);
      return (url.protocol === "http:" || url.protocol === "https:")
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  }

  for await (const provenance of src) {
    const url = tryParseUrl(provenance);

    if (url) {
      // Remote Source
      const text = async (): Promise<string> => {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return await res.text();
      };

      const safeText = async (
        defaultText?: string,
      ): Promise<string | Error> => {
        try {
          return await text();
        } catch (err) {
          if (defaultText !== undefined) return defaultText;
          return err instanceof Error ? err : new Error(String(err));
        }
      };

      yield {
        nature: "remote-url",
        provenance,
        text,
        safeText,
        label: url.pathname,
        url,
      } satisfies Source<PathKey, SP>;
    } else {
      // Local Source
      const text = async (): Promise<string> => {
        const raw = typeof provenance === "string"
          ? provenance
          : (provenance as Record<PathKey, string>)[pathKey];

        return await Deno.readTextFile(raw);
      };

      const safeText = async (
        defaultText?: string,
      ): Promise<string | Error> => {
        try {
          return await text();
        } catch (err) {
          if (defaultText !== undefined) return defaultText;
          return err instanceof Error ? err : new Error(String(err));
        }
      };

      yield {
        nature: "local-fs",
        provenance,
        text,
        safeText,
        label: typeof provenance === "string"
          ? provenance
          : (provenance as Record<PathKey, string>)[pathKey],
      } satisfies Source<PathKey, SP>;
    }
  }
}

/**
 * Async generator that yields only unique `Source`s from the input.
 *
 * Uniqueness is determined by the pair:
 *
 * - `source.nature`
 * - `source.provenance` (stringified for object provenance)
 *
 * This means:
 * - Two sources with the same `nature` and same string provenance are treated
 *   as duplicates.
 * - Two sources with the same `nature` and structurally equal provenance
 *   objects (e.g. `{ path: "a" }` and `{ path: "a" }`) are treated as
 *   duplicates.
 *
 * The order of the first occurrence is preserved.
 */
export async function* uniqueSources<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
>(
  srcs:
    | Iterable<Source<PathKey, SP>>
    | AsyncIterable<Source<PathKey, SP>>,
): AsyncGenerator<Source<PathKey, SP>, void, unknown> {
  const seen = new Set<string>();

  for await (const src of srcs) {
    const prov = src.provenance;
    const provKey = typeof prov === "string" ? prov : JSON.stringify(prov);

    const key = `${src.nature}:${provKey}`;

    if (seen.has(key)) continue;
    seen.add(key);

    yield src;
  }
}

/**
 * Async generator that materializes text for each Source.
 *
 * - If `safeText()` resolves to a string → yields `{ source, text }`
 * - If it resolves to an Error:
 *   - If `options.onError` is provided → calls it and, if the return is not `false`,
 *     yields that value.
 *   - If `options.onError` is absent or returns `false` → skips that source.
 */
export async function* textSources<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
>(
  srcs:
    | Iterable<Source<PathKey, SP>>
    | AsyncIterable<Source<PathKey, SP>>,
  options?: {
    readonly onError?: (
      src: Source<PathKey, SP>,
      error: Error,
    ) =>
      | { src: Source<PathKey, SP>; text: string }
      | false
      | Promise<{ src: Source<PathKey, SP>; text: string } | false>;
  },
) {
  for await (const src of srcs) {
    const text = await src.safeText();

    if (typeof text === "string") {
      yield { src, text };
      continue;
    }

    const error = text instanceof Error ? text : new Error(String(text));
    const replaced = await options?.onError?.(src, error);
    if (replaced) {
      yield replaced;
    }
  }
}
