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

import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import { remark } from "npm:remark@^15";

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
    if (!parent.children) return;
    parent.children.forEach((child, index) => {
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

function markNodesContainingSelected(
  root: Root,
  selected: Set<RootContent>,
): WeakMap<RootContent, boolean> {
  const map = new WeakMap<RootContent, boolean>();

  const visitNode = (node: RootContent): boolean => {
    let has = selected.has(node);
    if (isParent(node)) {
      if (node.children) {
        for (const child of node.children) {
          if (visitNode(child)) has = true;
        }
      }
    }
    map.set(node, has);
    return has;
  };

  for (const child of root.children ?? []) {
    visitNode(child);
  }

  return map;
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
      return headingText(node);
    case "paragraph":
      return truncate(nodeToPlainText(node), 60);
    case "code": {
      return node.lang ? truncate(`\`${node.lang}\` code`, 60) : "code";
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
  if (node.type === "paragraph" && parent.type === "listItem") {
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
      const hd = (node.depth ?? 1) | 0;
      const label = headingText(node);
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
      ? `h${node.depth ?? "?"}: ${headingText(node)}`
      : summarizeNode(node);

    const dataKeys = includeDataKeys && node.data
      ? Object.keys(node.data).join(", ")
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

interface BuildTreeRowsOptions {
  readonly selectedNodes?: RootContent[];
}

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
  opts: BuildTreeRowsOptions = {},
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
    dataKeys: undefined,
  });

  type StackEntry = { depth: number; id: string };
  // Depth 0 synthetic root; real headings will be depth >= 1
  const stack: StackEntry[] = [{ depth: 0, id: rootId }];

  const children = root.children ?? [];

  // Selection support
  const selectedNodes = opts.selectedNodes;
  const selectedSet = selectedNodes && selectedNodes.length > 0
    ? new Set(selectedNodes)
    : undefined;
  const containsSelected = selectedSet
    ? markNodesContainingSelected(root, selectedSet)
    : undefined;

  // Map row.id -> underlying top-level node (or null for synthetic root)
  const rowNode = new Map<string, RootContent | null>();
  rowNode.set(rootId, null);

  for (const child of children) {
    if (child.type === "heading") {
      const hd = (child.depth ?? 1) | 0;

      // Pop until parent has smaller depth, but never pop the synthetic root.
      while (stack.length > 1 && stack[stack.length - 1]?.depth >= hd) {
        stack.pop();
      }

      const parentId = stack[stack.length - 1]?.id;
      const id = `${file}#h${counter++}`;

      const dataKeys = child.data
        ? Object.keys(child.data).join(",")
        : undefined;

      rows.push({
        id,
        file: fileRef(file, child),
        kind: "heading",
        type: "heading",
        label: headingText(child),
        parentId,
        dataKeys,
      });

      rowNode.set(id, child);
      stack.push({ depth: hd, id });
    } else {
      // Non-heading: treat as content under the last heading, or file root.
      const parentId = stack[stack.length - 1]?.id ?? rootId;
      const id = `${file}#n${counter++}`;

      const dataKeys = child.data
        ? Object.keys(child.data).join(", ")
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

      rowNode.set(id, child);
    }
  }

  // If no selection, return full tree
  if (!selectedSet) return rows;

  // Determine which rows are directly "hit" by selection (their node subtree contains a selected node)
  const prelim = new Set<string>();
  for (const [id, node] of rowNode.entries()) {
    if (!node) continue; // synthetic root; handle later
    if (containsSelected?.get(node)) {
      prelim.add(id);
    }
  }

  if (prelim.size === 0) {
    // Nothing matched in this file; keep only synthetic root so treeCommand
    // can still merge multiple files sensibly.
    return rows.filter((r) => r.id === rootId);
  }

  // Close upwards over ancestors: include all parents up to the file root
  const byId = new Map<string, TreeRow>(rows.map((r) => [r.id, r]));
  const allowed = new Set<string>();
  const stackIds = [...prelim];

  while (stackIds.length) {
    const id = stackIds.pop()!;
    if (allowed.has(id)) continue;
    allowed.add(id);
    const row = byId.get(id);
    if (row?.parentId && !allowed.has(row.parentId)) {
      stackIds.push(row.parentId);
    }
  }

  // Always include the synthetic root
  allowed.add(rootId);

  return rows.filter((r) => allowed.has(r.id));
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

interface ParsedMarkdownTree {
  readonly file: string;
  readonly root: Root;
  readonly source: string;
}

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
): Promise<Array<ParsedMarkdownTree>> {
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
    const text = await new Response(Deno.stdin.readable).text();
    const root = processor.parse(text);
    await processor.run(root);
    return [{ file: "<stdin>", root, source: text }];
  }

  const results: Array<ParsedMarkdownTree> = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    const root = processor.parse(text);
    await processor.run(root);
    results.push({ file, root, source: text });
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

function nodeOffsetsInSource(
  source: string,
  node: RootContent,
): [number, number] | undefined {
  const pos = node.position as Any;
  if (!pos || !pos.start || !pos.end) return undefined;

  const start = pos.start as Any;
  const end = pos.end as Any;

  if (
    typeof start.offset === "number" &&
    typeof end.offset === "number"
  ) {
    return [start.offset, end.offset];
  }

  const lines = source.split(/\r?\n/);

  const startLineIdx = (start.line as number ?? 1) - 1;
  const endLineIdx = (end.line as number ?? 1) - 1;
  const startCol = (start.column as number ?? 1) - 1;
  const endCol = (end.column as number ?? 1) - 1;

  if (
    startLineIdx < 0 || startLineIdx >= lines.length ||
    endLineIdx < 0 || endLineIdx >= lines.length
  ) {
    return undefined;
  }

  const indexFromLineCol = (lineIdx: number, col: number): number => {
    let idx = 0;
    for (let i = 0; i < lineIdx; i++) {
      // +1 for newline
      idx += lines[i].length + 1;
    }
    return idx + col;
  };

  const startOffset = indexFromLineCol(startLineIdx, startCol);
  const endOffset = indexFromLineCol(endLineIdx, endCol);
  return [startOffset, endOffset];
}

function sliceSourceForNode(source: string, node: RootContent): string {
  const offsets = nodeOffsetsInSource(source, node);
  if (offsets) {
    const [start, end] = offsets;
    return source.slice(start, end);
  }

  // Fallback: as a last resort, re-stringify this node
  const root: Root = { type: "root", children: [node] };
  return remark().stringify(root);
}

interface SectionRange {
  start: number;
  end: number;
}

/**
 * Given the root, source, and a list of selected heading nodes that are
 * direct children of the root, compute non-overlapping section ranges:
 * each from a heading's start to the next heading of same or higher depth
 * (or end-of-file).
 */
function computeSectionRangesForHeadings(
  root: Root,
  source: string,
  headings: Heading[],
): SectionRange[] {
  const children = root.children ?? [];
  if (children.length === 0 || headings.length === 0) return [];

  // Map heading node -> its index in root.children (only for direct children)
  const indexByNode = new Map<Heading, number>();
  children.forEach((child, idx) => {
    if (child.type === "heading") {
      indexByNode.set(child as Heading, idx);
    }
  });

  const indices: number[] = [];
  for (const h of headings) {
    const idx = indexByNode.get(h);
    if (idx !== undefined) indices.push(idx);
  }
  if (indices.length === 0) return [];

  indices.sort((a, b) => a - b);

  const ranges: SectionRange[] = [];

  for (const idx of indices) {
    const heading = children[idx] as Heading;
    const depth = heading.depth ?? 1;

    const offsets = nodeOffsetsInSource(source, heading);
    if (!offsets) continue;
    const [startOffset] = offsets;

    // Find next heading of same or higher depth
    let endOffset = source.length;
    for (let j = idx + 1; j < children.length; j++) {
      const candidate = children[j];
      if (candidate.type === "heading") {
        const ch = candidate as Heading;
        const cDepth = ch.depth ?? 1;
        if (cDepth <= depth) {
          const nextOffsets = nodeOffsetsInSource(
            source,
            candidate as RootContent,
          );
          if (nextOffsets) {
            endOffset = nextOffsets[0];
          }
          break;
        }
      }
    }

    ranges.push({ start: startOffset, end: endOffset });
  }

  // Merge overlapping/adjacent ranges
  ranges.sort((a, b) => a.start - b.start);
  const merged: SectionRange[] = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1]!;
    if (r.start <= last.end) {
      // overlap or adjacency: extend the existing range
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
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
      .option("--select <query:string>", "mdastql selection to focus the tree.")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allRows: TreeRow[] = [];

        for (const { file, root } of trees) {
          const selectedNodes = options.select
            ? selectNodes(root, options.select)
            : undefined;

          const rows = buildTreeRows(file, root, { selectedNodes });
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
      .option(
        "--section",
        "When selected nodes are headings, emit the entire section " +
          "(from that heading down to before the next heading of same/higher depth).",
      )
      .action(async (options, ...paths: string[]) => {
        if (!options.select) {
          console.error(red("md: --select <query> is required"));
          Deno.exit(1);
        }

        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allChunks: string[] = [];

        const sectionMode = !!options.section;

        for (const { root, source } of trees) {
          const nodes = selectNodes(root, options.select);

          if (!sectionMode) {
            // Simple mode: just slice each selected node from source
            for (const node of nodes) {
              const snippet = sliceSourceForNode(source, node);
              if (snippet) allChunks.push(snippet);
            }
            continue;
          }

          // SECTION mode: expand selected headings into sections.
          const headings: Heading[] = [];
          const nonHeadingNodes: RootContent[] = [];

          for (const node of nodes) {
            if (node.type === "heading") {
              headings.push(node as Heading);
            } else {
              nonHeadingNodes.push(node);
            }
          }

          const sectionRanges = computeSectionRangesForHeadings(
            root,
            source,
            headings,
          );

          if (sectionRanges.length > 0) {
            // We have at least one bona fide section in this file: emit only sections.
            for (const r of sectionRanges) {
              allChunks.push(source.slice(r.start, r.end));
            }
          } else {
            // No usable sections (e.g., no direct-root headings selected):
            // fall back to per-node snippets for *all* selected nodes in this file.
            for (const node of nodes) {
              const snippet = sliceSourceForNode(source, node);
              if (snippet) allChunks.push(snippet);
            }
          }
        }

        if (allChunks.length === 0) {
          console.log(gray("No nodes matched; nothing to print."));
          return;
        }

        // Separate chunks with a blank line for readability
        console.log(allChunks.join("\n\n"));
      });
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await CLI.instance().run();
}
