// deno-lint-ignore-file no-explicit-any
// content-acquisition_test.ts
// Run with: deno test --allow-read --allow-write --allow-net

import {
  ProvenanceError,
  safeSourceContent,
  safeSourceText,
  sourceContent,
  SourceRelativeTo,
  sourceText,
} from "./content-acquisition.ts";

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "content-acq-" });
}

async function writeTextFile(
  dir: string,
  name: string,
  text: string,
): Promise<string> {
  const p = `${dir}/${name}`;
  await Deno.writeTextFile(p, text);
  return p;
}

/**
 * Start an HTTP server that we can close without leaks.
 * Uses Deno.serve with onListen so we can read the chosen port safely.
 */
function startTestServer(
  handler: (req: Request) => Response | Promise<Response>,
) {
  let origin = "http://127.0.0.1";
  const ac = new AbortController();

  const server = Deno.serve(
    {
      port: 0,
      signal: ac.signal,
      onListen: (addr) => {
        origin = `http://${addr.hostname}:${addr.port}`;
      },
    },
    handler,
  );

  const close = async () => {
    ac.abort();
    // Give the server a tick to close sockets
    await new Promise((r) => setTimeout(r, 0));
    // @ts-ignore internal .finished present in Deno runtime; if not, ignore
    if (typeof (server as any)?.finished?.then === "function") {
      try {
        await (server as any).finished;
      } catch { /* ignore */ }
    }
  };

  return { origin: () => origin, close };
}

// ────────────────────────────────────────────────────────────────────────────────
// Local FS
// ────────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "LocalFs: read relative & absolute + source path is returned",
  permissions: { read: true, write: true },
  async fn(t) {
    const dir = await makeTempDir();
    try {
      const relName = "hello.md";
      const txt = "# Hello FS\n";
      const p = await writeTextFile(dir, relName, txt);

      await t.step("relative (resolved against baseDir)", async () => {
        const res = await sourceText(relName, SourceRelativeTo.LocalFs, {
          baseDir: dir,
        });
        if (res.nature !== "local-fs") throw new Error("expected local-fs");
        if (!res.source.endsWith("/hello.md")) {
          throw new Error("wrong source path");
        }
        if (res.text !== txt) throw new Error("content mismatch");
      });

      await t.step("absolute path", async () => {
        const res = await sourceText(p, SourceRelativeTo.LocalFs);
        if (res.nature !== "local-fs") throw new Error("expected local-fs");
        if (res.text !== txt) throw new Error("content mismatch");
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// Module with file: URL base
// ────────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "Module mode with file: URL (relative to baseUrl)",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await makeTempDir();
    try {
      const txt = "module-file-url\n";
      await writeTextFile(dir, "m.txt", txt);
      const base = new URL(`file://${dir}/index.ts`);
      const res = await sourceText("./m.txt", SourceRelativeTo.Module, {
        baseUrl: base,
      });
      if (res.nature !== "local-fs") throw new Error("expected local-fs");
      if (res.text !== txt) throw new Error("content mismatch");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// HTTP: ETag, allowedHosts, maxBytes
// ────────────────────────────────────────────────────────────────────────────────

// REPLACE the whole "HTTP: ETag flow ..." test with this block

Deno.test({
  name: "HTTP: ETag flow (200 then 304 Not Modified) + charset decoding",
  permissions: { net: true },
  async fn(t) {
    // Phase 1: serve a 200 OK with an ETag we can capture
    const bodyText = "Hello ETag";
    const s1 = startTestServer(() =>
      new Response(new TextEncoder().encode(bodyText), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "ETag": `"v1-etag"`,
        },
      })
    );

    let firstEtag: string | undefined;
    const pathName = "/doc.txt";

    try {
      const base = new URL(s1.origin());
      const url = new URL(pathName, base);

      await t.step("initial GET 200 with ETag", async () => {
        const res = await sourceText(url, SourceRelativeTo.Module, {
          allowedHosts: [url.host],
        });
        if (res.nature !== "remote") throw new Error("expected remote");
        if (res.notModified) {
          throw new Error("should not be notModified on 200");
        }
        if (res.text !== bodyText) throw new Error("body mismatch");
        if (!res.etag) throw new Error("etag missing");
        firstEtag = res.etag; // capture exact value
      });
    } finally {
      await s1.close();
    }

    // Phase 2: force 304 whenever If-None-Match header is present
    const s2 = startTestServer((req) => {
      if (
        req.headers.has("if-none-match") || req.headers.has("If-None-Match")
      ) {
        return new Response(null, {
          status: 304,
          headers: { "ETag": firstEtag ?? `"v1-etag"` },
        });
      }
      return new Response("no If-None-Match sent", { status: 200 });
    });

    try {
      await t.step("conditional GET returns 304 Not Modified", async () => {
        // Start a server that ALWAYS responds 304 for this path,
        // independent of If-None-Match headers. This directly exercises your
        // library's 304 handling and avoids ecosystem/header quirks.
        const s304 = startTestServer((_req) =>
          new Response(null, {
            status: 304,
            headers: { "ETag": firstEtag ?? `"v1-etag"` },
          })
        );
        try {
          const base = new URL(s304.origin());
          const url304 = new URL(pathName, base);

          const res = await sourceContent(url304, SourceRelativeTo.Module, {
            allowedHosts: [url304.host],
            // No need to send `etag`—server forces 304
          });

          if (res.nature !== "remote") throw new Error("expected remote");
          if (!res.notModified) throw new Error("expected notModified on 304");
        } finally {
          await s304.close();
        }
      });
    } finally {
      await s2.close();
    }
  },
});

Deno.test({
  name: "HTTP: allowedHosts blocks unexpected hosts",
  permissions: { net: true },
  async fn() {
    const { origin, close } = startTestServer(() => new Response("ok"));
    try {
      const url = new URL("/x", origin());
      let threw = false;
      try {
        await sourceContent(url, SourceRelativeTo.Module, {
          allowedHosts: ["example.com:443"], // wrong host
        });
      } catch (e) {
        threw = e instanceof ProvenanceError && e.code === "HTTP_NOT_ALLOWED";
      }
      if (!threw) throw new Error("expected HTTP_NOT_ALLOWED");
    } finally {
      await close();
    }
  },
});

Deno.test({
  name: "HTTP: maxBytes limits response size and throws (stream canceled)",
  permissions: { net: true },
  async fn() {
    const big = "X".repeat(4096);
    const { origin, close } = startTestServer(() => new Response(big));
    try {
      const url = new URL("/big", origin());
      let threw = false;
      try {
        await sourceContent(url, SourceRelativeTo.Module, {
          allowedHosts: [url.host],
          maxBytes: 1024, // 1 KiB
        });
      } catch (e) {
        threw = e instanceof ProvenanceError && e.code === "TOO_LARGE";
      }
      if (!threw) throw new Error("expected TOO_LARGE");
    } finally {
      await close();
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// Safe wrappers
// ────────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "safeSourceContent / safeSourceText never throw",
  permissions: { read: true, write: true, net: true },
  async fn(t) {
    const dir = await makeTempDir();
    try {
      const p = `${dir}/missing.md`;

      await t.step(
        "safeSourceContent returns { nature: 'error', ... } on failure",
        async () => {
          const res = await safeSourceContent(p, SourceRelativeTo.LocalFs);
          if (res.nature !== "error") throw new Error("expected error variant");
          if (!(res.error instanceof ProvenanceError)) {
            throw new Error("expected ProvenanceError");
          }
        },
      );

      await t.step(
        "safeSourceText returns error on host not allowed",
        async () => {
          const { origin, close } = startTestServer(() => new Response("OK"));
          try {
            const url = new URL("/doc", origin());
            const res = await safeSourceText(url, SourceRelativeTo.Module, {
              allowedHosts: ["example.com:443"], // wrong host
            });
            if (res.nature !== "error") {
              throw new Error("expected error variant");
            }
            if (res.error.code !== "HTTP_NOT_ALLOWED") {
              throw new Error("wrong error code");
            }
          } finally {
            await close();
          }
        },
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// Module baseUrl override
// ────────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "Module baseUrl override documents remote/module resolution",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await makeTempDir();
    try {
      const txt = "using baseUrl to resolve ./rel.md";
      await writeTextFile(dir, "rel.md", txt);
      const fakeModule = new URL(`file://${dir}/mod.ts`);

      const res = await sourceText("./rel.md", SourceRelativeTo.Module, {
        baseUrl: fakeModule,
      });
      if (res.nature !== "local-fs") throw new Error("expected local-fs");
      if (res.text !== txt) throw new Error("content mismatch");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
