// content-acquisition.ts
import { fromFileUrl, isAbsolute, join, normalize } from "jsr:@std/path@^1";

export enum SourceRelativeTo {
  LocalFs = "fs",
  Module = "module",
}

export interface RemoteContent {
  readonly data: Uint8Array;
  readonly source: URL;
  readonly nature: "remote";
  readonly etag?: string;
  readonly notModified: boolean;
  readonly contentType?: string;
}

export interface LocalFsContent {
  readonly data: Uint8Array;
  readonly source: string; // normalized absolute path
  readonly nature: "local-fs";
  readonly notModified: false;
}

export type ContentResult = RemoteContent | LocalFsContent;

export type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export type SourceOpts = {
  baseUrl?: URL;
  baseDir?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowedHosts?: readonly string[];
  fetchFn?: FetchLike;
  realPath?: boolean;
  etag?: string; // If-None-Match
};

export class ProvenanceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNSUPPORTED_SCHEME"
      | "HTTP_NOT_ALLOWED"
      | "FETCH_FAILED"
      | "TIMEOUT"
      | "TOO_LARGE"
      | "IO_ERROR",
  ) {
    super(message);
    this.name = "ProvenanceError";
  }
}

const isHttp = (u: URL) => u.protocol === "http:" || u.protocol === "https:";
const isFile = (u: URL) => u.protocol === "file:";

function parseCharset(ctype?: string): string {
  if (!ctype) return "utf-8";
  const m = /charset\s*=\s*([^;\s]+)/i.exec(ctype);
  return m ? m[1].trim().toLowerCase() : "utf-8";
}

function decodeText(buf: Uint8Array, ctype?: string): string {
  const dec = new TextDecoder(parseCharset(ctype), { fatal: false });
  return dec.decode(buf);
}

async function readRemote(url: URL, opts: SourceOpts): Promise<RemoteContent> {
  const {
    timeoutMs = 30_000,
    maxBytes = 10 * 1024 * 1024,
    allowedHosts,
    fetchFn,
    etag,
  } = opts;

  if (allowedHosts && allowedHosts.length && !allowedHosts.includes(url.host)) {
    throw new ProvenanceError(
      `Host not allowed: ${url.host}`,
      "HTTP_NOT_ALLOWED",
    );
  }

  const doFetch: FetchLike = fetchFn ?? ((u) => fetch(u));
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      signal: ctrl.signal,
      headers: etag ? { "If-None-Match": etag } : undefined,
    });

    if (res.status === 304) {
      return {
        data: new Uint8Array(0),
        source: url,
        nature: "remote",
        notModified: true,
        etag: res.headers.get("etag") ?? etag,
        contentType: res.headers.get("content-type") ?? undefined,
      };
    }

    if (!res.ok) {
      throw new ProvenanceError(
        `Failed to fetch ${url} (${res.status} ${res.statusText})`,
        "FETCH_FAILED",
      );
    }

    const reader = res.body?.getReader();
    const contentType = res.headers.get("content-type") ?? undefined;
    const resEtag = res.headers.get("etag") ?? undefined;

    if (!reader) {
      const data = new Uint8Array(0);
      return {
        data,
        source: url,
        nature: "remote",
        etag: resEtag,
        notModified: false,
        contentType,
      };
    }

    let received = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        // Cancel the stream to satisfy Deno's resource sanitizer.
        try {
          await reader.cancel("size limit exceeded");
        } catch { /* ignore */ }
        ctrl.abort();
        throw new ProvenanceError(
          `Response exceeds ${maxBytes} bytes`,
          "TOO_LARGE",
        );
      }
      chunks.push(value);
    }

    const data = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.byteLength;
    }

    return {
      data,
      source: url,
      nature: "remote",
      etag: resEtag,
      notModified: false,
      contentType,
    };
  } catch (e) {
    if (e instanceof ProvenanceError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ProvenanceError(`Timed out fetching ${url}`, "TIMEOUT");
    }
    throw new ProvenanceError(
      `Network error fetching ${url}: ${(e as Error).message}`,
      "FETCH_FAILED",
    );
  } finally {
    clearTimeout(tm);
  }
}

/* --------------------------- Implementation core --------------------------- */
async function sourceContentImpl(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo,
  opts: SourceOpts = {},
): Promise<ContentResult> {
  const baseUrl = opts.baseUrl ?? new URL(import.meta.url);

  if (srcRelTo === SourceRelativeTo.Module) {
    const url = provenance instanceof URL
      ? provenance
      : new URL(provenance, baseUrl);

    if (isFile(url)) {
      let path = fromFileUrl(url);
      path = normalize(path);
      if (opts.realPath) {
        try {
          path = await Deno.realPath(path);
        } catch { /* ignore */ }
      }
      try {
        const data = await Deno.readFile(path);
        return { data, source: path, nature: "local-fs", notModified: false };
      } catch (e) {
        throw new ProvenanceError(
          `FS read failed for ${path}: ${(e as Error).message}`,
          "IO_ERROR",
        );
      }
    }

    if (isHttp(url)) {
      return await readRemote(url, opts);
    }

    throw new ProvenanceError(
      `Unsupported URL scheme: ${url.protocol}`,
      "UNSUPPORTED_SCHEME",
    );
  }

  // Local filesystem mode
  if (provenance instanceof URL) {
    if (!isFile(provenance)) {
      throw new ProvenanceError(
        `Only file: URLs allowed in LocalFs mode (got ${provenance.protocol})`,
        "UNSUPPORTED_SCHEME",
      );
    }
    let p = fromFileUrl(provenance);
    p = normalize(p);
    if (opts.realPath) {
      try {
        p = await Deno.realPath(p);
      } catch { /* ignore */ }
    }
    try {
      const data = await Deno.readFile(p);
      return { data, source: p, nature: "local-fs", notModified: false };
    } catch (e) {
      throw new ProvenanceError(
        `FS read failed for ${p}: ${(e as Error).message}`,
        "IO_ERROR",
      );
    }
  }

  const baseDir = opts.baseDir ?? Deno.cwd();
  let path = isAbsolute(provenance) ? provenance : join(baseDir, provenance);
  path = normalize(path);
  if (opts.realPath) {
    try {
      path = await Deno.realPath(path);
    } catch { /* ignore */ }
  }
  try {
    const data = await Deno.readFile(path);
    return { data, source: path, nature: "local-fs", notModified: false };
  } catch (e) {
    throw new ProvenanceError(
      `FS read failed for ${path}: ${(e as Error).message}`,
      "IO_ERROR",
    );
  }
}

/* ----------------------------- Overloads (public) ----------------------------- */
export async function sourceContent(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo.LocalFs,
  opts?: SourceOpts,
): Promise<LocalFsContent>;
export async function sourceContent(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo.Module,
  opts?: SourceOpts,
): Promise<ContentResult>;

/** Implementation must be named 'sourceContent' and adjacent to overloads */
export async function sourceContent(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo,
  opts: SourceOpts = {},
): Promise<ContentResult> {
  // keep 'await' to satisfy require-await
  return await sourceContentImpl(provenance, srcRelTo, opts);
}

/** Charset-aware text helper. */
export async function sourceText(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo,
  opts: SourceOpts = {},
): Promise<
  | (LocalFsContent & { readonly text: string })
  | (RemoteContent & { readonly text: string })
> {
  const res = await sourceContentImpl(provenance, srcRelTo, opts);
  const ctype = res.nature === "remote" ? res.contentType : undefined;
  const text = decodeText(res.data, ctype);
  return { ...res, text } as
    | (LocalFsContent & { readonly text: string })
    | (RemoteContent & { readonly text: string });
}

/* ----------------------------- Safe wrappers ----------------------------- */
/** Error variant that never throws. */
export interface ContentError {
  readonly nature: "error";
  readonly error: ProvenanceError;
  /** If we could resolve a source before failing, include it */
  readonly source?: string | URL;
}

export type SafeContent = ContentResult | ContentError;

export async function safeSourceContent(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo,
  opts: SourceOpts = {},
): Promise<SafeContent> {
  try {
    return await sourceContentImpl(provenance, srcRelTo, opts);
  } catch (e) {
    const err = e instanceof ProvenanceError
      ? e
      : new ProvenanceError((e as Error).message, "IO_ERROR");
    // Try to provide a best-effort source
    let src: string | URL | undefined;
    try {
      const baseUrl = opts.baseUrl ?? new URL(import.meta.url);
      src = srcRelTo === SourceRelativeTo.Module
        ? (provenance instanceof URL
          ? provenance
          : new URL(provenance, baseUrl))
        : (provenance instanceof URL
          ? fromFileUrl(provenance)
          : (isAbsolute(provenance)
            ? provenance
            : normalize(join(opts.baseDir ?? Deno.cwd(), provenance))));
    } catch {
      // ignore
    }
    return { nature: "error", error: err, source: src };
  }
}

export type SafeText =
  | (LocalFsContent & { readonly text: string })
  | (RemoteContent & { readonly text: string })
  | ContentError;

export async function safeSourceText(
  provenance: string | URL,
  srcRelTo: SourceRelativeTo,
  opts: SourceOpts = {},
): Promise<SafeText> {
  try {
    const res = await sourceContentImpl(provenance, srcRelTo, opts);
    const ctype = res.nature === "remote" ? res.contentType : undefined;
    const text = decodeText(res.data, ctype);
    return { ...res, text } as
      | (LocalFsContent & { readonly text: string })
      | (RemoteContent & { readonly text: string });
  } catch (e) {
    const err = e instanceof ProvenanceError
      ? e
      : new ProvenanceError((e as Error).message, "IO_ERROR");
    // Best-effort resolved source
    let src: string | URL | undefined;
    try {
      const baseUrl = opts.baseUrl ?? new URL(import.meta.url);
      src = srcRelTo === SourceRelativeTo.Module
        ? (provenance instanceof URL
          ? provenance
          : new URL(provenance, baseUrl))
        : (provenance instanceof URL
          ? fromFileUrl(provenance)
          : (isAbsolute(provenance)
            ? provenance
            : normalize(join(opts.baseDir ?? Deno.cwd(), provenance))));
    } catch {
      // ignore
    }
    return { nature: "error", error: err, source: src };
  }
}
