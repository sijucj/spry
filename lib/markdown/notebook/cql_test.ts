// cql_test.ts
import { assertEquals, assertFalse } from "jsr:@std/assert@^1";
import { compileCqlMini } from "./cql.ts";
import { CodeCell } from "./notebook.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mkCell(
  partial: Partial<CodeCell<Any>> & { language?: string; source?: string },
): CodeCell<Any> {
  return {
    kind: "code",
    language: partial.language ?? "sql",
    source: partial.source ?? "",
    provenance: {
      path: (partial as Any)?.provenance?.path ?? "",
      filename: (partial as Any)?.provenance?.filename ?? "",
      index: (partial as Any)?.provenance?.index ?? 0,
      ...(partial as Any)?.provenance,
    },
    attrs: {
      ...(partial.attrs ?? {}),
    } as Record<string, unknown>,
    parsedPI: partial.parsedPI ?? {
      bareTokens: [],
      flags: {},
      firstToken: undefined,
      secondToken: undefined,
      hasEitherFlagOfType: () => false,
      hasFlagOfType: () => false,
    } as Any,
    pi: partial.pi,
    startLine: (partial as Any)?.startLine,
    endLine: (partial as Any)?.endLine,
    isVirtual: partial.isVirtual ?? false,
  };
}

const CELLS: CodeCell<Any>[] = [
  mkCell({
    language: "sql",
    source: `-- migration
CREATE   TABLE users (id integer primary key);`,
    provenance: {
      path: "/app/db/migrations/001-init.sql",
      filename: "001-init.sql",
      index: 0,
    },
    attrs: { env: "prod", tags: ["example", "migration"] },
    parsedPI: {
      bareTokens: [],
      flags: { capture: true },
      firstToken: "virtual",
      flags2: undefined,
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- migration
create table posts (id int, title text);`,
    provenance: {
      path: "/app/db/migrations/002-posts.sql",
      filename: "002-posts.sql",
      index: 1,
    },
    attrs: { env: "dev", tags: ["migration"] },
    parsedPI: {
      bareTokens: [],
      flags: {},
      firstToken: "virtual",
    } as Any,
  }),
  mkCell({
    language: "bash",
    source: `echo "hello"`,
    provenance: { path: "/scripts/hello.sh", filename: "hello.sh", index: 2 },
    attrs: { tags: ["example"] },
    parsedPI: {
      bareTokens: [],
      flags: { capture: true },
      firstToken: "run",
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- draft
CREATE TABLE temp (id int);`,
    provenance: {
      path: "/app/db/migrations/003-temp.draft.sql",
      filename: "003-temp.draft.sql",
      index: 3,
    },
    attrs: { env: "prod", tags: [] },
    parsedPI: {
      bareTokens: [],
      flags: {},
      firstToken: "virtual",
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- utility
-- no create here`,
    provenance: {
      path: "/app/db/util/cleanup.sql",
      filename: "cleanup.sql",
      index: 4,
    },
    attrs: {},
    parsedPI: undefined, // exercise missing parsedPI/flags
  }),
];

function names(xs: CodeCell<Any>[]): string[] {
  return xs.map((c) => (c.provenance as Any)?.filename ?? "");
}

Deno.test("CQL-mini compiler", async (t) => {
  await t.step("sql migrations with CREATE TABLE (glob + regex)", () => {
    const q =
      `lang:"sql" && path~glob("**/migrations/*.sql") && text~/CREATE\\s+TABLE/i`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), [
      "001-init.sql",
      "002-posts.sql",
      "003-temp.draft.sql",
    ]);
  });

  await t.step("tag('example') && flag('capture')", () => {
    const q = `tag("example") && flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "hello.sh"]);
  });

  await t.step(
    "has(pi.kind) && pi.kind:'virtual' && not draft filename",
    () => {
      const q = `has(pi.kind) && pi.kind:"virtual" && !(filename~".draft.")`;
      const run = compileCqlMini(q);
      const out = run(CELLS);
      assertEquals(names(out), ["001-init.sql", "002-posts.sql"]);
    },
  );

  await t.step("attr equality attr('env')=='prod'", () => {
    const q = `attr("env")=="prod"`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "003-temp.draft.sql"]);
  });

  await t.step("len(tags)>0 works and ignores non-arrays", () => {
    const q = `len(tags) > 0`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "002-posts.sql", "hello.sh"]);
  });

  await t.step("filename substring negative (!text~'DROP')", () => {
    const q = `!(text~"DROP TABLE")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    // none of our samples have DROP TABLE, so all pass
    assertEquals(out.length, CELLS.length);
  });

  await t.step("path glob only (matches util file)", () => {
    const q = `path~glob("**/util/*.sql")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["cleanup.sql"]);
  });

  await t.step("flags missing defaults to false", () => {
    const q = `flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    // capture true on 001-init.sql and hello.sh; missing flags on cleanup.sql should not match
    assertEquals(names(out), ["001-init.sql", "hello.sh"]);
    // sanity: ensure util/cleanup (no parsedPI) is not present
    assertFalse(names(out).includes("cleanup.sql"));
  });

  await t.step("string equality sugar ':' vs '=='", () => {
    const q1 = `lang:"bash"`; // String(c.language) === "bash"
    const q2 = `lang=="bash"`; // c.language === "bash"
    const run1 = compileCqlMini(q1);
    const run2 = compileCqlMini(q2);
    assertEquals(names(run1(CELLS)), ["hello.sh"]);
    assertEquals(names(run2(CELLS)), ["hello.sh"]);
  });

  await t.step("compose with || and && precedence", () => {
    const q = `lang:"bash" || (lang:"sql" && text~"utility")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["hello.sh", "cleanup.sql"]);
  });
});
