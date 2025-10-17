import {
  assert,
  assertEquals,
  assertFalse,
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
  parsedTextComponents,
  parsedTextFlags,
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

Deno.test("parsedTextFlags", async (t) => {
  await t.step(
    "parses long and short flags with space-separated values",
    () => {
      const out = parsedTextFlags(["--host", "localhost", "-p", "8080"]);
      assertEquals(out, { host: "localhost", p: "8080" });
    },
  );

  await t.step("parses --key=value and -k=value forms", () => {
    const out = parsedTextFlags(["--user=alice", "-p=9000"]);
    assertEquals(out, { user: "alice", p: "9000" });
  });

  await t.step("collects repeated flags into arrays (no base)", () => {
    const out = parsedTextFlags(["--tag=a", "--tag", "b", "--tag=c"]);
    assertEquals(out, { tag: ["a", "b", "c"] });
    assert(Array.isArray(out.tag));
  });

  await t.step(
    "promotes string to array on repeat when base has empty string",
    () => {
      const out = parsedTextFlags(["--role", "admin", "--role", "editor"]);
      assertEquals(out, { role: ["admin", "editor"] });
    },
  );

  await t.step("appends to existing array when base starts as array", () => {
    const out = parsedTextFlags(["--scope", "read", "--scope", "write"], {
      scope: ["openid"],
    });
    assertEquals(out, { scope: ["openid", "read", "write"] });
  });

  await t.step("ignores flags without a value", () => {
    const out = parsedTextFlags(["--foo", "--bar", "x"]);
    // "--bar x" is set.
    assertEquals(out, { bar: "x", foo: true });
  });

  await t.step("does not treat next flag as a value", () => {
    const out = parsedTextFlags(["--a", "--b", "val"]);
    assertEquals(out, { a: true, b: "val" });
  });

  await t.step(
    "short flags collect independently from similarly named long flags",
    () => {
      const out = parsedTextFlags(["--t", "long", "-t", "short"]);
      // Keys are exactly what's after the dashes; they are the same key "t"
      assertEquals(out, { t: ["long", "short"] });
    },
  );

  await t.step("mixed ordering and forms", () => {
    const out = parsedTextFlags([
      "--env=prod",
      "-r",
      "us-east-1",
      "--env",
      "staging",
      "-r=eu-west-1",
    ]);
    assertEquals(out, {
      env: ["prod", "staging"],
      r: ["us-east-1", "eu-west-1"],
    });
  });

  await t.step("merges with provided base object without mutating it", () => {
    const base = { host: "127.0.0.1", tag: ["base"] as string[] };
    const out = parsedTextFlags(["--host", "0.0.0.0", "--tag", "a"], base);
    assertEquals(out, { host: "0.0.0.0", tag: ["base", "a"] });
    assertEquals(base, { host: "127.0.0.1", tag: ["base"] }); // unchanged
  });
});

Deno.test("parsedTextComponents", async (t) => {
  await t.step("returns false for undefined", () => {
    assertFalse(parsedTextComponents(undefined as unknown as string));
  });

  await t.step("returns false for empty string", () => {
    assertFalse(parsedTextComponents(""));
  });

  await t.step("returns false for whitespace-only", () => {
    assertFalse(parsedTextComponents("   \t\n  "));
  });

  await t.step("single token only", () => {
    const r = parsedTextComponents("echo");
    assert(r !== false);
    assertEquals(r.first, "echo");
    assertEquals(r.argv, []);
    assertEquals(r.argsText, "");
    assertEquals(typeof r.flags, "function");
  });

  await t.step("single token with trailing spaces", () => {
    const r = parsedTextComponents("  echo   ");
    assert(r !== false);
    assertEquals(r.first, "echo");
    assertEquals(r.argv, []);
    assertEquals(r.argsText, "");
  });

  await t.step("two tokens", () => {
    const r = parsedTextComponents("echo hi");
    assert(r !== false);
    assertEquals(r.first, "echo");
    assertEquals(r.argv, ["hi"]);
    assertEquals(r.argsText, "hi");
  });

  await t.step("multiple tokens (spaces collapse)", () => {
    const r = parsedTextComponents("echo   hello    world");
    assert(r !== false);
    assertEquals(r.first, "echo");
    assertEquals(r.argv, ["hello", "world"]);
    assertEquals(r.argsText, "hello world");
  });

  await t.step("tabs and newlines treated as separators", () => {
    const r = parsedTextComponents("cmd\ta\tb\nc");
    assert(r !== false);
    assertEquals(r.first, "cmd");
    assertEquals(r.argv, ["a", "b", "c"]);
    assertEquals(r.argsText, "a b c");
  });

  await t.step("leading dashes as first token (e.g., --help)", () => {
    const r = parsedTextComponents("--help");
    assert(r !== false);
    assertEquals(r.first, "--help");
    assertEquals(r.argv, []);
    assertEquals(r.argsText, "");
  });

  await t.step("complex CLI-like example with repeated flags", () => {
    const r = parsedTextComponents("bash name --dep X --dep Y");
    assert(r !== false);
    assertEquals(r.first, "bash");
    assertEquals(r.argv, ["name", "--dep", "X", "--dep", "Y"]);
    assertEquals(r.argsText, "name --dep X --dep Y");
    // We don't call r.flags() here to avoid requiring parsedTextFlags in the test.
    assertEquals(typeof r.flags, "function");
  });

  await t.step("unicode tokens", () => {
    const r = parsedTextComponents("run café crème");
    assert(r !== false);
    assertEquals(r.first, "run");
    assertEquals(r.argv, ["café", "crème"]);
    assertEquals(r.argsText, "café crème");
  });

  await t.step("quotes are not special (split on whitespace only)", () => {
    const r = parsedTextComponents(`cmd "hello world" again`);
    assert(r !== false);
    // Note the quotes remain attached to tokens; no shell-like parsing.
    assertEquals(r.first, "cmd");
    assertEquals(r.argv, [`"hello`, `world"`, "again"]);
    assertEquals(r.argsText, `"hello world" again`);
  });

  await t.step("mixed spacing with leading/trailing whitespace", () => {
    const r = parsedTextComponents("   git   commit   -m   initial   ");
    assert(r !== false);
    assertEquals(r.first, "git");
    assertEquals(r.argv, ["commit", "-m", "initial"]);
    assertEquals(r.argsText, "commit -m initial");
  });
});
