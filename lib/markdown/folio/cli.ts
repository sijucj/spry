import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import {
  blue,
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  yellow,
} from "jsr:@std/fmt@1/colors";

import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import {
  type DepthRoleMap,
  type Folio,
  parseOne,
  type Row as FolioRow,
  tabularFolio,
} from "./folio.ts";

export class CLI<Project> {
  constructor(readonly project: Project) {
  }

  lsCmd() {
    /** Color palette by heading depth (1..6). */
    const colorByDepth: Record<number, (s: string) => string> = {
      1: (s) => bold(magenta(s)),
      2: (s) => bold(green(s)),
      3: (s) => bold(blue(s)),
      4: yellow,
      5: cyan,
      6: gray,
    };

    /** Get heading depth for a tabular row (ancestor vs leaf). */
    function depthOf<P>(r: FolioRow<P>): number {
      return r.kind === "ancestor" ? r.heading.depth : r.leaf.heading.depth;
    }

    /**
     * Build depth→role mapping by projecting with the frontmatter schema.
     * We infer the depth for each role by matching a leaf's role title to
     * the heading chain (trail + leaf heading).
     */
    function buildDepthToRole<
      FM extends Record<string, unknown> = Record<string, unknown>,
      P = string,
    >(
      folio: Folio<FM, P>,
    ): Map<number, string> {
      const view = folio.withSchema(
        "qualityfolio.schema" as unknown as DepthRoleMap,
      );
      const leafViews = view.all();

      const allRoleNames = new Set<string>();
      for (const lv of leafViews) {
        for (const k of Object.keys(lv.roles)) allRoleNames.add(k);
      }

      const roleToDepth = new Map<string, number>();
      for (const role of allRoleNames) {
        const lv = leafViews.find((x) =>
          x.roles[role as keyof typeof x.roles] !== undefined
        );
        if (!lv) continue;
        const title = lv.roles[role as keyof typeof lv.roles];
        if (!title) continue;
        const chain = [...lv.leaf.trail, lv.leaf.heading];
        const found = chain.find((h) => h.text.trim() === String(title).trim());
        if (found) roleToDepth.set(role, found.depth);
      }

      const depthToRole = new Map<number, string>();
      for (const [role, depth] of roleToDepth.entries()) {
        depthToRole.set(depth, role);
      }
      return depthToRole;
    }

    return new Command()
      .name("ls")
      .description(
        "List test cases and schema",
      )
      .option(
        "-md <file:string>",
        "Markdown file(s) to parse (repeatable)",
        { collect: true },
      )
      .option("--depth <n:number>", "Limit tree depth (1..7). Default: 7", {
        default: 7,
      })
      .action(async (opts) => {
        const files: string[] = opts.md?.length ? opts.md : ["Qualityfolio.md"];
        const limit = Math.max(1, Math.min(7, Number(opts.depth) || 7));

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const md = await Deno.readTextFile(file);
          const folio = await parseOne(file, md);

          // Rows from tabular() (frontmatter-aware)
          const rows = tabularFolio(folio, "qualityfolio.schema");

          // Depth→role mapping for TYPE column (not for colors)
          const depthToRole = buildDepthToRole(folio);

          // Build the TUI table
          const base = new ListerBuilder<FolioRow<string>>()
            .from(rows)
            .field("name", "name", {
              header: "NAME",
              rules: [
                { when: (_v, r) => depthOf(r) === 1, color: colorByDepth[1] },
                { when: (_v, r) => depthOf(r) === 2, color: colorByDepth[2] },
                { when: (_v, r) => depthOf(r) === 3, color: colorByDepth[3] },
                { when: (_v, r) => depthOf(r) === 4, color: colorByDepth[4] },
                { when: (_v, r) => depthOf(r) === 5, color: colorByDepth[5] },
                { when: (_v, r) => depthOf(r) >= 6, color: colorByDepth[6] },
              ],
            })
            .field("type", "kind", {
              header: "TYPE",
              defaultColor: gray,
              format: (_val, row) =>
                depthToRole.get(depthOf(row)) ?? `L${depthOf(row)}`,
            })
            .field("where", "where", {
              header: "WHERE",
              defaultColor: dim,
            })
            .select("name", "type", "where")
            .compact(false)
            .color(true)
            .header(true);

          // Render a tree on NAME, with "::" separator from tabular() paths
          const tree = TreeLister
            .wrap(base)
            .from(rows)
            .byPath({ pathKey: "path", separator: "::" })
            .treeOn("name")
            .dirFirst(true)
            .max(limit);

          await tree.ls(true);
          if (i < files.length - 1) console.log();
        }
      });
  }

  command(name: string) {
    return new Command()
      .name(name)
      .version(() => computeSemVerSync(import.meta.url))
      .description("Qualityfolio CLI")
      .command("qf", new Command().command("ls", this.lsCmd()));
  }

  async run(argv: string[] = Deno.args, name = "spry.ts") {
    await this.command(name).parse(argv);
  }

  static instance<Project>(project: Project = {} as Project) {
    return new CLI<Project>(project);
  }
}
