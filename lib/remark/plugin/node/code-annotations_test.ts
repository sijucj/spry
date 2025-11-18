// lib/markdown/remark/code-annotations_test.ts
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { Code, Root } from "types/mdast";
import { remark } from "remark";

import codeAnnotationsPlugin, {
  type CodeAnnotationsOptions,
  CODEANNS_KEY,
  type CodeWithAnnotationsNode,
} from "./code-annotations.ts";

import {
  ensureLanguageByIdOrAlias,
  type LanguageSpec,
} from "../../../universal/code.ts";

/** Helper to parse + run remark with our plugin. */
function runWithPlugin<Anns extends Record<string, unknown>>(
  md: string,
  language: LanguageSpec,
  opts?: {
    prefix?: string;
    defaults?: Partial<Anns>;
    collect?: (node: CodeWithAnnotationsNode<Anns>) => void;
  },
): Root {
  const processor = remark().use(
    [[
      codeAnnotationsPlugin,
      {
        ingest: (_code: Code) => ({
          language,
          prefix: opts?.prefix,
          defaults: opts?.defaults,
        }),
        collect: opts?.collect,
      } satisfies CodeAnnotationsOptions<Anns>,
    ]],
  );

  const tree = processor.parse(md) as Root;
  processor.runSync(tree);
  return tree;
}

function findFirstCodeNode(tree: Root): Code {
  const node = tree.children.find((n) => n.type === "code");
  if (!node || node.type !== "code") {
    throw new Error("No code node found in tree");
  }
  return node as Code;
}

Deno.test("codeAnnotations attaches parsed tag annotations to code nodes", () => {
  const md = [
    "```bash",
    "# @anns.one 1",
    '# @anns.two {"a": 2}',
    "# some unrelated comment",
    "echo hi",
    "```",
  ].join("\n");

  const lang = ensureLanguageByIdOrAlias("bash");

  const tree = runWithPlugin<{ one: number; two: { a: number } }>(
    md,
    lang,
    { prefix: "anns." },
  );

  const code = findFirstCodeNode(tree) as CodeWithAnnotationsNode<{
    one: number;
    two: { a: number };
  }>;

  assert(code.data);
  const anns = code.data[CODEANNS_KEY];
  assert(anns, "codeAnns should be attached to code node");

  // annotations object should map keys without the prefix
  assertEquals(anns.annotations, {
    one: 1,
    two: { a: 2 },
  });

  // catalog should see the right language id and item counts
  assertEquals(anns.annsCatalog.languageId, lang.id);
  const keys = Object.keys(anns.annsCatalog.summary ?? {});
  // We expect at least two tag entries (anns.one, anns.two)
  assert(
    keys.some((k) => k.startsWith("tag:anns.one")),
    "summary should contain anns.one tag",
  );
  assert(
    keys.some((k) => k.startsWith("tag:anns.two")),
    "summary should contain anns.two tag",
  );
});

Deno.test("codeAnnotations supports defaults and boolean tags", () => {
  const md = [
    "```bash",
    "# @anns.urgent",
    '# @anns.owner "alice"',
    "echo hi",
    "```",
  ].join("\n");

  const lang = ensureLanguageByIdOrAlias("bash");

  const tree = runWithPlugin<{
    urgent: boolean;
    owner: string;
    priority: number;
  }>(md, lang, {
    prefix: "anns.",
    defaults: { priority: 3, owner: "n/a", urgent: false },
  });

  const code = findFirstCodeNode(tree) as CodeWithAnnotationsNode<{
    urgent: boolean;
    owner: string;
    priority: number;
  }>;

  const anns = code.data[CODEANNS_KEY];
  assert(anns, "codeAnns should be attached to code node");

  // boolean tag (no value) => true, string tag keeps parsed string,
  // defaults are merged in for missing keys.
  assertEquals(anns.annotations, {
    urgent: true,
    owner: "alice",
    priority: 3,
  });
});

Deno.test("codeAnnotations plugin is idempotent across multiple runs", () => {
  const md = [
    "```bash",
    "# @anns.level 9",
    "echo hi",
    "```",
  ].join("\n");

  const lang = ensureLanguageByIdOrAlias("bash");

  const processor = remark().use(
    codeAnnotationsPlugin,
    {
      ingest: (_code: Code) => ({
        language: lang,
        prefix: "anns.",
      }),
    } satisfies CodeAnnotationsOptions<{ level: number }>,
  );

  const tree = processor.parse(md) as Root;

  // First run
  processor.runSync(tree);
  const code1 = findFirstCodeNode(tree) as CodeWithAnnotationsNode<{
    level: number;
  }>;

  const anns1 = code1.data[CODEANNS_KEY];
  assert(anns1, "codeAnns should be attached after first run");
  assertEquals(anns1.annotations, { level: 9 });

  // Save reference to ensure no duplicate / re-creation
  const annsRef = anns1;

  // Second run: should not re-ingest or create a new structure
  processor.runSync(tree);
  const code2 = findFirstCodeNode(tree) as CodeWithAnnotationsNode<{
    level: number;
  }>;
  const anns2 = code2.data[CODEANNS_KEY];

  assert(anns2, "codeAnns should still be present after second run");
  assertEquals(anns2.annotations, { level: 9 });
  assertStrictEquals(
    anns2,
    annsRef,
    "codeAnns object should be reused across runs (idempotent)",
  );
});

Deno.test("codeAnnotations respects ingest() returning false", () => {
  const md = [
    "```bash",
    "# @anns.skip 1",
    "```",
    "",
    "```bash",
    "# @anns.keep 2",
    "```",
  ].join("\n");

  const lang = ensureLanguageByIdOrAlias("bash");

  const processor = remark().use(
    codeAnnotationsPlugin,
    {
      ingest: (code: Code) => {
        // Skip the first code block (by simple heuristic)
        if ((code.value ?? "").includes("skip")) return false;
        return { language: lang, prefix: "anns." };
      },
    } satisfies CodeAnnotationsOptions<{ skip?: number; keep?: number }>,
  );

  const tree = processor.parse(md) as Root;
  processor.runSync(tree);

  const codeNodes = tree.children.filter((n) => n.type === "code") as Code[];

  const first = codeNodes[0] as CodeWithAnnotationsNode<{
    skip?: number;
    keep?: number;
  }>;
  const second = codeNodes[1] as CodeWithAnnotationsNode<{
    skip?: number;
    keep?: number;
  }>;

  // First should not have any annotations
  assert(!first.data || !(CODEANNS_KEY in first.data));

  // Second should be annotated
  assert(second.data && CODEANNS_KEY in second.data);
  const anns = second.data[CODEANNS_KEY];
  assertEquals(anns.annotations, { keep: 2 });
});
