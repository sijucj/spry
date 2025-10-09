#!/usr/bin/env -S deno run -A

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { ensureDir } from "jsr:@std/fs@^1";
import { dirname, relative } from "jsr:@std/path@^1";
import { SqlPageNotebook } from "./notebook.ts";
import {
  bold,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "jsr:@std/fmt@^1/colors";
import { ColumnDef, ListerBuilder } from "../universal/lister-tabular-tui.ts";
import { SqlPageFile } from "./notebook.ts";
import { TreeLister } from "../universal/lister-tree-tui.ts";
import { basename } from "node:path";

export type LsCommandRow = SqlPageFile & { name: string };

/**
 * Ensure all ancestor directories exist as rows.
 * - items: your existing rows (any shape)
 * - pathOf: how to extract a path string from a row
 * - makeRow: how to create a row for a missing directory, given its path
 * - isFile (optional): how to decide if a path is a file; defaults to "last segment contains a dot"
 */
export function upsertMissingAncestors<T>(
  items: T[],
  pathOf: (item: T) => string,
  makeRow: (dirPath: string) => T,
  isFile: (path: string) => boolean = (p) => {
    const segs = p.split("/").filter(Boolean);
    return segs.length > 0 && segs[segs.length - 1].includes(".");
  },
): T[] {
  const seen = new Set(items.map(pathOf));
  const out = [...items];

  for (const item of items) {
    const p = pathOf(item);
    const segs = p.split("/").filter(Boolean);
    const max = isFile(p) ? segs.length - 1 : segs.length;

    for (let i = 1; i <= max; i++) {
      const dirPath = segs.slice(0, i).join("/");
      if (!seen.has(dirPath)) {
        out.push(makeRow(dirPath));
        seen.add(dirPath);
      }
    }
  }
  return out;
}

export class CLI {
  constructor(readonly spn = SqlPageNotebook.instance()) {
  }

  // deno-lint-ignore no-explicit-any
  lsColorPathField(): Partial<ColumnDef<any, string>> {
    return {
      header: "Path",
      format: (supplied) => {
        const p = relative(Deno.cwd(), supplied);
        const i = p.lastIndexOf("/");
        return i < 0 ? bold(p) : gray(p.slice(0, i + 1)) + bold(p.slice(i + 1));
      },
      rules: [{
        when: (_v, r) => (r.error?.trim().length ?? 0) > 0,
        color: red,
      }],
    };
  }

  lsNaturePathField<Row extends LsCommandRow>(): Partial<
    ColumnDef<Row, string>
  > {
    const lscpf = this.lsColorPathField();
    return {
      ...lscpf,
      rules: [...(lscpf.rules ? lscpf.rules : []), {
        when: (_v, r) =>
          r.kind === "sqlpage_file_upsert" && r.name.indexOf(".auto.") == -1,
        color: brightYellow,
      }],
    };
  }

  lsNatureField<Row extends LsCommandRow>(): Partial<
    ColumnDef<Row, Row["kind"]>
  > {
    return {
      header: "Nature",
      format: (v) =>
        v === "head_sql"
          ? green(v)
          : v === "tail_sql"
          ? yellow(v)
          : v === "sqlpage_file_upsert"
          ? brightYellow(v)
          : cyan(v),
    };
  }

  async ls(opts: { md: string[]; conf?: boolean; tree?: boolean }) {
    let spfe = (await Array.fromAsync(this.spn.finalSqlPageFileEntries(opts)))
      .map((spf) => ({ ...spf, name: basename(spf.path) }));

    if (opts.tree) {
      spfe = upsertMissingAncestors<LsCommandRow>(
        spfe.map((r) => ({
          ...r,
          path: relative(Deno.cwd(), r.path),
        })),
        (r) => r.path,
        (path) => ({
          // deno-lint-ignore no-explicit-any
          kind: "virtual" as any,
          path,
          contents: "virtual",
          asErrorContents: () => "virtual",
          name: basename(path),
        }),
      );

      const base = new ListerBuilder<LsCommandRow>()
        .declareColumns("kind", "name")
        .from(spfe)
        .field("name", "name", this.lsNaturePathField())
        .field("kind", "kind", this.lsNatureField())
        // IMPORTANT: make the tree column first so glyphs appear next to it
        .select("name", "kind");
      const tree = TreeLister
        .wrap(base)
        .from(spfe)
        .byPath({ pathKey: "path", separator: "/" })
        .treeOn("name");
      await tree.ls(true);
    } else {
      await new ListerBuilder<LsCommandRow>()
        .declareColumns("kind", "path")
        .from(spfe)
        .field("kind", "kind", this.lsNatureField())
        .field("path", "path", this.lsNaturePathField())
        .sortBy("path").sortDir("asc")
        .build()
        .ls(true);
    }
  }

  async run(argv: string[] = Deno.args) {
    await new Command()
      .name("codebook.ts")
      .version("0.1.0")
      .description(
        "SQLPage Markdown Notebook: emit SQL package, write sqlpage.json, or materialize filesystem.",
      )
      // Emit SQL package (sqlite) to stdout; accepts md path
      .globalOption(
        "-m, --md <mdPath:string>",
        "Use the given Markdown source",
        {
          required: true,
          collect: true,
        },
      )
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option(
        "-p, --package",
        "Emit SQL package (sqlite) to stdout from the given markdown path.",
      )
      // Materialize files to a target directory
      .option(
        "--fs <srcHome:string>",
        "Materialize SQL files under this directory.",
      )
      // Write sqlpage.json to the given path
      .option(
        "-c, --conf <confPath:string>",
        "Write sqlpage.json to this path (generated from frontmatter sqlpage-conf).",
      )
      .action(async (opts) => {
        // If --fs is present, materialize files under that root
        if (typeof opts.fs === "string" && opts.fs.length > 0) {
          Array.fromAsync(this.spn.materializeFs({ md: opts.md, fs: opts.fs }));
        }

        // If -p/--package is present (i.e., user requested SQL package), emit to stdout
        if (opts.package) {
          for (
            const chunk of await this.spn.sqlPageFilesUpsertDML("sqlite", {
              md: opts.md,
              includeSqlPageFilesTable: true,
            })
          ) {
            console.log(chunk);
          }
        }

        // If --conf is present, write sqlpage.json
        if (opts.conf) {
          for await (const nb of this.spn.notebooks(opts)) {
            if (nb.fm["sqlpage-conf"]) {
              const json = this.spn.sqlPageConf(nb.fm["sqlpage-conf"]);
              await ensureDir(dirname(opts.conf));
              await Deno.writeTextFile(
                opts.conf,
                JSON.stringify(json, null, 2),
              );
              break; // only pick from the first file
            }
          }
        }
      })
      .command("ls", "List SQLPage file entries")
      .option("-t, --tree", "Show as tree")
      .action((opts) => this.ls(opts))
      .command("help", new HelpCommand().global())
      .parse(argv);
  }

  static instance() {
    return new CLI();
  }
}

if (import.meta.main) {
  CLI.instance().run();
}
