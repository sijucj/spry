/**
 * Markdown File System (MDFS)
 * ===========================
 *
 * This module treats **one or more Markdown files as a virtual file system**:
 *
 * - Each physical `.md` file is a **top-level directory tree**.
 * - Each heading (`#`, `##`, `###`, …) is a **directory / folder**.
 * - Each block of content under a heading (paragraph, fenced code, list, etc.)
 *   is a **content file**.
 *
 * The result is a **schema-free but strongly structured view** over Markdown
 * that you can:
 *
 * - Traverse like a tree (ROOT → H1 → H2 → …).
 * - Query by “path” (`projects/etl/Data Cleaning/Rules`).
 * - Enrich later with schemas (frontmatter, natures, roles) *without*
 *   changing the underlying parse.
 *
 * Core ideas
 * ----------
 *
 * - **MdfsFileRoot**: the parsed view of a single Markdown file
 *   (`physicalPath`, `rootDir`, `dirsByPath`, `filesByPath`, `mdast`).
 *
 * - **MdfsDir**: a directory / heading node with:
 *   - `title`, `level`, `headingPath`
 *   - `fullPath` (physical path + heading titles)
 *   - `metadata` / `ownMetadata` (DirMeta, inheritable later)
 *   - `children`, `content`, `parent`
 *   - `startLine`, `endLine` for source mapping
 *
 * - **MdfsContentFile**: a content “file” under a directory:
 *   - `id` (`dirPath` + `localName`)
 *   - `fullPath`
 *   - `kind` (semantic kind, e.g. `"FenceCell"`, `"TestCase"`, `"DocSection"`)
 *   - `language` (for code fences)
 *   - `attrs`, `metadata`, optional `payload`
 *   - `rawNodes`: the underlying mdast nodes
 *   - `startLine`, `endLine`
 *
 * - **MdfsSet**: union of many `MdfsFileRoot` into a cross-file MDFS
 *   (`dirsByPath` and `filesByPath` across the entire corpus).
 *
 * Importantly, the base layer is **schema-free**:
 *
 * - No built-in assumptions about what headings means.
 * - Just Markdown → typed tree + indices.
 *
 * You layer any meaning you want on top.
 *
 * Basic usage
 * -----------
 *
 * Parse a single Markdown file:
 *
 * @example
 * ```ts
 * import { parseMdfsFile } from "./mdfs.ts";
 *
 * const source = await Deno.readTextFile("Qualityfolio.md");
 * const root = parseMdfsFile("Qualityfolio.md", source);
 *
 * console.log(root.physicalPath);          // "Qualityfolio.md"
 * console.log(root.rootDir.children.length); // Number of top-level H1s
 * ```
 *
 * Traverse directories and files:
 *
 * @example
 * ```ts
 * function walkDir(dir: MdfsDir, indent = "") {
 *   console.log(indent + `[DIR] ${dir.title} (L${dir.level})`);
 *
 *   for (const file of dir.content) {
 *     console.log(
 *       indent +
 *         `  [FILE] ${file.id.localName} @ ${file.startLine ?? "?"} (${file.kind})`,
 *     );
 *   }
 *
 *   for (const child of dir.children) {
 *     walkDir(child, indent + "  ");
 *   }
 * }
 *
 * walkDir(root.rootDir);
 * ```
 *
 * Capabilities
 * ------------
 *
 * **Stable, queryable paths**
 *
 * Every directory and content “file” has a **canonical path**:
 *
 * - Directories: physical path (without `.md`) + heading titles
 *   e.g. `"Qualityfolio/E2E1 End-to-End Qualityfolio/Accounts & Auth E2E Suite"`.
 *
 * - Content files: directory path + logical file name
 *   e.g. `"Qualityfolio/.../E2E Account Creation Plan/block-3"`.
 *
 * This makes it easy to:
 *
 * - Build CLIs and TUIs that show a consistent tree (e.g. with a `::` separator).
 * - Store references in SQLite / Postgres tables and join them later.
 * - Jump from “where in the doc” to “what code/SQL executed here”.
 *
 * **First-class frontmatter and mdast**
 *
 * `MdfsFileRoot` carries:
 *
 * - `mdast`: the full mdast `Root` which also has the typed frontmatter using
 *   docFrontmatter plugin.
 */
import type { Code, Heading, Root, RootContent } from "npm:@types/mdast@^4";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import { remark } from "npm:remark@^15";

import docFrontmatter from "../remark/doc-frontmatter.ts";
import enrichedCode, {
  ENRICHED_CODE_STORE_KEY,
  EnrichedCode,
  isEnrichedCodeNode,
} from "../remark/enriched-code.ts";
import headingFrontmatter from "../remark/heading-frontmatter.ts";

/** POSIX-style physical path to a markdown file, e.g. "projects/etl/pipeline.md" */
export type MdfsPhysicalPath = string;

/**
 * A single heading segment in the markdown path.
 * For ROOT (pre-heading area), level = 0 and title/slug may be synthetic.
 */
export interface MdfsHeadingSegment {
  /** Heading level: 0 for ROOT, 1 for "#", 2 for "##", etc. */
  readonly level: number;

  /** Raw heading text as written in the markdown */
  readonly title: string;

  /** Slugified form for use in URLs or IDs. */
  readonly slug: string;
}

/**
 * Logical markdown path from ROOT down to a directory.
 * Example (# Project > ## Strategy > ### Plan):
 *
 * [
 *   { level: 1, title: "Project",  ... },
 *   { level: 2, title: "Strategy", ... },
 *   { level: 3, title: "Plan",     ... }
 * ]
 */
export type MdfsHeadingPath = readonly MdfsHeadingSegment[];

/**
 * Full directory path string in the MDFS.
 *
 * Convention: physical path (sans ".md") + heading chain, e.g.:
 *   "projects/healthlake/etl/pipeline/Data Cleaning/Rules"
 */
export type MdfsFullDirPath = string;

/**
 * Full content "file" path string in the MDFS.
 *
 * Convention: directory path + local content file name, e.g.:
 *   "projects/healthlake/etl/pipeline/Data Cleaning/Rules/001.sql-migration"
 */
export type MdfsFullFilePath = string;

//
// Directories
//

/**
 * A directory (folder) in the MDFS.
 * This corresponds to:
 *   - ROOT (pre-heading content), or
 *   - a markdown heading (#, ##, ###, etc.)
 */
export interface MdfsDir {
  /** the mdast heading we're treating as a directory */
  readonly heading: Heading;

  /** Physical markdown file where this directory lives. */
  readonly physicalPath: MdfsPhysicalPath;

  /**
   * Logical markdown heading path from ROOT down to this directory.
   * For ROOT, typically an empty array or a single level-0 synthetic segment.
   */
  readonly headingPath: MdfsHeadingPath;

  /** Full canonical path string combining physical path and heading chain. */
  readonly fullPath: MdfsFullDirPath;

  /** Heading text of this directory (empty or synthetic for ROOT). */
  readonly title: string;

  /** Heading level (0 = ROOT, 1 = "#", etc). */
  readonly level: number;

  /** 1-based line in source where this directory's heading starts (ROOT ~ 1). */
  readonly startLine?: number;

  /** 1-based line where this directory's heading ends. */
  readonly endLine?: number;

  /** Parent directory, or undefined if this is the file's root directory. */
  readonly parent?: MdfsDir;

  /** Child directories (subheadings). */
  readonly children: readonly MdfsDir[];

  /**
   * Content files that belong directly to this directory
   * and not to its subdirectories.
   */
  readonly content: readonly MdfsContentFile[];
}

//
// Content files
//

/**
 * Identifier for a content file within the MDFS.
 * Combines the parent directory path and a local name.
 *
 * This is the *canonical* identity; semantic IDs for the content file
 * are exposed separately as `ids` on MdfsContentFile.
 */
export interface MdfsFileId {
  readonly dirPath: MdfsFullDirPath;
  readonly localName: string; // e.g. "001", "doc-1", "test-case-signup"
}

/**
 * Base shape for a parsed content file (a "file" / "content" inside a folder).
 * You can layer specific typing via generics in higher-level APIs.
 */
export type MdfsContentFileBase = {
  /**
   * Nature of this content, typically the underlying mdast `type`
   * (e.g. "code", "paragraph", "list", "thematicBreak").
   *
   * This can be used as the discriminator of a discriminated union.
   */
  readonly nature: string;

  /** Canonical ID for this content file, including its directory. */
  readonly id: MdfsFileId;

  /** Full canonical path string for this markdown element. */
  readonly fullPath: MdfsFullFilePath;

  /** Reference to the parent directory node. */
  readonly dir: MdfsDir;

  /** Errors encountered while parsing or validating this file's payload. */
  readonly errors?: readonly Error[];

  /**
   * 1-based line numbers in the source markdown file
   * where this content begins/ends.
   */
  readonly startLine?: number;
  readonly endLine?: number;

  /**
   * Underlying mdast node representing this content file.
   * For stronger typing, set TRawNode to RootContent or your own union.
   */
  readonly rawNode: RootContent;
};

/**
 * Discrimated union for a parsed content file (a "file" / "content" inside a folder).
 * You can layer specific typing via generics in higher-level APIs.
 */
export type MdfsContentFile =
  | MdfsContentFileBase
  | (MdfsContentFileBase & {
    readonly nature: "code";
    readonly rawNode: Code;
    readonly ec: EnrichedCode;
  });

//
// Per-markdown-file root & MDFS set
//

// governance.ts — only the bottom part changes

/**
 * A single parsed markdown file within the broader MDFS set.
 * It owns a small directory tree rooted at its ROOT directory.
 *
 * TRawAst      — full mdast Root (or any AST type you choose)
 */
export interface MdfsFileRoot {
  /** Physical path to the markdown file. */
  readonly physicalPath: MdfsPhysicalPath;

  /**
   * Root directory representing content before the first heading,
   * or a synthetic ROOT node representing the entire file tree.
   */
  readonly rootDir: MdfsDir;

  /** Convenience index of all directories in this file by fullPath. */
  readonly dirsByPath: ReadonlyMap<MdfsFullDirPath, MdfsDir>;

  /** Convenience index of all content files in this file by fullPath. */
  readonly filesByPath: ReadonlyMap<MdfsFullFilePath, MdfsContentFile>;

  /** Full mdast tree for this markdown file (e.g. Root from @types/mdast). */
  readonly mdast: Root;
}

/**
 * A complete MDFS view across multiple markdown files.
 * This is what you get after scanning many .md files and
 * building a unified semantic tree/index.
 */
export interface MdfsSet {
  /** All markdown files that were scanned. */
  readonly files: readonly MdfsFileRoot[];

  /** Global directory index across all files. */
  readonly dirsByPath: ReadonlyMap<MdfsFullDirPath, MdfsDir>;

  /** Global content file index across all files. */
  readonly filesByPath: ReadonlyMap<MdfsFullFilePath, MdfsContentFile>;
}

/**
 * Internal state we track while walking one markdown file.
 */
export interface DirState {
  dir: MdfsDir;
  headingPath: MdfsHeadingPath;
  children: MdfsDir[];
  content: MdfsContentFile[];
  fileIndex: number;
}

export function typicalHeadingSegment(
  node: Heading,
  slugify: (input: string) => string,
) {
  const title = mdToString(node).trim();
  const slug = slugify(title);

  return {
    level: node.depth,
    title,
    slug,
  } satisfies MdfsHeadingSegment;
}

export function typicalSlugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/\s+/g, "-");
}

export function typicalFsPath(path: string): string {
  return path.replace(/\.md$/i, "");
}

/**
 * Build a directory fullPath from basePath and headingPath titles.
 * Example:
 *   basePath = "projects/etl/pipeline"
 *   headingPath titles = ["Data Cleaning", "Rules"]
 *   → "projects/etl/pipeline/Data Cleaning/Rules"
 */
function typicalDirPath(basePath: string, path: MdfsHeadingPath) {
  if (path.length === 0) return `${basePath}/ROOT`;
  const parts = path.map((seg) => seg.title);
  return `${basePath}/${parts.join("/")}` satisfies MdfsFullDirPath;
}

/**
 * Build a structural MdfsContentFile for a single block node.
 */
function typicalContentFile(state: DirState, rawNode: RootContent) {
  const { dir } = state;
  const localName = `block-${state.fileIndex + 1}`;
  state.fileIndex++;

  const fullPath: MdfsFullFilePath = `${dir.fullPath}/${localName}`;

  const startLine = rawNode.position?.start.line;
  const endLine = rawNode.position?.end.line;
  const extra = isEnrichedCodeNode(rawNode)
    ? { ec: rawNode.data[ENRICHED_CODE_STORE_KEY] }
    : {};

  const contentFile: MdfsContentFile = {
    nature: rawNode.type,
    id: {
      dirPath: dir.fullPath,
      localName,
    },
    fullPath,
    dir,
    errors: undefined,
    startLine,
    endLine,
    rawNode,
    ...extra,
  };

  return contentFile;
}

export const ID_ANN = "id" as const;

/**
 * Core entry point: parse a single markdown source into an MDFS file root.
 *
 * Schema-free:
 *  - Builds directory tree and content files.
 *  - Exposes the full mdast Root via `mdast`.
 */
export async function parseMdfsFile(
  physicalPath: MdfsPhysicalPath,
  source: string,
  options?: {
    readonly processor?: ReturnType<typeof remark>;
    readonly fsPath?: (path: string) => string;
    readonly slugify?: (input: string) => string;
    readonly headingSegment?: (node: Heading) => MdfsHeadingSegment;
    readonly dirPath?: (
      basePath: string,
      path: MdfsHeadingPath,
    ) => MdfsFullDirPath;
    readonly contentFile?: (
      state: DirState,
      rawNode: RootContent,
    ) => MdfsContentFile;
  },
) {
  const {
    processor = remark()
      .use(remarkFrontmatter, ["yaml"])
      .use(docFrontmatter)
      .use(remarkGfm)
      .use(headingFrontmatter)
      .use(enrichedCode, {
        coerceNumbers: true, // "9" -> 9
        onAttrsParseError: "ignore", // ignore invalid JSON5 instead of throwing
      }),
    fsPath = typicalFsPath,
    headingSegment = typicalHeadingSegment,
    slugify = typicalSlugify,
    dirPath = typicalDirPath,
    contentFile = typicalContentFile,
  } = options ?? {};

  const tree = processor.parse(source) as Root;
  await processor.run(tree);

  const children = tree.children;
  const basePath = fsPath(physicalPath);

  // ROOT directory
  const rootHeadingPath: MdfsHeadingPath = [];
  const rootChildren: MdfsDir[] = [];
  const rootContent: MdfsContentFile[] = [];

  const rootDir: MdfsDir = {
    heading: { type: "heading", depth: 1, children: [] },
    physicalPath,
    headingPath: rootHeadingPath,
    fullPath: `${basePath}/ROOT`,
    title: "ROOT",
    level: 0,
    parent: undefined,
    children: rootChildren,
    content: rootContent,
    startLine: 1,
    endLine: undefined,
  };

  const dirsByPath = new Map<MdfsFullDirPath, MdfsDir>();
  const filesByPath = new Map<MdfsFullFilePath, MdfsContentFile>();

  dirsByPath.set(rootDir.fullPath, rootDir);

  const rootState: DirState = {
    dir: rootDir,
    headingPath: rootHeadingPath,
    children: rootChildren,
    content: rootContent,
    fileIndex: 0,
  };

  const dirStack: DirState[] = [rootState];

  for (const node of children) {
    if (node.type === "heading") {
      const headingNode = node as Heading;

      // Pop until we find a parent with smaller level.
      while (
        dirStack.length > 0 &&
        dirStack[dirStack.length - 1].dir.level >= headingNode.depth
      ) {
        dirStack.pop();
      }
      const parentState = dirStack[dirStack.length - 1] ?? rootState;

      const segment = headingSegment(headingNode, slugify);
      const headingPath: MdfsHeadingPath = [
        ...parentState.headingPath,
        segment,
      ];

      const childrenArr: MdfsDir[] = [];
      const contentArr: MdfsContentFile[] = [];
      const dirFullPath = dirPath(basePath, headingPath);

      const startLine = headingNode.position?.start.line;
      const endLine = headingNode.position?.end.line;

      const dir: MdfsDir = {
        heading: node,
        physicalPath,
        headingPath,
        fullPath: dirFullPath,
        title: segment.title,
        level: segment.level,
        parent: parentState.dir,
        children: childrenArr,
        content: contentArr,
        startLine,
        endLine,
      };

      const state: DirState = {
        dir,
        headingPath,
        children: childrenArr,
        content: contentArr,
        fileIndex: 0,
      };

      parentState.children.push(dir);
      dirsByPath.set(dirFullPath, dir);
      dirStack.push(state);
    } else {
      // Non-heading content belongs to current directory.
      const currentState = dirStack[dirStack.length - 1] ?? rootState;
      const cf = contentFile(currentState, node);
      currentState.content.push(cf);
      filesByPath.set(cf.fullPath, cf);
    }
  }

  return {
    physicalPath,
    rootDir,
    dirsByPath,
    filesByPath,
    mdast: tree,
  } satisfies MdfsFileRoot;
}
