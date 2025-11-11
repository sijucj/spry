/**
 * @module folio
 *
 * `folio.ts` implements a **generic leaf-first Markdown hierarchy parser**
 * that converts plain GitHub-flavored Markdown documents into a rich,
 * queryable tree of `HeadingNode`s and `LeafNode`s.
 *
 * It was designed to power *Qualityfolio* and other "governed markdown"
 * systems where structured, test-like documents are written by humans
 * but later interpreted, queried, and validated by code.
 *
 * Unlike domain-specific parsers (e.g., for test cases or requirements),
 * this module is **schema-free** at parse time. It captures every heading,
 * annotation, fenced code block, and GFM task item, then lets you apply
 * a *schema later* to interpret the hierarchy in any domain.
 *
 * ## Why it exists
 *
 * Quality-assurance, validation, and documentation teams often write
 * nested Markdown like:
 *
 * ```md
 * # Project A
 * ## Suite: Authentication
 * ### Plan: Sign-Up Flow
 * #### Case: New user can sign up
 * - [x] Step 1 ...
 * - [ ] Step 2 ...
 * ```
 *
 * Traditional Markdown parsers return flat ASTs, losing the notion that
 * “leaf headings” (the deepest levels) are the real *test cases* or
 * *terminal nodes*. `folio.ts` restores that hierarchy:
 *
 * - Each **heading** becomes a `HeadingNode` with section range,
 *   inline annotations, and fenced code blocks.
 * - Each **terminal heading** (a heading whose section has no deeper
 *   subheadings) becomes a `LeafNode` with:
 *   - its ancestor trail,
 *   - its local Markdown/AST subset,
 *   - any GFM checkboxes (`- [ ]` / `- [x]`),
 *   - annotations and code blocks scoped to that leaf.
 *
 * The result is a document that can be programmatically analyzed,
 * grouped, and projected into higher-order semantics like
 * *project → suite → plan → case* hierarchies.
 *
 * ## Core Concepts
 *
 * - **Frontmatter parsing**: YAML frontmatter is parsed if present.
 * - **Annotations**: lines beginning with `@key value` in any heading’s
 *   own content are captured as key/value pairs.
 * - **Fenced code blocks**: every fenced block records language, metadata,
 *   value, and line range (`codesSelf`, `codesSection`).
 * - **GFM tasks**: list items with `[ ]` or `[x]` are captured as
 *   `TaskItem`s with `checked`, `text`, and line positions.
 * - **Schema-later projection**: caller supplies a mapping such as:
 *
 *   ```ts
 *   const v = folio.withSchema({
 *     h1: "project",
 *     h2: "suite",
 *     h3: "plan",
 *     h4: "case",
 *   } as const);
 *   ```
 *
 *   From there you can query by role:
 *
 *   ```ts
 *   v.atRole("case");           // → all case-level leaves
 *   v.groupBy("suite");         // → Map of suite name → case leaves
 *   v.all();                    // → all projected leaves
 *   ```
 *
 * - **Smart schema discovery**: `discoverSchema()` analyzes any document
 *   to infer which heading depths are actually structural (based on leaf
 *   trails) and recommends how to align them with a desired schema.
 *   `applyDiscoveredSchema()` runs discovery and applies the inferred
 *   mapping automatically.
 *
 * ## Typical Usage
 *
 * ```ts
 * import { parseOne } from "./folio.ts";
 *
 * const md = await Deno.readTextFile("e2e-test.qf.md");
 * const folio = await parseOne("e2e-test", md);
 *
 * // Apply a schema to interpret heading depths
 * const v = folio.withSchema({
 *   h1: "project",
 *   h2: "suite",
 *   h3: "plan",
 *   h4: "case",
 * } as const);
 *
 * // Query the resulting hierarchy
 * const allCases = v.atRole("case");
 * const groupedBySuite = v.groupBy("suite");
 *
 * // Find annotations and code cells
 * const planIds = folio.findHeadingsByAnnotation("id");
 * const yamlBlocks = folio.findCodeInHeadings({ lang: "yaml", depth: 3 });
 * ```
 *
 * ## Design Notes
 *
 * - Built on [`remark`](https://github.com/remarkjs/remark) for Markdown parsing.
 * - Uses `mdast` node types and standard position metadata.
 * - Integrates seamlessly with `governedmd.ts` utilities for provenance
 *   and issue tracking.
 * - The hierarchy is **terminal-first**: leaves are the primary units,
 *   ancestors are inferred by range containment.
 * - No domain semantics are baked in; "project/suite/plan/case"
 *   are merely conventions applied via `withSchema()`.
 *
 * ## API Highlights
 *
 * - `parseOne(provenance, source)` → `Folio` instance
 * - `folios(sourceStream)` → async generator over multiple inputs
 * - `Folio` methods:
 *   - `.headings()`, `.leaves()`, `.frontmatter()`, `.issues()`
 *   - `.findHeadingsByAnnotation(key, [value])`
 *   - `.findLeavesByAnnotation(key, [value])`
 *   - `.findCodeInHeadings({ lang?, depth?, scope? })`
 *   - `.withSchema(schema)` → query API (`all`, `atRole`, `groupBy`)
 * - `discoverSchema(docOrFolio, schema)` → suggests depth→role mapping
 * - `applyDiscoveredSchema(docOrFolio, schema)` → applies and returns both
 *   discovery + projected view
 *
 * ## When to Use
 *
 * Use this module whenever you need to treat Markdown documents as
 * **structured test artifacts**, **requirements folios**, or other
 * hierarchical records where:
 *
 * - Headings express containment,
 * - Checkboxes express validation or workflow state,
 * - Code blocks and annotations carry structured metadata.
 *
 * The parser provides a reliable, type-safe foundation for
 * converting Markdown into executable, queryable data.
 */
import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Root, RootContent } from "npm:@types/mdast@^4";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { remark } from "npm:remark@^15";

import {
  FrontmatterIssue,
  Issue,
  isYamlNode,
  normalizeSources,
  posEndLine,
  posStartLine,
  Source,
  SourceStream,
} from "../governedmd.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

// deno-lint-ignore no-explicit-any
type Any = any;

export type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;
export type Dict = Record<string, unknown>;

export interface CodeBlock {
  readonly lang?: string; // e.g., "yaml", "json5"
  readonly meta?: string | null; // fenced info string metadata (if any)
  readonly value: string; // code contents
  readonly startLine: number; // inclusive (0-based)
  readonly endLine: number; // exclusive
}

export interface HeadingNode {
  readonly index: number; // ordinal among headings
  readonly depth: HeadingDepth; // 1..6
  readonly text: string; // md text of the heading
  readonly startLine: number; // inclusive (0-based)
  readonly endLine: number; // exclusive (end of section)
  readonly sectionNodes: ReadonlyArray<RootContent>; // children in this section
  /** Annotations parsed from this heading's *own* content (before first child heading). */
  readonly annotations: Readonly<Record<string, string>>;
  /** Fenced code blocks found in *own* content (before first child heading). */
  readonly codesSelf: ReadonlyArray<CodeBlock>;
  /** Fenced code blocks found anywhere in the entire section (including descendants). */
  readonly codesSection: ReadonlyArray<CodeBlock>;
  readonly selfHasContent: boolean;
}

export interface TaskItem {
  readonly checked: boolean | null; // true | false for GFM tasks; null if absent
  readonly text: string; // plain text of the list item
  readonly startLine: number; // inclusive (0-based)
  readonly endLine: number; // exclusive
  // Optionally carry the original mdast node for advanced use:
  readonly node?: import("npm:@types/mdast@^4").ListItem;
}

export interface LeafNode {
  readonly heading: HeadingNode;
  readonly trail: ReadonlyArray<HeadingNode>;
  readonly text: string;
  readonly markdown: string;

  /** AST subset for the leaf’s OWN content (no child headings). */
  readonly nodes: ReadonlyArray<RootContent>;
  /** Convenience root to pass to mdast utilities. */
  readonly root: Root;

  /** All list items found in this leaf that have GFM task state. */
  readonly tasks: ReadonlyArray<TaskItem>;

  /** Leaf-local annotations (already present before; unchanged). */
  readonly annotations: Readonly<Record<string, string>>;

  /** Leaf-local fenced code blocks (already present; keep as-is). */
  readonly codes: ReadonlyArray<CodeBlock>;
}

export interface FolioDoc<FM extends Dict = Dict, P = string> {
  readonly provenance: P;
  readonly fm: Readonly<FM>;
  readonly headings: ReadonlyArray<HeadingNode>;
  readonly leaves: ReadonlyArray<LeafNode>;
  readonly issues: ReadonlyArray<Issue<P>>;
  readonly ast: Root;
}

/** Map depths to caller-chosen role names (applied later by projection). */
export type DepthRoleMap = Partial<Record<`h${HeadingDepth}`, string>>;
type RoleNameOf<S extends DepthRoleMap> = NonNullable<S[keyof S]> & string;

export interface LeafView<Schema extends DepthRoleMap> {
  readonly leaf: LeafNode;
  /** role name -> heading text at that depth (if present on trail/leaf) */
  readonly roles: Partial<Record<RoleNameOf<Schema>, string>>;
}

/* -------------------------------------------------------------------------- */
/* Folio (query API, schema-later projection)                                 */
/* -------------------------------------------------------------------------- */

export class Folio<FM extends Dict = Dict, P = string> {
  constructor(readonly doc: FolioDoc<FM, P>) {}

  headings(): ReadonlyArray<HeadingNode> {
    return this.doc.headings;
  }
  leaves(): ReadonlyArray<LeafNode> {
    return this.doc.leaves;
  }
  frontmatter(): Readonly<FM> {
    return this.doc.fm;
  }
  issues(): ReadonlyArray<Issue<P>> {
    return this.doc.issues;
  }

  /** Find *headings* by annotation key/value (any hierarchy level). */
  findHeadingsByAnnotation(
    key: string,
    value?: string,
  ): ReadonlyArray<HeadingNode> {
    return this.doc.headings.filter((h) =>
      key in h.annotations && (value ? h.annotations[key] === value : true)
    );
  }

  /** Find *leaves* by annotation key/value (annotations in the leaf’s own section). */
  findLeavesByAnnotation(key: string, value?: string): ReadonlyArray<LeafNode> {
    return this.doc.leaves.filter((l) =>
      key in l.annotations && (value ? l.annotations[key] === value : true)
    );
  }

  /** Find code blocks across headings by lang and scope. */
  findCodeInHeadings(opts?: {
    lang?: string;
    depth?: HeadingDepth;
    scope?: "self" | "section"; // default: "self"
  }): ReadonlyArray<CodeBlock & { heading: HeadingNode }> {
    const { lang, depth, scope = "self" } = opts ?? {};
    const out: (CodeBlock & { heading: HeadingNode })[] = [];
    for (const h of this.doc.headings) {
      if (depth && h.depth !== depth) continue;
      const pool = scope === "section" ? h.codesSection : h.codesSelf;
      for (const c of pool) {
        if (lang && (c.lang ?? "").toLowerCase() !== lang.toLowerCase()) {
          continue;
        }
        out.push({ ...c, heading: h });
      }
    }
    return out;
  }

  /**
   * Project this document using:
   *  - an explicit depth→role map, or
   *  - a frontmatter key path (e.g., "qualityfolio.schema"), or
   *  - defaults ("L1","L2",...) if nothing is provided/found.
   *
   * Overloads:
   *   withSchema(schema: DepthRoleMap)
   *   withSchema(frontmatterKeyPath?: string)  // e.g., "qualityfolio.schema"
   */
  // deno-lint-ignore no-explicit-any
  withSchema<const Schema extends DepthRoleMap>(schemaOrFmKey?: any) {
    const schema = this.#resolveSchema(schemaOrFmKey) as Schema;

    type RoleName = RoleNameOf<Schema>;
    const roleDepth: Record<RoleName, HeadingDepth> = {} as Any;

    (Object.keys(schema) as Array<keyof Schema>).forEach((k) => {
      const v = schema[k];
      if (!v) return;
      const d = parseInt(String(k).slice(1), 10) as HeadingDepth;
      roleDepth[v as RoleName] = d;
    });

    const project = (leaf: LeafNode): LeafView<Schema> => {
      const roles: Partial<Record<RoleName, string>> = {};
      const chain = [...leaf.trail, leaf.heading];
      for (
        const [r, d] of Object.entries(roleDepth) as Array<
          [RoleName, HeadingDepth]
        >
      ) {
        const h = chain.find((hh) => hh.depth === d);
        if (h) roles[r] = h.text.trim();
      }
      return { leaf, roles } as LeafView<Schema>;
    };

    const view = this.doc.leaves.map(project);

    return {
      all: (): ReadonlyArray<LeafView<Schema>> => view,
      atRole: (role: RoleName): ReadonlyArray<LeafView<Schema>> =>
        view.filter((v) =>
          v.roles[role] !== undefined &&
          v.leaf.heading.depth === roleDepth[role]
        ),
      groupBy: (
        role: RoleName,
      ): ReadonlyMap<string, ReadonlyArray<LeafView<Schema>>> => {
        const buckets = new Map<string, LeafView<Schema>[]>();
        for (const v of view) {
          const key = v.roles[role];
          if (!key) continue;
          const arr = buckets.get(key) ?? [];
          arr.push(v);
          buckets.set(key, arr);
        }
        return buckets;
      },
    } as const;
  }

  // Resolve a schema from either an explicit map or a frontmatter key path.
  // - If a DepthRoleMap is given, return it.
  // - If a string key is given, try fm[key] (dot-notated) for a string[].
  // - If nothing is given, try "qualityfolio.schema" then "folio.schema".
  // - Fallback to defaults: "L1","L2","L3","L4","L5","L6".
  #resolveSchema(input?: DepthRoleMap | string): DepthRoleMap {
    // If caller already supplied a map, use it verbatim.
    if (input && typeof input === "object" && !Array.isArray(input)) {
      return input as DepthRoleMap;
    }

    const tryKeys: string[] = [];
    if (typeof input === "string" && input.trim().length > 0) {
      tryKeys.push(input.trim());
    } else {
      tryKeys.push("qualityfolio.schema", "folio.schema");
    }

    const arr = this.#findFirstStringArrayInFm(tryKeys);
    if (arr && arr.length) {
      return this.#rolesArrayToDepthMap(arr);
    }

    // Fallback defaults
    return this.#rolesArrayToDepthMap(["L1", "L2", "L3", "L4", "L5", "L6"]);
  }

  #findFirstStringArrayInFm(paths: string[]): string[] | undefined {
    for (const p of paths) {
      const v = deepGet(this.doc.fm as Dict, p);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        return v as string[];
      }
    }
    return undefined;
  }

  #rolesArrayToDepthMap(names: string[]): DepthRoleMap {
    const out: DepthRoleMap = {};
    for (let i = 0; i < Math.min(6, names.length); i++) {
      const role = names[i];
      if (role && role.trim().length) {
        const depth = (i + 1) as HeadingDepth;
        out[`h${depth}`] = role.trim();
      }
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Parser (governedmd-powered)                                                 */
/* -------------------------------------------------------------------------- */

export interface ParseInput<P = string> {
  readonly provenance: P;
  readonly content: string | ReadableStream<Uint8Array>;
}

export type ParseStream<P = string> = SourceStream<P>;

/** Streaming interface: yields Hierarchy for each normalized source. */
export async function* folios<
  P,
  FM extends Dict = Dict,
>(input: ParseStream<P>): AsyncIterable<Folio<FM, P>> {
  for await (
    const [provenance, source, srcSupplied] of normalizeSources<P>(input)
  ) {
    yield await parseOne<FM, P>(provenance, source, srcSupplied);
  }
}

/** Parse a single markdown source into a Hierarchy. */
// deno-lint-ignore require-await
export async function parseOne<FM extends Dict = Dict, P = string>(
  provenance: P,
  source: string,
  _srcSupplied?: Source<P>,
): Promise<Folio<FM, P>> {
  const remarkProcessor = remark()
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkStringify, { fences: true, bullet: "-" });

  const tree = remarkProcessor.parse(source) as Root;
  const issues: Issue<P>[] = [];

  // Frontmatter (top only, optional)
  const fm = (() => {
    try {
      const children = Array.isArray(tree.children)
        ? (tree.children as RootContent[])
        : [];
      const head = children.find((n) => isYamlNode(n));
      if (!head) return {} as FM;
      const raw = String(head.value ?? "");
      return (YAMLparse(raw) as unknown as FM) ?? ({} as FM);
    } catch (err) {
      issues.push(
        {
          kind: "frontmatter-parse",
          message: String(err),
          disposition: "warning",
        } as FrontmatterIssue<P>,
      );
      return {} as FM;
    }
  })();

  const children = Array.isArray(tree.children)
    ? (tree.children as RootContent[])
    : [];

  const stringifyNodes = (nodes: readonly RootContent[]) =>
    String(
      remarkProcessor.stringify({ type: "root", children: nodes } as Root),
    );
  const plainTextOfNodes = (nodes: readonly RootContent[]) =>
    nodes.map((n) => mdToString(n)).join("\n").trim();

  // Collect headings with section ranges.
  const headingMeta: {
    node: Extract<RootContent, { type: "heading" }>;
    idx: number;
  }[] = [];
  for (let i = 0; i < children.length; i++) {
    const n = children[i];
    if (n.type === "heading") headingMeta.push({ node: n, idx: i });
  }

  const headings: HeadingNode[] = headingMeta.map((h, i) => {
    // Section end: next heading with depth <= this depth, or EOF
    let endIdx = children.length;
    for (let j = h.idx + 1; j < children.length; j++) {
      const n = children[j];
      if (n.type !== "heading") continue;
      const d = (n as Any).depth as number;
      if (d <= (h.node as Any).depth) {
        endIdx = j;
        break;
      }
    }

    const sectionNodes = children.slice(h.idx + 1, endIdx);

    // selfContentNodes = only the content before the first child heading
    let firstChildIdx = sectionNodes.findIndex(
      (n) =>
        n.type === "heading" &&
        ((n as Any).depth as number) > (h.node as Any).depth,
    );
    if (firstChildIdx === -1) firstChildIdx = sectionNodes.length;
    const selfContentNodes = sectionNodes.slice(0, firstChildIdx);

    const markdownSelf = stringifyNodes(selfContentNodes);
    const annotations = extractAnnotations(markdownSelf);

    const codesSelf = extractCodeBlocks(selfContentNodes);
    const codesSection = extractCodeBlocks(sectionNodes);

    // NEW: plain text in self area
    const textSelf = plainTextOfNodes(selfContentNodes);
    const selfHasContent = (textSelf.trim().length > 0) ||
      (Object.keys(annotations).length > 0) ||
      (codesSelf.length > 0);

    return {
      index: i,
      depth: Math.max(1, Math.min(6, (h.node as Any).depth)) as HeadingDepth,
      text: mdToString(h.node).trim(),
      startLine: posStartLine(h.node) ?? -1,
      endLine: (sectionNodes.length
        ? posEndLine(sectionNodes[sectionNodes.length - 1])
        : posEndLine(h.node)) ?? -1,
      sectionNodes,
      annotations,
      codesSelf,
      codesSection,
      selfHasContent,
    } satisfies HeadingNode;
  });

  // Trail via *range containment* (true parent if it encloses the leaf's start).
  const computeTrail = (
    leaf: HeadingNode,
    all: ReadonlyArray<HeadingNode>,
  ): HeadingNode[] => {
    const ancestors = all.filter((a) =>
      a.depth < leaf.depth &&
      a.startLine <= leaf.startLine &&
      leaf.startLine < a.endLine
    );
    ancestors.sort((a, b) => a.depth - b.depth || a.startLine - b.startLine);
    const trail: HeadingNode[] = [];
    const seenDepth = new Set<number>();
    for (const a of ancestors) {
      if (!seenDepth.has(a.depth)) {
        trail.push(a);
        seenDepth.add(a.depth);
      }
    }
    return trail;
  };

  // Identify *terminal* headings (no deeper headings inside their section).
  const leaves: LeafNode[] = (() => {
    const result: LeafNode[] = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      let hasDeeper = false;
      for (const sn of h.sectionNodes) {
        if (sn.type === "heading" && (sn as Any).depth > h.depth) {
          hasDeeper = true;
          break;
        }
      }
      if (hasDeeper) continue;

      const trail = computeTrail(h, headings);
      const markdown = stringifyNodes(h.sectionNodes);
      const text = plainTextOfNodes(h.sectionNodes);

      // For leaves, sectionNodes contain no child headings by definition,
      // so `nodes` is exactly the leaf’s own content.
      const nodes = h.sectionNodes;
      const root: Root = { type: "root", children: nodes as RootContent[] };

      const tasks = extractGfmTasks(nodes);

      result.push({
        heading: h,
        trail,
        text,
        markdown,
        nodes,
        root,
        tasks,
        annotations: h.annotations,
        codes: h.codesSelf,
      });
    }
    return result;
  })();

  const doc: FolioDoc<FM, P> = {
    provenance,
    fm,
    headings,
    leaves,
    issues,
    ast: tree,
  };
  return new Folio<FM, P>(doc);
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function extractGfmTasks(nodes: ReadonlyArray<RootContent>): TaskItem[] {
  const out: TaskItem[] = [];

  const visit = (n: RootContent) => {
    if (n.type === "list") {
      for (const li of n.children) {
        // mdast GFM sets listItem.checked = boolean | null
        const item = li; // ListItem
        const checked: boolean | null = typeof item.checked === "boolean"
          ? item.checked
          : null;

        const text = mdToString(li).trim();
        out.push({
          checked,
          text,
          startLine: posStartLine(li) ?? -1,
          endLine: posEndLine(li) ?? -1,
          node: li as Any,
        });

        // Visit possible nested lists/paragraphs in the list item
        for (const c of li.children) visit(c);
      }
      return;
    }

    // Recurse into containers we care about
    if ("children" in n && Array.isArray(n.children)) {
      for (const c of (n.children as RootContent[])) visit(c);
    }
  };

  for (const n of nodes) visit(n);
  // Keep only those that actually have a GFM task state.
  return out.filter((t) => t.checked !== null);
}

function extractAnnotations(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = markdown.replace(/\r\n?/g, "\n").split(/\n/);
  for (const raw of lines) {
    const m = raw.match(/^@([A-Za-z0-9_\-]+)\s+(.+)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function extractCodeBlocks(nodes: ReadonlyArray<RootContent>): CodeBlock[] {
  const out: CodeBlock[] = [];
  for (const n of nodes) {
    if (n.type === "code") {
      out.push({
        lang: n.lang ?? undefined,
        meta: n.meta ?? null,
        value: String(n.value ?? ""),
        startLine: posStartLine(n) ?? -1,
        endLine: posEndLine(n) ?? -1,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Dot-notated deep getter (e.g., deepGet(obj, "qualityfolio.schema")). */
function deepGet(obj: Dict | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split(".").map((s) => s.trim()).filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Dict)) {
      cur = (cur as Dict)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/* -------------------------------------------------------------------------- */
/* Tabular view (rows for ancestors + leaves with canonical paths)            */
/* -------------------------------------------------------------------------- */

export type RowBase<Provenance> = {
  /** “a::b::c::…” where each segment is the title of a role (e.g. project::suite::plan::case) */
  path: string;
  /** The display title for this node (the last segment of `path`) */
  name: string;
  /** Source file and starting line "<provenance>:line" */
  where: string;
  /** Raw file path (used by tree builder, not shown) */
  provenance: Provenance;
};

export type AncestorRow<Provenance> = RowBase<Provenance> & {
  kind: "ancestor";
  /** Heading node for this ancestor */
  heading: HeadingNode;
};

export type LeafRow<Provenance> = RowBase<Provenance> & {
  kind: "leaf";
  /** Leaf node */
  leaf: LeafNode;
};

export type Row<Provenance> = AncestorRow<Provenance> | LeafRow<Provenance>;

/**
 * Create a tabular representation of a folio:
 * - One row per ancestor heading along the path to each leaf (deduped),
 * - One row per terminal leaf,
 * - `path` includes all role levels (from schema resolved via withSchema),
 *   filling missing titles with "—".
 *
 * `schemaOrFmKey` mirrors `withSchema(...)`:
 *  - DepthRoleMap, or
 *  - frontmatter key path (e.g., "qualityfolio.schema"), or
 *  - omitted → frontmatter default or L1..L6.
 */
/* -------------------------------------------------------------------------- */
/* Tabular (lineage-only paths)                                               */
/* -------------------------------------------------------------------------- */

export function tabularFolio<FM extends Dict = Dict, P = string>(
  folio: Folio<FM, P>,
  schemaOrFmKey?: DepthRoleMap | string, // kept for signature parity; not required for lineage
): ReadonlyArray<Row<P>> {
  // We still resolve via withSchema() so external consumers can use the same
  // projection logic if they need it, but lineage-only paths ignore placeholders.
  const view = folio.withSchema(schemaOrFmKey as unknown as DepthRoleMap);
  const leafViews = view.all();

  const rows = new Map<string, Row<P>>();

  // Build "title-only" lineage path from an ordered chain of headings.
  const mkPath = (chain: ReadonlyArray<HeadingNode>) =>
    chain.map((h) => h.text.trim()).filter(Boolean).join("::");

  for (const lv of leafViews) {
    const leaf = lv.leaf;
    const fullChain = [...leaf.trail, leaf.heading];

    // Ancestors
    for (const anc of leaf.trail) {
      const chainUpToAnc = fullChain.filter((h) =>
        h.startLine <= anc.startLine && h.depth <= anc.depth
      );
      const path = mkPath(chainUpToAnc);
      const key = `H|${String(folio.doc.provenance)}|${anc.startLine}`;
      if (!rows.has(key)) {
        rows.set(key, {
          kind: "ancestor",
          path,
          name: anc.text,
          heading: anc,
          where: `${String(folio.doc.provenance)}:${anc.startLine}`,
          provenance: folio.doc.provenance,
        });
      }
    }

    // Leaf
    {
      const path = mkPath(fullChain);
      const key = `L|${String(folio.doc.provenance)}|${leaf.heading.startLine}`;
      if (!rows.has(key)) {
        rows.set(key, {
          kind: "leaf",
          path,
          name: leaf.heading.text,
          leaf,
          where: `${String(folio.doc.provenance)}:${leaf.heading.startLine}`,
          provenance: folio.doc.provenance,
        });
      }
    }
  }

  return Array.from(rows.values());
}
