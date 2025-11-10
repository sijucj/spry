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
   * Project this document using a caller-provided depth→role map.
   * Role names become a *typed* union inferred from the const argument.
   */
  withSchema<const Schema extends DepthRoleMap>(schema: Schema) {
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
      selfHasContent, // <-- ADD THIS
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
      for (const c of n.children as RootContent[]) visit(c);
    }
  };

  for (const n of nodes) visit(n);
  // Keep only those that actually have a GFM task state (true/false), but we could keep all if desired.
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
/* Smart schema discovery (terminal-first)                                     */
/* -------------------------------------------------------------------------- */

export interface DiscoveredSchema<Schema extends DepthRoleMap> {
  /** Count of headings actually present at each depth. */
  readonly depthsPresent: Readonly<Partial<Record<`h${HeadingDepth}`, number>>>;
  /** Distinct depths that participate in the folio structure (from leaves + ancestors), shallow→deep. */
  readonly structuralDepths: ReadonlyArray<HeadingDepth>;
  /** Depths where *leaves* (terminals) occur. */
  readonly leafDepths: ReadonlyArray<HeadingDepth>;

  /** Recommended mapping from present depths to the *last k* roles of the provided schema. */
  readonly recommended: Readonly<{
    /** depth -> role (only for depths present/used) */
    depthToRole: Readonly<
      Partial<Record<`h${HeadingDepth}`, RoleNameOf<Schema>>>
    >;
    /** role -> depth (only for roles assigned) */
    roleToDepth: Readonly<Partial<Record<RoleNameOf<Schema>, HeadingDepth>>>;
    /** Roles (from your provided schema) that were assigned, shallow→deep. */
    availableRoles: ReadonlyArray<RoleNameOf<Schema>>;
    /** Roles (from your provided schema) that were NOT assigned (missing), shallow→deep. */
    missingRoles: ReadonlyArray<RoleNameOf<Schema>>;
    /** The inferred terminal role (last assigned role), if any. */
    terminalRole?: RoleNameOf<Schema>;
  }>;
}

/**
 * Terminal-first, “smart” schema discovery.
 *
 * Given a parsed folio and a *desired* schema (e.g.,
 *   { h1: "project", h2: "strategy", h3: "plan", h4: "suite", h5: "case" } as const)
 * we infer which roles are present by anchoring on the *terminal* leaves and mapping upward:
 *
 * - If only one heading depth is present → it is assumed to be the terminal role (e.g., "case").
 * - If two depths are present → they are assumed to be the last two roles (e.g., "suite"→"case").
 * - If k depths are present → we assign them to the last k roles of your schema, in order.
 *
 * Works with mixed/irregular heading depths; we derive “structuralDepths” from leaves and their
 * ancestor trails only, ignoring stray headings that don’t participate in leaf structure.
 */
export function discoverSchema<
  const Schema extends DepthRoleMap,
  FM extends Dict = Dict,
  P = string,
>(
  docOrFolio: Folio<FM, P> | FolioDoc<FM, P>,
  schema: Schema,
): DiscoveredSchema<Schema> {
  // Normalize input
  const doc: FolioDoc<FM, P> = (docOrFolio as Any)?.doc
    ? (docOrFolio as Folio<FM, P>).doc
    : (docOrFolio as FolioDoc<FM, P>);

  // 1) Stats: counts by heading depth (present anywhere)
  const depthsPresent: Partial<Record<`h${HeadingDepth}`, number>> = {};
  for (const h of doc.headings) {
    const key = `h${h.depth}` as const;
    depthsPresent[key] = (depthsPresent[key] ?? 0) + 1;
  }

  // 2) “Structural” depths = leaf depths plus ancestor depths with a refined rule:
  //    - Always include the shallowest ancestor for context (even if empty),
  //    - Include other ancestors only if they are “significant” (own content/annos/code).
  const structuralSet = new Set<HeadingDepth>();
  const leafSet = new Set<HeadingDepth>();

  for (const leaf of doc.leaves) {
    structuralSet.add(leaf.heading.depth);
    leafSet.add(leaf.heading.depth);

    // Determine shallowest ancestor depth (if any)
    const trail = leaf.trail;
    const shallowestAncDepth = trail.length
      ? Math.min(...trail.map((a) => a.depth)) as HeadingDepth
      : undefined;

    for (const anc of trail) {
      const isShallowest = shallowestAncDepth !== undefined &&
        anc.depth === shallowestAncDepth;
      const significant = anc.selfHasContent ||
        Object.keys(anc.annotations).length > 0 ||
        anc.codesSelf.length > 0;

      if (isShallowest || significant) {
        structuralSet.add(anc.depth);
      }
    }
  }

  const structuralDepths = Array.from(structuralSet).sort((a, b) =>
    a - b
  ) as HeadingDepth[];
  const leafDepths = Array.from(leafSet).sort((a, b) =>
    a - b
  ) as HeadingDepth[];

  // 3) Order the provided schema’s roles by depth (shallow→deep)
  type RoleName = RoleNameOf<Schema>;
  const schemaPairs: Array<{ depth: HeadingDepth; role: RoleName }> = [];
  for (const k of Object.keys(schema) as Array<keyof Schema>) {
    const role = schema[k];
    if (!role) continue;
    const d = parseInt(String(k).slice(1), 10) as HeadingDepth;
    schemaPairs.push({ depth: d, role: role as RoleName });
  }
  schemaPairs.sort((a, b) => a.depth - b.depth);
  const allRolesOrdered = schemaPairs.map((p) => p.role); // shallow→deep

  // 4) Smart assignment: align the LAST k roles of the provided schema
  //    to the k structural depths we discovered (shallow→deep).
  const k = structuralDepths.length;
  const lastKRoles = allRolesOrdered.slice(-k); // shallow→deep within the bottom slice
  const depthToRole: Partial<Record<`h${HeadingDepth}`, RoleName>> = {};
  const roleToDepth: Partial<Record<RoleName, HeadingDepth>> = {};
  for (let i = 0; i < k; i++) {
    const d = structuralDepths[i];
    const r = lastKRoles[i];
    if (r) {
      depthToRole[`h${d}` as const] = r;
      roleToDepth[r] = d;
    }
  }

  // 5) Available vs missing roles relative to provided schema
  const availableRoles = lastKRoles as ReadonlyArray<RoleName>;
  const missingRoles = allRolesOrdered.slice(
    0,
    Math.max(0, allRolesOrdered.length - k),
  ) as ReadonlyArray<RoleName>;
  const terminalRole = availableRoles.length
    ? (availableRoles[availableRoles.length - 1] as RoleName)
    : undefined;

  return {
    depthsPresent,
    structuralDepths,
    leafDepths,
    recommended: {
      depthToRole,
      roleToDepth,
      availableRoles,
      missingRoles,
      terminalRole,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience: discover + apply                                               */
/* -------------------------------------------------------------------------- */

export function applyDiscoveredSchema<
  const Schema extends DepthRoleMap,
  FM extends Dict = Dict,
  P = string,
>(
  docOrHierarchy: Folio<FM, P> | FolioDoc<FM, P>,
  schema: Schema,
) {
  const discovery = discoverSchema(docOrHierarchy, schema);

  // Normalize to a Hierarchy
  const hierarchy = (docOrHierarchy as Any)?.doc
    ? (docOrHierarchy as Folio<FM, P>)
    : new Folio<FM, P>(docOrHierarchy as FolioDoc<FM, P>);

  // Start with recommended mapping (depth -> role)
  const base = { ...(discovery.recommended.depthToRole as DepthRoleMap) };

  // ---- Convenience extension: if we only mapped the terminal role (k === 1),
  // and there is at least one ancestor depth present in the document, add the
  // immediate parent role (preceding role in the provided schema) onto the
  // *shallowest ancestor depth* so grouping works (e.g., "suite" in two-level docs).
  const assignedRoles = discovery.recommended
    .availableRoles as unknown as string[];
  const k = assignedRoles.length;

  if (k === 1) {
    // Order schema roles shallow->deep
    const schemaPairs: Array<{ depth: HeadingDepth; role: string }> = [];
    for (const k of Object.keys(schema) as Array<keyof Schema>) {
      const role = schema[k];
      if (!role) continue;
      const d = parseInt(String(k).slice(1), 10) as HeadingDepth;
      schemaPairs.push({ depth: d, role: String(role) });
    }
    schemaPairs.sort((a, b) => a.depth - b.depth);
    const rolesOrdered = schemaPairs.map((p) => p.role);

    const terminalRole = assignedRoles[0]; // only one
    const termIdx = rolesOrdered.lastIndexOf(terminalRole);
    const parentRole = termIdx > 0 ? rolesOrdered[termIdx - 1] : undefined;

    if (parentRole) {
      // Gather any ancestor depths from actual leaf trails (significant or not).
      const ancestorDepths = new Set<HeadingDepth>();
      const doc: FolioDoc<FM, P> = (hierarchy as Any).doc ??
        (docOrHierarchy as FolioDoc<FM, P>);
      for (const leaf of doc.leaves) {
        for (const anc of leaf.trail) ancestorDepths.add(anc.depth);
      }
      const shallowestAncestor = [...ancestorDepths].sort((a, b) => a - b)[0];

      if (shallowestAncestor !== undefined) {
        const key = `h${shallowestAncestor}` as const;
        // Only add if not already assigned to some role
        const alreadyMapped = Object.keys(base).some((k) =>
          base[k as keyof DepthRoleMap] === parentRole
        );
        if (!alreadyMapped) base[key] = parentRole;
      }
    }
  }

  const view = hierarchy.withSchema(base);
  return { discovery, view };
}

/**
 * A single "ls" row describing one role occurrence at a specific heading level.
 */
export interface LsSchemaRow {
  readonly HL: HeadingDepth; // Markdown heading level (1..6)
  readonly Nature: string; // Role name from the applied schema (e.g., "project")
  readonly Title: string; // Heading text at that level
}

/**
 * List (`ls`) the applied schema across a Folio as simple rows:
 *   HL | Nature  | Title
 *   1  | Project | My Project
 *   2  | Suite   | Authentication
 *
 * This inspects the `view` returned by `folio.withSchema({...} as const)` or
 * `applyDiscoveredSchema(...).view`, derives a consistent role→depth mapping,
 * and then enumerates unique (depth, role title) pairs across the document.
 *
 * Notes:
 * - We do NOT rely on any private properties on the view; we infer role→depth
 *   by matching each role's Title to the heading chain (trail + leaf heading).
 * - Rows are de-duplicated and sorted by `HL` (ascending).
 */
export function lsSchema<
  const Schema extends DepthRoleMap,
  FM extends Dict = Dict,
  P = string,
>(
  _folio: Folio<FM, P>,
  view: {
    all: () => ReadonlyArray<LeafView<Schema>>;
    atRole: (
      role: RoleNameOf<Schema>,
    ) => ReadonlyArray<LeafView<Schema>>;
    groupBy: (
      role: RoleNameOf<Schema>,
    ) => ReadonlyMap<string, ReadonlyArray<LeafView<Schema>>>;
  },
): ReadonlyArray<LsSchemaRow> {
  const leafViews = view.all();
  if (leafViews.length === 0) return [];

  // 1) Gather all role names present in this projection
  const allRoleNames = new Set<string>();
  for (const lv of leafViews) {
    for (const rk of Object.keys(lv.roles)) {
      allRoleNames.add(rk);
    }
  }

  // 2) Build a consistent role -> depth mapping by inspecting any leaf where that role exists.
  const roleToDepth = new Map<string, HeadingDepth>();
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

  // 3) Produce unique rows (depth, role, title)
  const seen = new Set<string>();
  const rows: LsSchemaRow[] = [];

  for (const lv of leafViews) {
    for (const role of allRoleNames) {
      const title = lv.roles[role as keyof typeof lv.roles];
      if (!title) continue;

      const depth = roleToDepth.get(role);
      if (!depth) continue;

      const key = `${depth}|${role}|${title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Capitalize Nature for nice display; keep original casing otherwise
      const naturePretty = role.length
        ? role.charAt(0).toUpperCase() + role.slice(1)
        : role;

      rows.push({
        HL: depth,
        Nature: naturePretty,
        Title: String(title),
      });
    }
  }

  return rows;
}
