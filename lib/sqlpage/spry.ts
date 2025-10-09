#!/usr/bin/env -S deno run -A

import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { HelpCommand } from "jsr:@cliffy/command@1.0.0-rc.8/help";
import { ensureDir } from "jsr:@std/fs@^1";
import { dirname } from "jsr:@std/path@^1";
import { SqlPageNotebook } from "./notebook.ts";

export class CLI {
  constructor(readonly spn = SqlPageNotebook.instance()) {
  }

  async run(argv: string[] = Deno.args) {
    await new Command()
      .name("codebook.ts")
      .version("0.1.0")
      .description(
        "SQLPage Markdown Notebook: emit SQL package, write sqlpage.json, or materialize filesystem.",
      )
      // Emit SQL package (sqlite) to stdout; accepts md path
      .option("-m, --md <mdPath:string>", "Use the given Markdown source", {
        required: true,
        collect: true,
      })
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
