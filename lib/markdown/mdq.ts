#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// lib/markdown/mdq.ts
//
// Deno 2.x CLI using Cliffy that runs MDQL selectors over one or more Markdown files.
// Usage:
//   deno run -A lib/markdown/mdq.ts --md 1.md --md 2.md --select "heading:contains('foo')::section" --depth 2
//
// Notes:
// - --md can be given multiple times.
// - --select is required; it's an MDQL expression parsed by ./mdql.ts.
// - --depth controls how many child levels of each matched node to print (default 1).
// - Output is emitted as Markdown, grouped by file and match index.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import * as colors from "jsr:@std/fmt@1/colors";

import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { remark } from "npm:remark@^15";

import type { Root, RootContent } from "npm:@types/mdast@^4";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";

import flexibleCell from "./flexible-cell.ts";
import { parseMDQL, type SelectorList } from "./mdql.ts";
import { type Match, type MdastSource, mdqlSelector } from "./mdqlx.ts";

// ------------------------------
// Helpers
// ------------------------------

// deno-lint-ignore no-explicit-any
type Any = any;

function fail(msg: string): never {
  console.error(colors.red(`error: ${msg}`));
  Deno.exit(1);
}

// Unwrap Result<SelectorList, ParseError[] | string>
function unwrapParse(res: unknown): SelectorList {
  const r = res as { ok: boolean; value?: SelectorList; error?: unknown };
  if (r && r.ok && r.value) return r.value;
  const err = r?.error ?? "Unknown parse error";
  const printed = Array.isArray(err)
    ? (err as Array<{ message: string; loc?: unknown }>).map((e) =>
      `- ${e.message}${e.loc ? ` @ ${JSON.stringify(e.loc)}` : ""}`
    ).join("\n")
    : String(err);
  fail(`Could not parse --select:\n${printed}`);
}

// Build a Remark processor for parsing md -> mdast Root
function processor() {
  return remark()
    .use(remarkFrontmatter, ["yaml", "toml"])
    .use(remarkGfm)
    .use(remarkStringify)
    .use(flexibleCell); // attach PI/ATTRS on code nodes
}

// Clone a node with children limited to `depth` levels.
// depth=0 => the node without children
// depth=1 => node + its direct children (but grandchildren emptied), etc.
function cloneWithDepth<T extends RootContent | Root>(
  node: T,
  depth: number,
): T {
  if (depth <= 0) {
    const { children: _children, ...rest } = node as Any;
    const copy = { ...rest } as Any;
    if ("children" in copy) copy.children = [];
    return copy as T;
  }
  const copy = structuredClone(node) as Any;
  if (Array.isArray(copy.children)) {
    copy.children = (copy.children as Any[]).map((c) =>
      cloneWithDepth(c, depth - 1)
    );
  }
  return copy as T;
}

// Serialize a node (and optionally sub-tree) to Markdown by wrapping it in a temporary Root.
function nodeToMarkdown(node: RootContent, depth: number): string {
  const root: Root = { type: "root", children: [cloneWithDepth(node, depth)] };
  // Using remarkStringify which expects a unified tree; we already built a Root.
  // Create a processor solely for stringify.
  const str = remark().use(remarkStringify).stringify(root).trimEnd();
  return str;
}

// Build one source per file and provide a defaultRootProvider that returns the specific provenance.
async function buildSources(
  files: string[],
): Promise<
  {
    sources: MdastSource<string & { __prov?: string }>[];
    provider: (
      s: MdastSource<string & { __prov?: string }>,
    ) => Promise<[string, Root]>;
  }
> {
  const proc = processor();
  const rootsByPath = new Map<string, Root>();
  for (const p of files) {
    const text = await Deno.readTextFile(p);
    const tree = proc.parse(text) as Root;
    rootsByPath.set(p, tree);
  }

  // Each source returns its own root; we also tag provenance on the function object
  const sources: MdastSource<string & { __prov?: string }>[] = files.map(
    (p) => {
      // deno-lint-ignore require-await
      const fn = (async (_prov: string) => rootsByPath.get(p)!) as unknown as (
        provenance: string & { __prov?: string },
      ) => Promise<Root>;
      // we return an object {mdast} but keep __prov attached via binded closure on default provider
      return { mdast: fn as Any };
    },
  ) as Any;

  // defaultRootProvider returns tuple per-source
  const provider = async (
    source: MdastSource<string & { __prov?: string }>,
  ) => {
    // Each source is tied to a single file by closure; detect by reverse lookup
    // We will find its Root by running mdast once and then deducing which file path matches in our map.
    // Easiest: attach a weak map during creation—however to keep simple, we keep an index alignment:
    // the Nth source corresponds to files[N].
    // We'll compute index now:
    const idx = sources.indexOf(source as Any);
    const path = files[idx] ?? files[0];
    const root = await source.mdast(path as Any);
    return [path, root] as [string, Root];
  };

  return { sources, provider };
}

// Pretty banner for each match
function printMatchHeader(i: number, m: Match<string>, total: number) {
  const header = colors.bold(
    `\n---\nMatch ${i + 1}/${total} — ${m.provenance}`,
  );
  console.log(header);
}

// ------------------------------
// CLI
// ------------------------------

// Here’s the clean way, assuming your pipeline parses with `remark-gfm` (so tasks become `listItem` nodes with a boolean `checked` field):

// * **All task items (checked or not):**
//   `listItem[checked]`

// * **Completed tasks (`- [x]` / `- [X]`):**
//   `listItem[checked=true]`

// * **Incomplete tasks (`- [ ]`):**
//   `listItem[checked=false]`

// * **Only the text inside each task (not the whole list item):**
//   `listItem[checked=true] > paragraph`
//   (Increase `--depth` in `mdq` to include nested text if you want more than just the paragraph.)

// * **Tasks within a specific section by heading text:**
//   `heading:contains('Accounts')::section listItem[checked=false]`

// * **Tasks anywhere under a heading level:**
//   `h3::section listItem[checked=true]`

// * **Filter by text content (e.g., tasks mentioning “email”):**
//   `listItem[checked] :contains('email')`

// * **Nested tasks only (tasks that are children of other list items):**
//   `listItem > list > listItem[checked]`

// Tips:

// * Non-task list items have no `checked` property—`[checked]` is the reliable “taskness” test.
// * GFM treats `[x]` and `[X]` the same; both become `checked=true`.
// * If you just want the label text in CLI output, use a small `--depth` (e.g., `--depth 2` to include the immediate `paragraph` child).

if (import.meta.main) {
  const { options } = await new Command()
    .name("mdq")
    .version("1.0.0")
    .example("typical", `mdq.ts --md Qualityfolio.md --select "h1, h2"`)
    .example(
      "all task items",
      `mdq.ts --md Qualityfolio.md --select "listItem[checked] > paragraph"`,
    )
    .example(
      "all completed items",
      `mdq.ts --md Qualityfolio.md --select "listItem[checked=true] > paragraph"`,
    )
    .example(
      "all incomplete items",
      `mdq.ts --md Qualityfolio.md --select "listItem[checked=false] > paragraph"`,
    )
    .description(
      "Run MDQL selectors over Markdown files and emit matched nodes as Markdown.",
    )
    .option("--md <file:string>", "Markdown file to include (repeatable).", {
      collect: true,
    })
    .option("--select, -s <expr:string>", "MDQL selector expression.", {
      required: true,
    })
    .option(
      "--depth, -d <n:number>",
      "Emit up to this many child levels per match (default: 1).",
      {
        default: 1,
      },
    )
    .parse(Deno.args);

  const mdFiles: string[] = options.md ?? [];
  if (!mdFiles.length) fail("At least one --md <file> is required.");

  // Parse MDQL
  const selAst = unwrapParse(parseMDQL(String(options.select)));

  // Build sources and provider
  const { sources, provider } = await buildSources(mdFiles);

  // Compile executor
  const exec = mdqlSelector(selAst, {
    defaultRootProvider: provider as Any,
  });

  // Collect all matches first to show totals/grouping and allow deterministic output order.
  const matches: Match<string>[] = [];
  for await (const m of exec.select(sources)) matches.push(m);

  if (!matches.length) {
    console.log(colors.yellow("No matches."));
    Deno.exit(0);
  }

  // Emit
  const total = matches.length;
  matches.forEach((m, i) => {
    printMatchHeader(i, m, total);
    const out = nodeToMarkdown(m.node, Number(options.depth ?? 1));
    // If node is a leaf and stringify returns empty, fall back to text content
    const body = out.trim().length ? out : mdToString(m.node);
    console.log(body);
  });
}
