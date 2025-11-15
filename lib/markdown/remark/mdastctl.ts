#!/usr/bin/env -S deno run -A --node-modules-dir=auto
/**
 * @module mdastctl
 *
 * @summary
 * General-purpose CLI for exploring **mdast** trees.
 *
 * Commands:
 *
 *   - `ls`   : tabular listing of nodes (every node by default, or filtered via `--select` mdastql)
 *   - `tree` : MDFS-style heading/content hierarchy (headings as dirs, content as files),
 *              with a synthetic per-file root node.
 *   - `md`   : run mdastql `--select` and print the matching nodes as Markdown.
 *
 * This does NOT depend on MDFS; it works directly on Markdown → mdast.
 * It DOES reuse the tabular + tree TUIs (ListerBuilder + TreeLister) for pretty CLI output.
 */

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { CompletionsCommand } from "jsr:@cliffy/command@1.0.0-rc.8/completions";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";

// deno-lint-ignore no-explicit-any
type Any = any;

import { bold, cyan, gray, magenta, red, yellow } from "jsr:@std/fmt@1/colors";

import { basename } from "jsr:@std/path@1";

import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";
import { remark } from "npm:remark@^15";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";

import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";

import { mdastql, type MdastQlOptions } from "./mdastql.ts";

import codeFrontmatter from "../remark/code-frontmatter.ts";
import docFrontmatter from "../remark/doc-frontmatter.ts";
import headingFrontmatter from "../remark/heading-frontmatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MdastNode = Root | RootContent;

type ParentLike = Root | (RootContent & { children?: RootContent[] });

export interface LsRow {
  readonly id: number;
  readonly file: string;
  readonly type: RootContent["type"];
  readonly depth: number;
  readonly headingPath: string;
  readonly name: string;
  readonly dataKeys?: string;
}

export interface TreeRow {
  readonly id: string;
  readonly file: string;
  readonly kind: "heading" | "content";
  readonly label: string;
  readonly type: RootContent["type"] | "root";
  readonly parentId?: string;
  readonly dataKeys?: string;
}

// ---------------------------------------------------------------------------
// Tiny mdast helpers
// ---------------------------------------------------------------------------

function isParent(node: MdastNode): node is ParentLike {
  return Array.isArray((node as Any).children);
}

/**
 * Depth-first walk over mdast, exposing:
 *   - node (RootContent)
 *   - parent
 *   - depth (0 for root children, 1 for their children, etc.)
 *   - index within parent.children
 */
function walkTree(
  root: Root,
  fn: (
    node: RootContent,
    ctx: { parent: ParentLike; depth: number; index: number },
  ) => void,
): void {
  const children = root.children ?? [];

  const visitChildren = (parent: ParentLike, depth: number): void => {
    const kids = (parent as Any).children as RootContent[] | undefined;
    if (!kids) return;
    kids.forEach((child, index) => {
      fn(child, { parent, depth, index });
      if (isParent(child)) {
        visitChildren(child, depth + 1);
      }
    });
  };

  children.forEach((child, index) => {
    fn(child, { parent: root, depth: 0, index });
    if (isParent(child)) {
      visitChildren(child, 1);
    }
  });
}

/** Collect visible text from a node and its descendants. */
function nodeToPlainText(node: MdastNode): string {
  const chunks: string[] = [];

  const recur = (n: MdastNode): void => {
    if ((n as Any).value && typeof (n as Any).value === "string") {
      chunks.push((n as Any).value as string);
    }
    if (Array.isArray((n as Any).children)) {
      for (const c of (n as Any).children as RootContent[]) {
        recur(c);
      }
    }
  };

  recur(node);
  return chunks.join("").replace(/\s+/g, " ").trim();
}

function headingText(h: Heading): string {
  const text = nodeToPlainText(h);
  return text || "(untitled)";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function summarizeNode(node: RootContent): string {
  switch (node.type) {
    case "heading":
      return headingText(node as Heading);
    case "paragraph":
      return truncate(nodeToPlainText(node), 60);
    case "code": {
      const lang = (node as Any).lang as string | undefined;
      return lang ? truncate(`\`${lang}\` code`, 60) : "code";
    }
    case "list":
      return "list";
    case "listItem":
      return truncate(nodeToPlainText(node), 60) || "list item";
    case "thematicBreak":
      return "hr";
    default:
      return truncate(nodeToPlainText(node) || node.type, 60);
  }
}

function fileRef(file: string, node?: RootContent): string {
  const line = node?.position?.start?.line;
  if (typeof line !== "number") return file;
  return `${file}:${line}`;
}

// ---------------------------------------------------------------------------
// mdastql selection (Option A – use real mdastql.ts)
// ---------------------------------------------------------------------------

function selectNodes(
  root: Root,
  query: string | undefined,
  options?: MdastQlOptions,
): RootContent[] {
  if (!query) {
    // Default: every node (Option 2)
    const out: RootContent[] = [];
    walkTree(root, (node) => out.push(node));
    return out;
  }
  const { nodes } = mdastql(root, query, options);
  // mdastql returns readonly; we can treat it as mutable locally if needed.
  return [...nodes];
}

// ---------------------------------------------------------------------------
// LS rows: every node + heading path
// ---------------------------------------------------------------------------

function shouldEmitNodeForLs(
  node: RootContent,
  parent: ParentLike,
  hasQuery: boolean,
): boolean {
  // If user provided --select, be literal: show whatever mdastql returned.
  if (hasQuery) return true;

  // Always skip raw text as its own row; parents already summarize it.
  if (node.type === "text") return false;

  // Paragraphs directly under list items are just wrappers for bullet text.
  // We'll keep the listItem row and drop the inner paragraph row.
  if (node.type === "paragraph" && (parent as Any).type === "listItem") {
    return false;
  }

  // Inline-only wrappers are usually not helpful as standalone rows.
  // Their content is already reflected in parent nodeToPlainText().
  if (
    node.type === "strong" ||
    node.type === "emphasis" ||
    node.type === "delete" ||
    node.type === "link" ||
    node.type === "linkReference"
  ) {
    return false;
  }

  return true;
}

interface BuildLsRowsOptions {
  readonly includeDataKeys?: boolean;
  readonly query?: string;
  readonly mdastqlOptions?: MdastQlOptions;
}

/**
 * Build a tabular row set for `ls`:
 *
 * - Every node (by default) or only mdastql-selected nodes (`--select`).
 * - Each row includes:
 *   - file
 *   - type
 *   - depth (tree depth)
 *   - headingPath (path of ancestor headings like "Intro / Examples")
 *   - name (human summary)
 *   - where (line:col)
 *   - dataKeys (CSV of node.data keys if requested)
 */
function buildLsRows(
  file: string,
  root: Root,
  opts: BuildLsRowsOptions = {},
): LsRow[] {
  const { includeDataKeys, query, mdastqlOptions } = opts;
  const selected = selectNodes(root, query, mdastqlOptions);
  const selectedSet = new Set(selected);

  const rows: LsRow[] = [];
  let id = 1;

  // Track heading hierarchy by depth to build headingPath strings
  const headingStack: (string | undefined)[] = [];
  const hasQuery = !!query;

  walkTree(root, (node, { depth, parent }) => {
    // Maintain heading stack for *all* nodes so descendants get correct paths
    if (node.type === "heading") {
      const h = node as Heading;
      const hd = (h.depth ?? 1) | 0;
      const label = headingText(h);
      if (hd > 0) {
        headingStack.splice(hd - 1);
        headingStack[hd - 1] = label;
      }
    }

    // Only consider nodes selected by mdastql (or all if no query).
    if (!selectedSet.has(node)) return;

    // Apply de-duplication / noise filtering for default ls.
    if (!shouldEmitNodeForLs(node, parent, hasQuery)) return;

    const headingPath = headingStack.filter(Boolean).join(" → ");
    const name = node.type === "heading"
      ? `h${(node as Any).depth ?? "?"}: ${headingText(node as Heading)}`
      : summarizeNode(node);

    const dataKeys = includeDataKeys && node.data
      ? Object.keys(node.data as Record<string, unknown>).join(", ")
      : undefined;

    rows.push({
      id: id++,
      file: fileRef(file, node),
      type: node.type,
      depth,
      headingPath,
      name,
      dataKeys,
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// TREE rows: MDFS-style heading/content hierarchy with synthetic file root
// ---------------------------------------------------------------------------

/**
 * Build `TreeRow`s:
 *
 * - Add a synthetic root per file:
 *   - id: `${file}#root`
 *   - label: basename(file) (or `<stdin>`)
 *   - type: "root"
 * - Headings become children of the nearest shallower heading, falling back to file root.
 * - Non-heading top-level nodes become "content" children under the last heading or the file root.
 */
function buildTreeRows(
  file: string,
  root: Root,
): TreeRow[] {
  const rows: TreeRow[] = [];
  let counter = 0;

  const label = file === "<stdin>" ? "<stdin>" : basename(file || "<stdin>");
  const rootId = `${file}#root`;

  // Synthetic file root row
  rows.push({
    id: rootId,
    file,
    kind: "heading",
    type: "root",
    label,
    parentId: undefined,
  });

  type StackEntry = { depth: number; id: string };
  // Depth 0 synthetic root; real headings will be depth >= 1
  const stack: StackEntry[] = [{ depth: 0, id: rootId }];

  const children = root.children ?? [];

  for (const child of children) {
    if (child.type === "heading") {
      const h = child as Heading;
      const hd = (h.depth ?? 1) | 0;

      // Pop until parent has smaller depth, but never pop the synthetic root.
      while (stack.length > 1 && stack[stack.length - 1]?.depth >= hd) {
        stack.pop();
      }

      const parentId = stack[stack.length - 1]?.id;
      const id = `${file}#h${counter++}`;
      const dataKeys = (child as Any).data
        ? Object.keys((child as Any).data as Record<string, unknown>).join(", ")
        : undefined;

      rows.push({
        id,
        file: fileRef(file, child),
        kind: "heading",
        type: "heading",
        label: headingText(h),
        parentId,
        dataKeys,
      });

      stack.push({ depth: hd, id });
    } else {
      // Non-heading: treat as content under the last heading, or file root.
      const parentId = stack[stack.length - 1]?.id ?? rootId;
      const id = `${file}#n${counter++}`;

      const dataKeys = (child as Any).data
        ? Object.keys((child as Any).data as Record<string, unknown>).join(",")
        : undefined;

      rows.push({
        id,
        file: fileRef(file, child),
        kind: "content",
        type: child.type,
        label: summarizeNode(child),
        parentId,
        dataKeys,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Markdown output for selected nodes
// ---------------------------------------------------------------------------

/**
 * Turn selected nodes back into Markdown.
 *
 * Option 1 (your choice): just stringify the nodes as-is,
 * without extra wrappers or separators.
 */
function nodesToMarkdown(nodes: RootContent[]): string {
  const root: Root = {
    type: "root",
    children: nodes,
  };
  return mdToString(root);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function readMarkdownTrees(
  files: readonly string[],
  processor = remark()
    .use(remarkFrontmatter, ["yaml"])
    .use(docFrontmatter)
    .use(remarkGfm)
    .use(headingFrontmatter)
    .use(codeFrontmatter, {
      coerceNumbers: true, // "9" -> 9
      onAttrsParseError: "ignore", // ignore invalid JSON5 instead of throwing
    }),
): Promise<Array<{ file: string; root: Root }>> {
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
    const text = await new Response(Deno.stdin.readable).text();
    const root = processor.parse(text);
    await processor.run(root);
    return [{ file: "<stdin>", root }];
  }

  const results: Array<{ file: string; root: Root }> = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    const root = processor.parse(text);
    await processor.run(root);
    results.push({ file, root });
  }
  return results;
}

/** Merge global --file plus positional paths; default to stdin ("-") if none. */
function resolveFiles(
  globalFiles: string[] | undefined,
  positional: string[],
): string[] {
  const merged = [...(globalFiles ?? []), ...positional];
  return merged.length > 0 ? merged : ["-"];
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

export class CLI {
  constructor(readonly globalFiles?: string[]) {
  }

  rootCmd() {
    return new Command()
      .name("mdastctl.ts")
      .version("0.1.0")
      .description(`query and explore Markdown ASTs (mdast)`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("ls", this.lsCommand())
      .command("tree", this.treeCommand())
      .command("md", this.mdCommand());
  }

  static instance(): CLI {
    return new CLI();
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  // -------------------------------------------------------------------------
  // ls command
  // -------------------------------------------------------------------------

  /**
   * `ls` – list mdast nodes in a tabular, content-hierarchy-friendly way.
   *
   * - By default: includes every node in the tree.
   * - With `--select <expr>`: only nodes matching that mdastql expression.
   * - With `--data`: adds a DATA column showing `Object.keys(node.data)`.
   */
  protected lsCommand() {
    return new Command()
      .description(`list mdast nodes in a tabular, content-hierarchy view`)
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (default: every node).",
      )
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const files = resolveFiles(this.globalFiles, paths);
          const trees = await readMarkdownTrees(files);
          const allRows: LsRow[] = [];

          for (const { file, root } of trees) {
            const rows = buildLsRows(file, root, {
              includeDataKeys: !!options.data,
              query: options.select,
            });
            allRows.push(...rows);
          }

          if (allRows.length === 0) {
            console.log(gray("No nodes matched."));
            return;
          }

          const useColor = options.color;

          const builder = new ListerBuilder<LsRow>()
            .from(allRows)
            .declareColumns(
              "id",
              "file",
              "type",
              "depth",
              "headingPath",
              "name",
              "dataKeys",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.numeric("id", (r) => r.id, {
            header: "ID",
            defaultColor: yellow,
          });
          builder.field("file", "file", {
            header: "FILE",
            defaultColor: gray,
          });
          builder.field("type", "type", {
            header: "TYPE",
            defaultColor: cyan,
          });
          builder.numeric("depth", (r) => r.depth, {
            header: "DEPTH",
          });
          builder.field("headingPath", "headingPath", {
            header: "HEADING PATH",
            defaultColor: gray,
          });
          builder.field("name", "name", {
            header: "NAME",
            defaultColor: bold,
          });

          if (options.data) {
            builder.field("dataKeys", "dataKeys", {
              header: "DATA",
              defaultColor: magenta,
            });
          }

          // Display in a sensible default order
          const ids: Array<keyof LsRow & string> = [
            "id",
            "file",
            "type",
            "depth",
            "headingPath",
            "name",
          ];
          if (options.data) ids.push("dataKeys");
          builder.select(...ids);

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }

  // -------------------------------------------------------------------------
  // tree command
  // -------------------------------------------------------------------------

  /**
   * `tree` – show a heading/content hierarchy per file, similar to MDFS:
   *
   * - Synthetic file root node is the top-level parent.
   * - Headings are "directories".
   * - Non-heading nodes under headings are "files" (content).
   */
  protected treeCommand() {
    return new Command()
      .description(`heading/content hierarchy (MDFS-style, per file)`)
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allRows: TreeRow[] = [];

        for (const { file, root } of trees) {
          const rows = buildTreeRows(file, root);
          allRows.push(...rows);
        }

        if (allRows.length === 0) {
          console.log(gray("No headings or content to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns("label", "type", "file", "dataKeys")
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        base.field("label", "label", {
          header: "NAME",
          defaultColor: bold,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        if (options.data) {
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: magenta,
          });
        }

        if (options.data) {
          base.select("label", "type", "file", "dataKeys");
        } else {
          base.select("label", "type", "file");
        }

        const treeLister = TreeLister.wrap(base)
          .from(allRows)
          .byParentChild({ idKey: "id", parentIdKey: "parentId" })
          .treeOn("label")
          .dirFirst(true);

        await treeLister.ls(true);
      });
  }

  // -------------------------------------------------------------------------
  // md command
  // -------------------------------------------------------------------------

  /**
   * `md` – run mdastql and print the selected nodes as Markdown.
   *
   * Example:
   *   mdastq md --select 'h2 + code[lang=ts]' README.md
   */
  protected mdCommand() {
    return new Command()
      .description(`run mdastql and print the selected nodes as Markdown`)
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (required – which nodes to emit as Markdown).",
      )
      .action(async (options, ...paths: string[]) => {
        if (!options.select) {
          console.error(red("md: --select <query> is required"));
          Deno.exit(1);
        }

        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allNodes: RootContent[] = [];

        for (const { root } of trees) {
          const nodes = selectNodes(root, options.select);
          allNodes.push(...nodes);
        }

        if (allNodes.length === 0) {
          console.log(gray("No nodes matched; nothing to print."));
          return;
        }

        const markdown = nodesToMarkdown(allNodes);
        // Color is irrelevant here – just raw Markdown.
        console.log(markdown);
      });
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await CLI.instance().run();
}
