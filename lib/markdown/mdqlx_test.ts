import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { mdqlSelector } from "./mdqlx.ts";
import { parseMDQL } from "./mdql.ts";
import { remark } from "npm:remark@^15";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import type { Root, RootContent } from "npm:@types/mdast@^4";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Load the main test fixture Markdown with frontmatter parsing enabled */
async function loadFixture(
  name = "mdqlx_test-fixture-01.md",
): Promise<Root> {
  const src = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
  // Ensure the parsed tree contains `yaml` nodes for frontmatter
  return remark().use(remarkFrontmatter, ["yaml", "toml"]).parse(src) as Root;
}

/** Helper to unwrap parseMDQL() safely */
function unwrapParse(query: string) {
  const result = parseMDQL(query);
  if (!result.ok) {
    throw new Error(
      `MDQL parse failed for: ${query}\n${
        JSON.stringify(result.error, null, 2)
      }`,
    );
  }
  return result.value;
}

Deno.test("MDQLX Qualityfolio Fixture", async (t) => {
  const root = await loadFixture();
  // deno-lint-ignore require-await
  const source = { mdast: async () => root };

  await t.step("frontmatter presence via attribute path", async () => {
    const ast = unwrapParse("[frontmatter.qualityfolio.schema]");
    const sel = mdqlSelector(ast);
    const results: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) results.push(m);
    assert(results.length >= 1);
  });

  await t.step("heading::section collects nested content", async () => {
    const ast = unwrapParse("heading::section");
    const sel = mdqlSelector(ast);
    const results: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) results.push(m);
    assert(results.length > 20);
  });

  await t.step("yaml code fences count is exact (4)", async () => {
    const ast = unwrapParse("code[lang='yaml']");
    const sel = mdqlSelector(ast);
    const found: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) found.push(m);
    assertEquals(found.length, 4);
  });

  await t.step("combined: json5 and yaml code fences (5 total)", async () => {
    const ast = unwrapParse("code[lang='json5'], code[lang='yaml']");
    const sel = mdqlSelector(ast);
    const found: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) found.push(m);
    assertEquals(found.length, 5);
  });

  await t.step("evidence JSON links by URL suffix", async () => {
    const ast = unwrapParse("link[url$='.json']");
    const sel = mdqlSelector(ast);
    const found: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) found.push(m);
    assert(found.length >= 8);
  });

  await t.step(
    "heading:contains('checkout') case-insensitive exact count (4)",
    async () => {
      const ast = unwrapParse("heading:contains('checkout')");
      const sel = mdqlSelector(ast);
      const matches: Array<{ node: RootContent }> = [];
      for await (const m of sel.select([source])) matches.push(m);
      assertEquals(matches.length, 4);
    },
  );
});

Deno.test("Inline Custom Fixtures for PI & ATTR behavior", async (t) => {
  const customMarkdown = `
# PI / ATTR Test Fixture

\`\`\`js flag key=value { "priority": 2, "env": "qa" }
console.log("PI/ATTR test 1");
\`\`\`

\`\`\`python x yz level=critical { "priority": 5, "env": "prod" }
print("PI/ATTR test 2")
\`\`\`

\`\`\`bash no-run meta { "priority": 3 }
echo "PI/ATTR test 3"
\`\`\`
`;

  const root = remark().parse(customMarkdown) as Root;
  // deno-lint-ignore require-await
  const source = { mdast: async () => root };

  await t.step("find code blocks with PI bare 'flag'", async () => {
    const ast = unwrapParse("code:pi(flag)");
    const sel = mdqlSelector(ast);
    const hits: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) hits.push(m);
    assertEquals(hits.length, 1);
    assertStringIncludes((hits[0].node as Any).value, "test 1");
  });

  await t.step(
    "find code with attr priority>=3 (should be 2: priority 5 and 3)",
    async () => {
      const ast = unwrapParse("code[attrs.priority>=3]");
      const sel = mdqlSelector(ast);
      const hits: Array<{ node: RootContent }> = [];
      for await (const m of sel.select([source])) hits.push(m);
      assertEquals(hits.length, 2);
    },
  );

  await t.step("select by short PI token 'x'", async () => {
    const ast = unwrapParse("code:pi(x)");
    const sel = mdqlSelector(ast);
    const hits: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) hits.push(m);
    assertEquals(hits.length, 1);
    assertStringIncludes((hits[0].node as Any).value, "test 2");
  });

  await t.step(
    "combined selector: code[attrs.env='prod']:pi(level)",
    async () => {
      const ast = unwrapParse("code[attrs.env='prod']:pi(level)");
      const sel = mdqlSelector(ast);
      const hits: Array<{ node: RootContent }> = [];
      for await (const m of sel.select([source])) hits.push(m);
      assertEquals(hits.length, 1);
      // We matched the python block with level=critical in PI; verify it's the "test 2" block.
      assertStringIncludes((hits[0].node as Any).value, "test 2");
    },
  );

  await t.step("universal selector catches all code (3)", async () => {
    const ast = unwrapParse("code");
    const sel = mdqlSelector(ast);
    const hits: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) hits.push(m);
    assertEquals(hits.length, 3);
  });
});

Deno.test("Complex synthetic fixture using JSON5/SQL/TXT + attrs", async (t) => {
  const markdown = `
# Mixed JSON5 + SQL + Plaintext

\`\`\`json5 flag tag=demo { "priority": 9, "owner": "qa" }
{ "a": 1, "b": 2 }
\`\`\`

\`\`\`sql env=prod { "priority": 1, "env": "prod" }
SELECT * FROM accounts;
\`\`\`

Regular paragraph between code fences.

\`\`\`txt noop { "notes": "hello world" }
plain
\`\`\`
`;
  const root = remark().parse(markdown) as Root;
  // deno-lint-ignore require-await
  const source = { mdast: async () => root };

  await t.step(
    "code:attrs('priority') matches only fences with that key (2)",
    async () => {
      const ast = unwrapParse("code:attrs('priority')");
      const sel = mdqlSelector(ast);
      const hits: Array<{ node: RootContent }> = [];
      for await (const m of sel.select([source])) hits.push(m);
      assertEquals(hits.length, 2);
    },
  );

  await t.step("select only JSON5 (1)", async () => {
    const ast = unwrapParse("code[lang='json5']");
    const sel = mdqlSelector(ast);
    const hits: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) hits.push(m);
    assertEquals(hits.length, 1);
    assertStringIncludes((hits[0].node as Any).value, '"a"');
  });

  await t.step("sql fences filtered by env=prod (1)", async () => {
    const ast = unwrapParse("code[attrs.env='prod']");
    const sel = mdqlSelector(ast);
    const hits: Array<{ node: RootContent }> = [];
    for await (const m of sel.select([source])) hits.push(m);
    assertEquals(hits.length, 1);
    assertStringIncludes((hits[0].node as Any).value, "accounts");
  });
});
