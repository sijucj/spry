// cli.ts — CLI for browsing MDFS markdown files as a tree.
//
// Usage:
//   deno run -A cli.ts mdfs ls -md ./mod_test-fixture-01.md
//
// This is schema-free: only headings + content, no nature mapping.

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

import { isHeadingWithFrontmatter } from "../remark/heading-frontmatter.ts";
import {
  type MdfsContentFile,
  type MdfsDir,
  type MdfsFileRoot,
  parseMdfsFile,
} from "./mdfs.ts";
import { isCodeWithFrontmatterNode } from "../remark/code-frontmatter.ts";
/**
 * Row model for tabular/tree display.
 *
 * depth  — logical depth in the MDFS tree (ROOT=0, H1=1, etc.)
 * kind   — "dir" for headings, "file" for content
 * name   — directory title or content label
 * path   — logical path using "::" separator for TreeLister
 * where  — physical location hint: "file.md:line"
 */
export interface MdfsRow {
  readonly depth: number;
  readonly kind: "dir" | "file";
  readonly hFrontmatter?: Record<string, unknown>;
  readonly name: string;
  readonly path: string;
  readonly where: string;
  readonly id?: string; // first @id for DIR (for now)
  readonly astType?: string; // mdast node.type for FILE
  readonly dir?: MdfsDir;
  readonly file?: MdfsContentFile;
}

/**
 * Flatten an MdfsFileRoot into rows suitable for tree/table TUIs.
 *
 * - Directories become "dir" rows.
 * - Content files become "file" rows, nested under their parent directory path.
 */
export function tabularMdfs(root: MdfsFileRoot) {
  const rows: MdfsRow[] = [];

  function dirPathSegments(dir: MdfsDir): string[] {
    if (dir.level === 0) return ["ROOT"];
    const titles = dir.headingPath.map((s) => s.title);
    return titles.length ? titles : ["ROOT"];
  }

  function dirLogicalPath(dir: MdfsDir): string {
    return dirPathSegments(dir).join("::");
  }

  function whereForDir(dir: MdfsDir): string {
    const line = dir.startLine ?? 1;
    return `${root.physicalPath}:${line}`;
  }

  function whereForFile(file: MdfsContentFile): string {
    const line = file.startLine ?? 1;
    return `${file.dir.physicalPath}:${line}`;
  }

  function walk(dir: MdfsDir): void {
    const ids = isHeadingWithFrontmatter<{ id: string }>(dir.heading)
      ? dir.heading.data.hFrontmatter["id"]
      : "";

    // Directory row
    rows.push({
      depth: dir.level,
      kind: "dir",
      hFrontmatter: isHeadingWithFrontmatter<{ id: string }>(dir.heading)
        ? dir.heading.data.hFrontmatter
        : undefined,
      name: "📁 " + (dir.title || "ROOT"),
      path: dirLogicalPath(dir),
      where: whereForDir(dir),
      id: ids ? Array.isArray(ids) ? ids.join(", ") : String(ids) : "", // first @id if present
      astType: undefined,
      dir,
      file: undefined,
    });

    // Content rows
    for (const file of dir.content as MdfsContentFile[]) {
      const parentSegs = dirPathSegments(dir);
      const { rawNode } = file;
      const astType = rawNode.type;

      const fileName = astType
        ? `${
          isCodeWithFrontmatterNode(rawNode) ? "enriched-code" : astType
        } (${file.id.localName})`
        : file.id.localName;
      const logicalPath = [...parentSegs, fileName].join("::");

      rows.push({
        depth: dir.level + 1,
        kind: "file",
        name: "📄 " + fileName,
        path: logicalPath,
        where: whereForFile(file),
        id: undefined, // later we can surface file IDs if desired
        astType,
        dir,
        file,
      });
    }

    // Recurse into children
    for (const child of dir.children) {
      walk(child);
    }
  }

  walk(root.rootDir);
  return rows;
}

export class CLI<Project> {
  constructor(readonly project: Project) {}

  lsCmd() {
    /** Color palette by logical depth (0..6+). */
    const colorByDepth: Record<number, (s: string) => string> = {
      0: (s) => bold(magenta(s)), // ROOT
      1: (s) => bold(magenta(s)),
      2: (s) => bold(green(s)),
      3: (s) => bold(blue(s)),
      4: yellow,
      5: cyan,
      6: gray,
    };

    function depthColor(depth: number): (s: string) => string {
      if (depth <= 1) return colorByDepth[1];
      if (depth === 2) return colorByDepth[2];
      if (depth === 3) return colorByDepth[3];
      if (depth === 4) return colorByDepth[4];
      if (depth === 5) return colorByDepth[5];
      return colorByDepth[6];
    }

    return new Command()
      .name("ls")
      .description("List headings and content of MDFS markdown as a tree")
      .option(
        "--md <file:string>",
        "Markdown file(s) to parse (repeatable)",
        { collect: true },
      )
      .option(
        "--depth <n:number>",
        "Limit tree depth (0..7). Default: 7",
        { default: 7 },
      )
      .action(async (opts) => {
        const files = opts.md?.length
          ? opts.md
          : (await Array.fromAsync(Deno.readDir(".")))
            .filter((e) => e.isFile && e.name.endsWith(".md"))
            .filter((e) => e.name !== "README.md")
            .map((e) => e.name);
        const limit = Math.max(0, Math.min(7, Number(opts.depth) || 7));

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const md = await Deno.readTextFile(file);
          const mdfsRoot = await parseMdfsFile(file, md);

          const rows = tabularMdfs(mdfsRoot);

          const base = new ListerBuilder<MdfsRow>()
            .from(rows)
            .field("name", "name", {
              header: "NAME",
              rules: [
                {
                  when: (_v, r) => r.kind === "dir",
                  color: (s, r) => depthColor(r.depth)(s),
                },
                {
                  when: (_v, r) => r.kind === "file",
                  color: (s) => dim(s),
                },
              ],
            })
            .field("type", "kind", {
              header: "TYPE",
              defaultColor: gray,
              format: (_, r) => r.astType ?? "",
            })
            .field("id", "id", {
              header: "ID",
              defaultColor: dim,
              format: (val) => val ?? "",
            })
            .field("hFrontmatter", "hFrontmatter", {
              header: "HFM",
              defaultColor: dim,
              format: (val) => val ? String(Object.keys(val).length) : "",
            })
            .field("where", "where", {
              header: "WHERE",
              defaultColor: dim,
            })
            .select("name", "id", "hFrontmatter", "where")
            .compact(false)
            .color(true)
            .icon((r) => (r.dir ? "📁" : "📄"))
            .header(true);

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
      .description("MDFS CLI")
      .command("mdfs", new Command().command("ls", this.lsCmd()));
  }

  async run(argv: string[] = Deno.args, name = "spry.ts") {
    await this.command(name).parse(argv);
  }

  static instance<Project>(project: Project = {} as Project) {
    return new CLI<Project>(project);
  }
}
