// lib/markdown/mdastql_test.ts

import { assertEquals } from "jsr:@std/assert@^1";

import type {
  Code,
  Heading,
  Root,
  RootContent,
  Text,
} from "npm:@types/mdast@^4";

import { remark } from "npm:remark@^15";
import remarkGfm from "npm:remark-gfm@^4";

import {
  mdastql,
  type MdastQlAttributeFilter,
  type MdastQlCompiledSelector,
  type MdastQlRewriteFn,
  parseMdastQl,
} from "./mdastql.ts";

/**
 * Helpers
 */

async function parseMarkdown(markdown: string): Promise<Root> {
  const processor = remark().use(remarkGfm);
  const tree = processor.parse(markdown) as Root;
  await processor.run(tree);
  return tree;
}

function walk(root: Root, fn: (node: RootContent) => void) {
  const queue: RootContent[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift()!;
    fn(node);
    const any = node as RootContent & { children?: RootContent[] };
    if (Array.isArray(any.children)) {
      for (const child of any.children) queue.push(child);
    }
  }
}

function asTextValue(node: RootContent): string {
  const h = node as Heading;
  const first = h.children?.[0] as Text | undefined;
  return first?.value ?? "";
}

/**
 * 1) Basic structural queries using real Markdown fixtures.
 */
Deno.test("mdastql: basic structural queries from Markdown", async (t) => {
  const markdown = [
    "# Title",
    "",
    "Intro paragraph",
    "",
    "## Section A",
    "",
    "```sql",
    "SELECT * FROM a;",
    "```",
    "",
    "```js",
    'console.log("A");',
    "```",
    "",
    "### Sub A.1",
    "",
    "```sql",
    "SELECT * FROM a1;",
    "```",
    "",
    "## Section B",
    "",
    "```sql",
    "SELECT * FROM b;",
    "```",
    "",
  ].join("\n");

  const root = await parseMarkdown(markdown);

  await t.step("selects all h2 headings via alias", () => {
    const { nodes } = mdastql(root, "h2");
    assertEquals(nodes.length, 2);

    const labels = nodes.map(asTextValue);
    assertEquals(labels, ["Section A", "Section B"]);
  });

  await t.step(
    "descendant semantics: h2 code finds ALL code under each h2 section",
    () => {
      const { nodes } = mdastql(root, "h2 code");
      // Under Section A: two code blocks (sql, js) + one more under Sub A.1
      // Under Section B: one code block
      assertEquals(nodes.length, 4);
      const langs = nodes.map((n) => (n as Code).lang ?? null);
      assertEquals(langs, ["sql", "js", "sql", "sql"]);
    },
  );

  await t.step(
    "child semantics: h2 > code finds only top-level section children",
    () => {
      const { nodes } = mdastql(root, "h2 > code");
      // For Section A: the two code blocks directly after h2, before the h3
      // For Section B: the code block directly under that h2
      assertEquals(nodes.length, 3);

      const values = nodes.map((n) => (n as Code).value.trim());
      assertEquals(values, [
        "SELECT * FROM a;",
        'console.log("A");',
        "SELECT * FROM b;",
      ]);
    },
  );

  await t.step(
    "adjacent sibling: h3 + code picks first code after any h3",
    () => {
      const { nodes } = mdastql(root, "h3 + code");
      assertEquals(nodes.length, 1);
      const first = nodes[0] as Code;
      assertEquals(first.value.trim(), "SELECT * FROM a1;");
    },
  );
});

/**
 * 2) Data attribute filters over real Markdown code fences.
 *    We attach data.* in-place after parsing.
 */
Deno.test("mdastql: data attribute filters on parsed Markdown", async (t) => {
  const markdown = [
    "```sql",
    "SELECT * FROM main;",
    "```",
    "",
    "```sql",
    "SELECT * FROM important;",
    "```",
    "",
    "```js",
    'console.log("ignore");',
    "```",
    "",
  ].join("\n");

  const root = await parseMarkdown(markdown);

  // Attach data.tag and nested data.meta.owner to the second SQL code block.
  let codeIndex = 0;
  walk(root, (node) => {
    if (node.type === "code" && (node as Code).lang === "sql") {
      if (codeIndex === 1) {
        const c = node as Code;
        c.data = {
          ...(c.data ?? {}),
          tag: "important",
          meta: { owner: "alice" },
        };
      }
      codeIndex++;
    }
  });

  await t.step("filters by lang=sql", () => {
    const { nodes } = mdastql(root, "code[lang=sql]");
    assertEquals(nodes.length, 2);
    const values = nodes.map((n) => (n as Code).value.trim());
    assertEquals(values, ["SELECT * FROM main;", "SELECT * FROM important;"]);
  });

  await t.step("filters by data.tag='important'", () => {
    const { nodes } = mdastql(root, "code[data.tag=important]");
    assertEquals(nodes.length, 1);
    const only = nodes[0] as Code;
    assertEquals(only.value.trim(), "SELECT * FROM important;");
  });

  await t.step("filters by nested data.meta.owner='alice'", () => {
    const { nodes } = mdastql(root, "code[data.meta.owner=alice]");
    assertEquals(nodes.length, 1);
    const only = nodes[0] as Code;
    assertEquals(only.value.trim(), "SELECT * FROM important;");
  });
});

/**
 * 3) Custom alias rewriters (testcase/suite) using real Markdown.
 *
 * We attach data.frontmatter.kind to headings and data.ec.attrs.CELL to codes.
 */
Deno.test("mdastql: custom alias rewriters with Markdown + data", async (t) => {
  const markdown = [
    "## Suite A",
    "",
    "```ts",
    "// setup",
    "```",
    "",
    "```ts",
    "// test A1",
    "```",
    "",
    "## Suite B",
    "",
    "```ts",
    "// test B1",
    "```",
    "",
    "```ts",
    "// other",
    "```",
    "",
  ].join("\n");

  const root = await parseMarkdown(markdown);

  // Attach frontmatter-like data to headings and ec.attrs.CELL to codes.
  let currentSuite: "suite-a" | "suite-b" | null = null;
  let suiteIndex = 0;
  walk(root, (node) => {
    if (node.type === "heading") {
      const h = node as Heading;
      const label = asTextValue(h);
      if (label === "Suite A") {
        currentSuite = "suite-a";
      } else if (label === "Suite B") {
        currentSuite = "suite-b";
      } else {
        currentSuite = null;
      }
      h.data = {
        ...(h.data ?? {}),
        frontmatter: {
          kind: "suite",
          id: currentSuite ?? `suite-${suiteIndex}`,
        },
      };
      suiteIndex++;
    } else if (node.type === "code" && (node as Code).lang === "ts") {
      const c = node as Code;
      const trimmed = c.value.trim();
      let cell: string | undefined;
      if (trimmed === "// setup") cell = "SETUP";
      else if (trimmed === "// test A1") cell = "TEST";
      else if (trimmed === "// test B1") cell = "TEST";
      else cell = "OTHER";

      c.data = {
        ...(c.data ?? {}),
        ec: {
          attrs: {
            CELL: cell,
          },
        },
      };
    }
  });

  // Alias: "testcase" => code[data.ec.attrs.CELL="TEST"]
  const testcaseAlias: MdastQlRewriteFn = (
    compiled: MdastQlCompiledSelector,
  ): MdastQlCompiledSelector => {
    const rewrittenSelectors = compiled.selectors.map((sel) => {
      if (!sel.type || sel.type !== "testcase") return sel;

      const cellFilter: MdastQlAttributeFilter = {
        kind: "attribute",
        path: ["data", "ec", "attrs", "CELL"],
        op: "eq",
        value: "TEST",
      };

      return {
        ...sel,
        type: "code",
        attrs: [cellFilter, ...sel.attrs],
      };
    });

    return {
      selectors: rewrittenSelectors,
      combinators: compiled.combinators,
    };
  };

  // Alias: "suite" => heading[data.frontmatter.kind="suite"]
  const suiteAlias: MdastQlRewriteFn = (
    compiled: MdastQlCompiledSelector,
  ): MdastQlCompiledSelector => {
    const rewrittenSelectors = compiled.selectors.map((sel) => {
      if (!sel.type || sel.type !== "suite") return sel;

      const kindFilter: MdastQlAttributeFilter = {
        kind: "attribute",
        path: ["data", "frontmatter", "kind"],
        op: "eq",
        value: "suite",
      };

      return {
        ...sel,
        type: "heading",
        attrs: [kindFilter, ...sel.attrs],
      };
    });

    return {
      selectors: rewrittenSelectors,
      combinators: compiled.combinators,
    };
  };

  // Compose aliases: apply suiteAlias, then testcaseAlias
  const composedRewrite: MdastQlRewriteFn = (compiled) =>
    testcaseAlias(suiteAlias(compiled));

  await t.step("testcase alias selects only TEST cells", () => {
    const { nodes } = mdastql(root, "testcase", {
      rewrite: composedRewrite,
    });

    // We expect two TEST cells: "// test A1" and "// test B1"
    assertEquals(nodes.length, 2);
    const values = nodes.map((n) => (n as Code).value.trim());
    assertEquals(values, ["// test A1", "// test B1"]);
  });

  await t.step("suite alias selects all suite headings", () => {
    const { nodes } = mdastql(root, "suite", {
      rewrite: composedRewrite,
    });

    assertEquals(nodes.length, 2);
    const labels = nodes.map(asTextValue);
    assertEquals(labels, ["Suite A", "Suite B"]);
  });

  await t.step(
    "suite testcase selects TEST cells under each suite section",
    () => {
      // "suite testcase" means: descendant from suite headings → testcase selector
      const { nodes } = mdastql(root, "suite testcase", {
        rewrite: composedRewrite,
      });

      assertEquals(nodes.length, 2);
      const values = nodes.map((n) => (n as Code).value.trim());
      assertEquals(values, ["// test A1", "// test B1"]);
    },
  );
});

/**
 * 4) Direct tests of parseMdastQl() + rewrite to ensure AST-level behavior.
 */
Deno.test("mdastql: parse and rewrite behavior", async (t) => {
  await t.step("parseMdastQl retains aliases as raw types", () => {
    const compiled = parseMdastQl("h2[data.foo=bar] code");
    assertEquals(compiled.selectors.length, 2);
    assertEquals(compiled.combinators.length, 1);

    const [s0, s1] = compiled.selectors;
    assertEquals(s0.type, "h2");
    assertEquals(s1.type, "code");
  });

  await t.step(
    "user rewriter can normalize custom types without touching others",
    () => {
      const compiled = parseMdastQl("custom > code");

      const rewrite: MdastQlRewriteFn = (ast) => ({
        selectors: ast.selectors.map((sel) =>
          sel.type === "custom" ? { ...sel, type: "paragraph" } : sel
        ),
        combinators: ast.combinators,
      });

      const rewritten = rewrite(compiled);
      assertEquals(rewritten.selectors[0]?.type, "paragraph");
      assertEquals(rewritten.selectors[1]?.type, "code");
      assertEquals(rewritten.combinators[0], "child");
    },
  );
});
