import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
} from "jsr:@std/assert@^1";
import { safeSourceText, SourceRelativeTo } from "./content-acquisition.ts";
import {
  type Cell,
  type CodeCell,
  type MarkdownCell,
  type Notebook,
  notebooks,
} from "./md-notebook.ts";

// Generic, attrs-preserving type guards
function isCode<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is CodeCell<string, T> {
  return c.kind === "code";
}

function isMarkdown<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is MarkdownCell<string> {
  return c.kind === "markdown";
}

async function loadFixture(): Promise<string> {
  const safeText = await safeSourceText(
    new URL("./md-notebook_test-fixture-01.md", import.meta.url),
    SourceRelativeTo.Module,
  );
  if (safeText.nature === "error") {
    console.error(safeText.error);
  }
  assert(safeText.nature != "error");
  return safeText.text;
}

Deno.test("Markdown Notebook core - complex fixture", async (t) => {
  // Load the complex fixture
  const md = await loadFixture();

  // Parse with the core — pass a single string (valid Source)
  const out: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    out.push(nb);
  }

  assertEquals(out.length, 1, "expected exactly one notebook");
  const nb = out[0];

  await t.step("frontmatter parsed", () => {
    const fm = nb.fm as Record<string, unknown>;
    assertEquals(fm.title, "Core Fixture 01 (Complex)");
    assertEquals(fm.tags, ["demo", "test", "complex"]);
    assertEquals((fm.presets as Record<string, unknown>)?.["sqlDefault"], {
      schema: "main",
      dryRun: false,
    });
  });

  await t.step("cell partitioning and kinds sequence", () => {
    const kinds = nb.cells.map((c) => c.kind);
    assertEquals(kinds, [
      "markdown",
      "markdown",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "code",
      "markdown",
    ]);
  });

  await t.step("sql code cell - language, info, attrs, and content", () => {
    const cell = nb.cells[3];
    assert(isCode(cell as Cell<string, Record<string, unknown>>));
    if (isCode(cell)) {
      assertEquals(cell.language, "sql");
      assertEquals(cell.info, "INFO MORE_INFO");
      assertEquals(cell.attrs, { id: 1, name: "patients", dryRun: true });
      assertMatch(cell.source, /SELECT\s+id/i);
      assert(
        typeof cell.startLine === "number" && typeof cell.endLine === "number",
      );
    }
  });

  await t.step("markdown after sql - narrative preserved", () => {
    const cell = nb.cells[4];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /After the SQL code fence/);
    assert(
      typeof cell.startLine === "number" && typeof cell.endLine === "number",
    );
  });

  await t.step(
    "bash code cell - malformed JSON5 yields empty attrs and warning issue",
    () => {
      const cell = nb.cells[5];
      assert(isCode(cell));
      assertEquals(cell.language, "bash");
      assertEquals(cell.attrs, {}, "malformed meta should yield empty attrs");
      assertMatch(cell.source, /echo "Hello from a bash cell/);
      const warnings = nb.issues.filter((i) => i.kind === "fence-issue");
      assertGreater(warnings.length, 0, "expected at least one warning issue");
    },
  );

  await t.step("json code cell - language and payload", () => {
    const cell = nb.cells[7];
    assert(isCode(cell));
    assertEquals(cell.language, "json");
    assertMatch(cell.source, /"sku":\s*"ABC-123"/);
  });

  await t.step("xml code cell - language and structure", () => {
    const cell = nb.cells[9];
    assert(isCode(cell));
    assertEquals(cell.language, "xml");
    assertMatch(cell.source, /<inventory>/);
    assertMatch(cell.source, /<item id="2"/);
  });

  await t.step("csv code cell - language and header line", () => {
    const cell = nb.cells[11];
    assert(isCode(cell));
    assertEquals(cell.language, "csv");
    assertMatch(cell.source, /^id,name,qty/m);
  });

  await t.step("fish code cell - info meta and content", () => {
    const cell = nb.cells[13];
    assert(isCode(cell));
    assertEquals(cell.language, "fish");
    assertEquals(cell.info, "meta");
    assertMatch(cell.source, /echo "hello from fish"/);
  });

  await t.step("raw text code cell - treated as language 'text'", () => {
    const cell = nb.cells[14];
    assert(isCode(cell));
    assertEquals(cell.language, "text");
    assertMatch(cell.source, /raw code block without an explicit language/);
  });

  await t.step("final markdown cell - trailing paragraph after HR", () => {
    const cell = nb.cells[15];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /trailing paragraph/);
  });
});
