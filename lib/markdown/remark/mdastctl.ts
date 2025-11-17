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

import type { Heading, RootContent } from "npm:@types/mdast@^4";

import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";

import {
  buildMdAstTabularRows,
  buildMdAstTreeRows,
  selectNodes,
  type TabularRow,
  type TreeRow,
} from "./mdast-view.ts";

import {
  computeSectionRangesForHeadings,
  readMarkdownTrees,
  resolveFiles,
  sliceSourceForNode,
} from "./mdast-io.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import { doctor } from "../../universal/doctor.ts";

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

export class CLI {
  constructor(
    readonly conf?: {
      readonly ensureGlobalFiles?: string[]; // load these markdown files/remotes before CLI arguments or error if not available
      readonly optionalGlobalFiles?: string[]; // TODO: load these if available, skip otherwise
      readonly defaultFiles?: string[]; // load these markdown files/remotes when no CLI arguments given
      readonly cmdName?: string; // the cmd name to show as the CLI entry point in help
    },
  ) {
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name(this.conf?.cmdName ?? "mdastctl.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`query and explore Markdown ASTs (mdast)`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("ls", this.lsCommand())
      .command("identifiers", this.identifiersCommand())
      .command("tree", this.treeCommand())
      .command("class", this.classCommand())
      .command("schema", this.schemaCommand())
      .command("md", this.mdCommand())
      .command("doctor", this.doctorCommand());
  }

  protected doctorCommand() {
    return new Command().name("doctor").description(
      "Show dependencies and their availability",
    ).action(async () => {
      const diags = doctor(["deno --version", "sqlpage --version"]);
      const result = await diags.run();
      diags.render.cli(result);
    });
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const { cmdName = "mdastctl.ts", defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from stdin",
        `${cmdName} ${examplesCmd} -`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./Qualityfolio.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://qualityfolio.dev/example.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./Qualityfolio.md https://qualityfolio.dev/example.md local.md`,
      );
  }

  // -------------------------------------------------------------------------
  // ls command (tabular "physical" view)
  // -------------------------------------------------------------------------

  /**
   * `ls` – list mdast nodes in a tabular, content-hierarchy-friendly way.
   *
   * - By default: includes every node in the tree.
   * - With `--select <expr>`: only nodes matching that mdastql expression.
   * - With `--data`: adds a DATA column showing `Object.keys(node.data)`.
   * - With automatic node classification (via frontmatter + nodeClassifier),
   *   shows a CLASS column with key:value pairs.
   */
  protected lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName })
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
          const files = resolveFiles(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          );
          const trees = await readMarkdownTrees(files);
          const allRows: TabularRow[] = [];

          for (const pmt of trees) {
            const rows = buildMdAstTabularRows("physical", pmt, {
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

          const builder = new ListerBuilder<TabularRow>()
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
              "supplier",
              "identity",
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

          const ids: Array<keyof TabularRow & string> = [
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
  // identifiers command (tabular "identifiers" view)
  // -------------------------------------------------------------------------

  /**
   * `identifiers` – list mdast node identities in a tabular view.
   *
   * - Only nodes with identities are included.
   * - One row per (node, SUPPLIER, ID) tuple.
   * - Includes the same physical columns as `ls` plus SUPPLIER and ID.
   */
  protected identifiersCommand(cmdName = "identifiers") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `list mdast node identifiers (one row per SUPPLIER / ID pair)`,
      )
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (default: every node with identities).",
      )
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const files = resolveFiles(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          );
          const trees = await readMarkdownTrees(files);
          const allRows: TabularRow[] = [];

          for (const pmt of trees) {
            const rows = buildMdAstTabularRows("identifiers", pmt, {
              includeDataKeys: !!options.data,
              query: options.select,
            });
            allRows.push(...rows);
          }

          if (allRows.length === 0) {
            console.log(gray("No nodes with identifiers to show."));
            return;
          }

          const useColor = options.color;

          const builder = new ListerBuilder<TabularRow>()
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
              "supplier",
              "identity",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.numeric("id", (r) => r.id, {
            header: "ROW",
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
          builder.field("supplier", "supplier", {
            header: "SUPPLIER",
            defaultColor: cyan,
          });
          builder.field("identity", "identity", {
            header: "ID",
            defaultColor: yellow,
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

          const ids: Array<keyof TabularRow & string> = [
            "id",
            "file",
            "supplier",
            "identity",
            "name",
            "type",
            "depth",
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

  protected treeCommand(cmdName = "tree") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`heading/content hierarchy (per file)`)
      .arguments("[paths...:string]")
      .option("--select <query:string>", "mdastql selection to focus the tree.")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(
          this.conf?.ensureGlobalFiles,
          paths,
          this.conf?.defaultFiles ?? [],
        );
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
          .declareColumns(
            "label",
            "type",
            "file",
            "identityInfo",
            "classInfo",
            "dataKeys",
          )
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
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
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
          base.select(
            "label",
            "type",
            "identityInfo",
            "classInfo",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "type", "identityInfo", "classInfo", "file");
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

  protected classCommand(cmdName = "class") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `show classification hierarchy per file (class key → value → nodes)`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(
          this.conf?.ensureGlobalFiles,
          paths,
          this.conf?.defaultFiles ?? [],
        );
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
          .declareColumns(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          )
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        // Identity color so pre-colored labels are preserved
        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s) => s,
        });
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
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
          base.select(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "identityInfo", "classInfo", "type", "file");
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

  protected schemaCommand(cmdName = "schema") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `show section schema hierarchy (per file) using documentSchema plugin`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const files = resolveFiles(
          this.conf?.ensureGlobalFiles,
          paths,
          this.conf?.defaultFiles ?? [],
        );
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
          .declareColumns(
            "label",
            "type",
            "file",
            "identityInfo",
            "classInfo",
            "dataKeys",
          )
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
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
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
          base.select(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "identityInfo", "classInfo", "file");
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

  protected mdCommand(cmdName = "md") {
    return this.baseCommand({ examplesCmd: cmdName })
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

        const files = resolveFiles(
          this.conf?.ensureGlobalFiles,
          paths,
          this.conf?.defaultFiles ?? [],
        );
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
  await new CLI().run();
}
