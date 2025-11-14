// lib/markdown/code-partial_test.ts
// deno-lint-ignore-file no-explicit-any

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { remark } from "npm:remark@^15";
import remarkGfm from "npm:remark-gfm@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";

import enrichedCode from "./enriched-code.ts";
import codePartials, {
  CODE_PARTIAL_STORE_KEY,
  codePartial,
  type CodePartialNode,
  codePartialsCollection,
  isCodePartial,
} from "./code-partial.ts";

import type { Root } from "npm:@types/mdast@^4";

// Helper: normalize sync-or-async renderer to a Promise result
async function render(
  p: ReturnType<typeof codePartial>,
  locals: Record<string, unknown> = {},
) {
  return await Promise.resolve(p.content(locals));
}

function pipeline() {
  return remark()
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(enrichedCode)
    .use(codePartials);
}

function codeNodes(tree: Root): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.type === "code") out.push(n);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

Deno.test("codePartials plugin with synthetic PARTIAL cells", async (t) => {
  await t.step("detects a plain PARTIAL without injection", () => {
    const md = [
      "```ts PARTIAL plain",
      "console.log('hello');",
      "```",
      "",
    ].join("\n");

    const processor = pipeline();
    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    const nodes = codeNodes(tree);
    assertEquals(nodes.length, 1);

    const node = nodes[0] as CodePartialNode;
    assert(isCodePartial(node));

    const cp = node.data[CODE_PARTIAL_STORE_KEY];
    assertEquals(cp.identity, "plain");
    assertEquals(cp.injection, undefined);
    assertEquals(cp.source, "console.log('hello');");
  });

  await t.step("detects PARTIAL with injection flags and globs", () => {
    const md = [
      "```ts PARTIAL header --inject **/*.sql",
      "console.log('H');",
      "```",
      "",
    ].join("\n");

    const processor = pipeline();
    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    const node = codeNodes(tree)[0] as CodePartialNode;
    assert(isCodePartial(node));

    const cp = node.data[CODE_PARTIAL_STORE_KEY];
    assertEquals(cp.identity, "header");
    assert(cp.injection);
    assertEquals(cp.injection?.globs, ["**/*.sql"]);
    assertEquals(cp.injection?.mode, "prepend"); // default when only --inject
  });

  await t.step("PARTIAL with append/prepend flags sets mode correctly", () => {
    const mdAppend = [
      "```ts PARTIAL footer --inject **/*.sql --append",
      "FOOTER",
      "```",
      "",
    ].join("\n");

    const mdBoth = [
      "```ts PARTIAL wrap --inject **/*.sql --prepend --append",
      "WRAP",
      "```",
      "",
    ].join("\n");

    const p = pipeline();

    const treeAppend = p.parse(mdAppend) as Root;
    p.runSync(treeAppend);
    const nodeAppend = codeNodes(treeAppend)[0] as CodePartialNode;
    const cpAppend = nodeAppend.data[CODE_PARTIAL_STORE_KEY];
    assertEquals(cpAppend.injection?.mode, "append");

    const treeBoth = p.parse(mdBoth) as Root;
    p.runSync(treeBoth);
    const nodeBoth = codeNodes(treeBoth)[0] as CodePartialNode;
    const cpBoth = nodeBoth.data[CODE_PARTIAL_STORE_KEY];
    assertEquals(cpBoth.injection?.mode, "both");
  });

  await t.step(
    "attrs used as Zod schema spec for locals validation",
    async () => {
      const md = [
        "```ts PARTIAL greet { name: { type: 'string' } }",
        "// body is irrelevant for validation",
        "```",
        "",
      ].join("\n");

      const processor = pipeline();
      const tree = processor.parse(md) as Root;
      processor.runSync(tree);

      const node = codeNodes(tree)[0] as CodePartialNode;
      const cp = node.data[CODE_PARTIAL_STORE_KEY];

      // Valid locals
      const ok = await cp.content({ name: "Alice" });
      assertEquals(ok.interpolate, true);
      assertEquals(ok.content, "// body is irrelevant for validation");

      // Invalid locals
      const bad = await cp.content({ name: 123 });
      assertEquals(bad.interpolate, false);
      assertStringIncludes(bad.content, "Invalid arguments");
    },
  );

  await t.step("collect callback receives each PARTIAL node", () => {
    const md = [
      "```ts PARTIAL first",
      "A",
      "```",
      "",
      "```ts PARTIAL second",
      "B",
      "```",
      "",
    ].join("\n");

    const collected: CodePartialNode[] = [];

    const processor = remark()
      .use(remarkGfm)
      .use(remarkFrontmatter, ["yaml"])
      .use(enrichedCode)
      .use(codePartials, {
        collect(node) {
          collected.push(node);
        },
      });

    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    assertEquals(collected.length, 2);
    const ids = collected.map((n) => n.data[CODE_PARTIAL_STORE_KEY].identity);
    assertEquals(ids.sort(), ["first", "second"]);
  });
});

Deno.test("codePartial() basic and injectable behaviors (direct)", async (t) => {
  await t.step("creates a plain partial without injection", async () => {
    const p = codePartial("plain", {}, "hello world");
    assertEquals(p.identity, "plain");
    assertEquals(p.injection, undefined);
    const r = await render(p, {});
    assertEquals(r.content, "hello world");
    assertEquals(r.interpolate, true);
  });

  await t.step(
    "creates an injectable with inject globs and default prepend",
    () => {
      const p = codePartial(
        "header",
        { inject: "**/*.sql" },
        "-- HEADER",
      );
      assertEquals(p.injection?.mode, "prepend");
      assertEquals(p.injection?.globs, ["**/*.sql"]);
    },
  );

  await t.step("creates an injectable with append mode", () => {
    const p = codePartial(
      "footer",
      { inject: "**/*.sql", append: true },
      "-- FOOTER",
    );
    assertEquals(p.injection?.mode, "append");
  });

  await t.step("creates an injectable with both prepend+append", () => {
    const p = codePartial(
      "wrap",
      { inject: "**/*.sql", prepend: true, append: true },
      "-- BEGIN\n-- END",
    );
    assertEquals(p.injection?.mode, "both");
  });

  await t.step("validates arguments when zodSchemaSpec provided", async () => {
    const p = codePartial(
      "withArgs",
      {},
      "Hi",
      {
        name: { type: "string" },
      },
    );
    const r = await render(p, { name: "Bob" });
    assertEquals(r.content, "Hi");
  });

  await t.step("returns error content for invalid locals", async () => {
    const p = codePartial(
      "withArgs",
      {},
      "Hi",
      {
        name: { type: "string" },
      },
    );
    const r = await render(p, { name: 123 });
    assertStringIncludes(r.content, "Invalid arguments");
    assertEquals(r.interpolate, false);
  });
});

Deno.test("codePartialsCollection() core behaviors", async (t) => {
  const col = codePartialsCollection();

  await t.step("registers and retrieves plain partials", async () => {
    const p = codePartial("plain", {}, "content");
    col.register(p);
    const got = col.get("plain");
    assert(got);
    const r = await render(got, {});
    assertEquals(r.content, "content");
  });

  await t.step("handles duplicates according to policy", async () => {
    const p1 = codePartial("dupe", {}, "a");
    const p2 = codePartial("dupe", {}, "b");

    // overwrite
    col.register(p1);
    col.register(p2, () => "overwrite");
    {
      const r = await render(col.get("dupe")!, {});
      assertEquals(r.content, "b");
    }

    // ignore
    col.register(p1);
    col.register(p2, () => "ignore");
    {
      const r = await render(col.get("dupe")!, {});
      assertEquals(r.content, "a");
    }

    // throw (sync) -> assertThrows
    assertThrows(() => {
      col.register(p2, () => "throw");
    });
  });

  await t.step("indexes injectables for glob matching", () => {
    const inj1 = codePartial(
      "header",
      { inject: "**/*.sql" },
      "-- H",
    );
    const inj2 = codePartial(
      "footer",
      { inject: "reports/*.sql", append: true },
      "-- F",
    );
    col.register(inj1);
    col.register(inj2);

    const found1 = col.findInjectableForPath("x/foo.sql");
    const found2 = col.findInjectableForPath("reports/summary.sql");

    assert(found1?.identity === "header");
    assert(found2?.identity === "footer");
  });

  await t.step("compose() applies prepend mode correctly", async () => {
    const localCol = codePartialsCollection();
    const inj = codePartial(
      "wrapTxt",
      { inject: "**/*.txt" },
      "HEADER",
    );
    localCol.register(inj);

    const result = await localCol.compose({
      content: "body",
      interpolate: true,
      locals: {},
    }, { path: "test.txt" });

    assertEquals(result.content, "HEADER\nbody");
  });

  await t.step("compose() applies both prepend+append correctly", async () => {
    const localCol = codePartialsCollection(); // fresh
    const inj = codePartial(
      "wrap2",
      { inject: "**/*.sql", prepend: true, append: true },
      "WRAP",
    );
    localCol.register(inj);

    const result = await localCol.compose({
      content: "core",
      interpolate: true,
      locals: {},
    }, { path: "anything.sql" });

    assertEquals(result.content, "WRAP\ncore\nWRAP");
  });

  await t.step(
    "compose() returns error text if wrapper fails args validation",
    async () => {
      const localCol = codePartialsCollection(); // fresh

      const bad = codePartial(
        "bad",
        { inject: "**/*.oops" },
        "BAD",
        { name: { type: "string" } }, // schema expects string
      );
      localCol.register(bad);

      const res = await localCol.compose({
        content: "BODY",
        interpolate: true,
        locals: { name: 123 }, // mismatch
      }, { path: "file.oops" });

      assertStringIncludes(res.content, "failed to render");
      assertEquals(res.interpolate, false);
    },
  );

  await t.step("compose() skips if no matching injectable", async () => {
    const result = await col.compose({
      content: "x",
      interpolate: true,
      locals: {},
    }, { path: "no/match.json" });

    assertEquals(result.content, "x");
  });

  await t.step(
    "compose() catches thrown wrapper errors gracefully",
    async () => {
      const localCol = codePartialsCollection();

      const throwingPartial = codePartial(
        "thrower",
        { inject: "**/*.boom" },
        "ignored",
      );

      // Replace content with a throwing function
      const newContent: typeof throwingPartial.content = () => {
        throw new Error("Kaboom");
      };
      (throwingPartial as { content: typeof newContent }).content = newContent;

      localCol.register(throwingPartial);

      const res = await localCol.compose({
        content: "main",
        interpolate: true,
        locals: {},
      }, { path: "file.boom" });

      assertStringIncludes(res.content, "failed to render");
      assertEquals(res.interpolate, false);
    },
  );
});

Deno.test(
  "codePartialsCollection() selects most specific injectable by glob",
  async (t) => {
    const col = codePartialsCollection();

    await t.step(
      "prefers fewer wildcards and longer literals when composing",
      async () => {
        const generic = codePartial(
          "generic",
          { inject: "**/*.sql" },
          "GENERIC",
        );
        const specific = codePartial(
          "specific",
          { inject: "reports/*.sql" },
          "SPECIFIC",
        );
        col.register(generic);
        col.register(specific);

        const r = await col.compose({
          content: "BODY",
          interpolate: true,
          locals: {},
        }, { path: "reports/summary.sql" });

        // Should pick specific, not generic
        assertStringIncludes(r.content, "SPECIFIC");
        assert(!r.content.includes("GENERIC"));
      },
    );
  },
);
