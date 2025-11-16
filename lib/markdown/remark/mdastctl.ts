#!/usr/bin/env -S deno run -A --node-modules-dir=auto
/**
 * @module mdastctl
 *
 * General-purpose CLI for exploring **mdast** trees.
 */

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { CompletionsCommand } from "jsr:@cliffy/command@1.0.0-rc.8/completions";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";

import { bold, cyan, gray, magenta, red, yellow } from "jsr:@std/fmt@1/colors";

import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";

import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";

import type { MdastQlOptions } from "./mdastql.ts";

import {
  buildMdAstTreeRows,
  formatNodeClasses,
  headingText,
  type ParsedMarkdownTree,
  selectNodes,
  summarizeNode,
  type TreeRow,
  walkTree,
} from "./mdast-view.ts";

import {
  computeSectionRangesForHeadings,
  readMarkdownTrees,
  resolveFiles,
  sliceSourceForNode,
} from "./mdast-io.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LsRow {
  readonly id: number;
  readonly file: string;
  readonly type: RootContent["type"];
  readonly depth: number;
  readonly headingPath: string;
  readonly name: string;
  readonly classInfo?: string;
  readonly dataKeys?: string;
}

// ---------------------------------------------------------------------------
// mdastql selection helpers for `ls`
// ---------------------------------------------------------------------------

interface BuildLsRowsOptions {
  readonly includeDataKeys?: boolean;
  readonly query?: string;
  readonly mdastqlOptions?: MdastQlOptions;
}

function shouldEmitNodeForLs(
  node: RootContent,
  parent:
    | Root
    | (RootContent & { children?: RootContent[] }),
  hasQuery: boolean,
): boolean {
  // If user provided --select, be literal: show whatever mdastql returned.
  if (hasQuery) return true;

  // Always skip raw text as its own row; parents already summarize it.
  if (node.type === "text") return false;

  // Paragraphs directly under list items are just wrappers for bullet text.
  if (node.type === "paragraph" && parent.type === "listItem") {
    return false;
  }

  // Inline-only wrappers are usually not helpful as standalone rows.
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

/**
 * Build a tabular row set for `ls`:
 *
 * - Every node (by default) or only mdastql-selected nodes (`--select`).
 * - Each row includes:
 *   - file
 *   - type
 *   - depth (tree depth)
 *   - headingPath (path of ancestor headings like "Intro → Examples")
 *   - name (human summary)
 *   - CLASS (flattened `data.class` as key:value pairs)
 *   - DATA (CSV of node.data keys if requested)
 */
function buildLsRows(
  pmt: ParsedMarkdownTree,
  root: Root,
  opts: BuildLsRowsOptions = {},
): LsRow[] {
  const { fileRef } = pmt;
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
      const label = headingText(node as Heading);
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
      ? `h${node.depth ?? "?"}: ${headingText(node as Heading)}`
      : summarizeNode(node);

    const classInfo = formatNodeClasses(node);

    const dataKeys = includeDataKeys && node.data
      ? Object.keys(node.data).join(", ")
      : undefined;

    rows.push({
      id: id++,
      file: fileRef(node),
      type: node.type,
      depth,
      headingPath,
      name,
      classInfo,
      dataKeys,
    });
  });

  return rows;
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
      .command("class", this.classCommand())
      .command("schema", this.schemaCommand())
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

          for (const pmt of trees) {
            const rows = buildLsRows(pmt, pmt.root, {
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
              "classInfo",
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
          builder.field("classInfo", "classInfo", {
            header: "CLASS",
            defaultColor: magenta,
          });

          if (options.data) {
            builder.field("dataKeys", "dataKeys", {
              header: "DATA",
              defaultColor: magenta,
            });
          }

          const ids: Array<keyof LsRow & string> = [
            "id",
            "file",
            "type",
            "depth",
            "headingPath",
            "name",
            "classInfo",
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

  protected treeCommand() {
    return new Command()
      .description(`heading/content hierarchy (per file)`)
      .arguments("[paths...:string]")
      .option("--select <query:string>", "mdastql selection to focus the tree.")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allRows: TreeRow[] = [];

        for (const pmt of trees) {
          const selectedNodes = options.select
            ? selectNodes(pmt.root, options.select)
            : undefined;

          const rows = buildMdAstTreeRows("physical", pmt, {
            includeDataKeys: !!options.data,
            selectedNodes,
            pruneToSelection: !!options.select,
          });
          allRows.push(...rows);
        }

        if (allRows.length === 0) {
          console.log(gray("No headings or content to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns("label", "type", "file", "classInfo", "dataKeys")
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
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: magenta,
        });
        if (options.data) {
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: magenta,
          });
        }

        if (options.data) {
          base.select("label", "type", "classInfo", "file", "dataKeys");
        } else {
          base.select("label", "type", "classInfo", "file");
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
  // class command
  // -------------------------------------------------------------------------

  protected classCommand() {
    return new Command()
      .description(
        `show classification hierarchy per file (class key → value → nodes)`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allRowsRaw: TreeRow[] = [];

        for (const pmt of trees) {
          const rows = buildMdAstTreeRows("class", pmt, {
            includeDataKeys: !!options.data,
          });
          allRowsRaw.push(...rows);
        }

        if (allRowsRaw.length === 0) {
          console.log(gray("No classified nodes to show."));
          return;
        }

        // Apply CLI-specific coloring to labels
        const allRows: TreeRow[] = allRowsRaw.map((row) => {
          let label = row.label;
          if (row.type === "root") {
            label = bold(label);
          } else if (row.type === "class-key") {
            label = cyan(label);
          } else if (row.type === "class-value") {
            label = magenta(label);
          }
          return { ...row, label };
        });

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns("label", "classInfo", "type", "file", "dataKeys")
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        // Identity color so pre-colored labels are preserved
        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s) => s,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: gray,
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
          base.select("label", "classInfo", "type", "file", "dataKeys");
        } else {
          base.select("label", "classInfo", "type", "file");
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
  // schema command
  // -------------------------------------------------------------------------

  protected schemaCommand() {
    return new Command()
      .description(
        `show section schema hierarchy (per file) using documentSchema plugin`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(this.globalFiles, paths);
        const trees = await readMarkdownTrees(files);
        const allRows: TreeRow[] = [];

        for (const pmt of trees) {
          const baseRows = buildMdAstTreeRows("schema", pmt, {
            includeDataKeys: !!options.data,
          });

          if (baseRows.length === 0) continue;

          // Apply CLI-specific coloring and icons
          const rows = baseRows.map((row) => {
            let label = row.label;

            if (row.type === "root") {
              label = bold(`📁 ${label}`);
            } else if (row.kind === "heading") {
              const schemaLevel = row.schemaLevel ?? 0;
              const base = `📁 ${label}`;
              if (schemaLevel === 0) {
                label = cyan(base);
              } else if (schemaLevel === 1) {
                label = yellow(base);
              } else {
                label = magenta(base);
              }
            } else {
              label = `📄 ${gray(label)}`;
            }

            return { ...row, label };
          });

          allRows.push(...rows);
        }

        if (allRows.length === 0) {
          console.log(gray("No sections to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns("label", "type", "file", "classInfo", "dataKeys")
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        // preserve pre-colored labels (sections by level, nodes gray)
        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s) => s,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: magenta,
        });
        base.field("dataKeys", "dataKeys", {
          header: "DATA",
          defaultColor: magenta,
        });

        if (options.data) {
          base.select("label", "classInfo", "type", "file", "dataKeys");
        } else {
          base.select("label", "classInfo", "file");
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
            // No usable sections: fall back to per-node snippets for all selected nodes.
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
