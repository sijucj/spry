/**
 * @module doc-schema
 *
 * A remark plugin that constructs a per-document "section schema" describing
 * logical sections in a Markdown document.
 *
 * - Sections are currently:
 *   - Heading-based sections: `nature: "heading"`
 *   - Marker-based sections:  `nature: "marker"` (via custom rules)
 *
 * - Each section tracks:
 *   - namespace       – logical partition (e.g. "prime", "ns1", "ns2")
 *   - startIndex/endIndex – index range into `Root.children`
 *   - parent / children   – logical nesting (for now, headings use flat spans)
 *   - parentNode          – the parent `Root` (currently only top-level)
 *
 * - For each section start node, we attach:
 *   - `node.data.sectionSchema[namespace] = SectionSchema`
 *
 * - Optionally, for each node inside the section, we attach:
 *   - `node.data.belongsToSection[namespace] = SectionSchema`
 *
 * - Multiple invocations of the plugin with different namespaces accumulate:
 *   - `sectionSchema` is a per-namespace catalog
 *   - `belongsToSection` is a per-namespace catalog
 */

import type {
  Heading,
  Paragraph,
  Root,
  RootContent,
  Strong,
} from "npm:@types/mdast@^4";
import type { Data } from "npm:@types/unist@^3";
import type { Plugin } from "npm:unified@^11";

/**
 * Base section schema shared by all section kinds.
 */
interface BaseSectionSchema {
  readonly nature: "heading" | "marker";
  readonly namespace: string;
  readonly startIndex: number;
  readonly endIndex: number;
  parent?: SectionSchema;
  readonly children: SectionSchema[];
  readonly parentNode: Root;
}

/**
 * Heading-based section.
 */
export interface HeadingSectionSchema extends BaseSectionSchema {
  readonly nature: "heading";
  readonly heading: Heading;
  readonly depth: number;
}

/**
 * Generic marker-based section (e.g. bold paragraphs, colon paragraphs, etc.).
 */
export interface MarkerSectionSchema extends BaseSectionSchema {
  readonly nature: "marker";
  readonly markerKind: string;
  readonly markerNode: RootContent;
  readonly title?: string;
}

/**
 * Discriminated union for all section types.
 */
export type SectionSchema = HeadingSectionSchema | MarkerSectionSchema;

/**
 * Termination behavior for a section rule.
 */
export type SectionTerminationMode =
  | "until-next-of-same-rule"
  | "until-next-any-rule";

export interface SectionTerminationConfig {
  readonly mode: SectionTerminationMode;
}

/**
 * Base shape of a section rule.
 */
interface SectionRuleBase {
  readonly id: string;
  readonly nature: SectionSchema["nature"];
  readonly termination: SectionTerminationConfig;
}

/**
 * Heading rule: `isStart` must type-narrow to Heading.
 */
export interface HeadingSectionRule extends SectionRuleBase {
  readonly nature: "heading";
  readonly isStart: (
    node: RootContent,
    index: number,
    siblings: readonly RootContent[],
  ) => node is Heading;
  readonly buildSection: (args: {
    namespace: string;
    root: Root;
    startIndex: number;
    endIndex: number;
    node: Heading;
    parent: HeadingSectionSchema | undefined;
  }) => HeadingSectionSchema;
}

/**
 * Marker rule: `isStart` is a boolean predicate.
 */
export interface MarkerSectionRule extends SectionRuleBase {
  readonly nature: "marker";
  readonly isStart: (
    node: RootContent,
    index: number,
    siblings: readonly RootContent[],
  ) => boolean;
  readonly buildSection: (args: {
    namespace: string;
    root: Root;
    startIndex: number;
    endIndex: number;
    node: RootContent;
    parent: HeadingSectionSchema | undefined;
  }) => MarkerSectionSchema;
}

/**
 * Section rule discriminated union.
 */
export type SectionRule = HeadingSectionRule | MarkerSectionRule;

/**
 * Options for `documentSchema` plugin.
 */
export interface DocumentSchemaOptions {
  /**
   * Namespace under which this plugin invocation records sections.
   * Multiple invocations with different namespaces accumulate in
   * `data.sectionSchema[namespace]`.
   */
  readonly namespace?: string;

  /**
   * Optional rules for additional section kinds (markers, etc.).
   */
  readonly sectionRules?: readonly SectionRule[];

  /**
   * Whether to include the built-in heading section rule.
   * Defaults to `true`.
   */
  readonly includeDefaultHeadingRule?: boolean;

  /**
   * If set, each child node within a section will be annotated with:
   *
   *   node.data.belongsToSection[namespace] = SectionSchema
   */
  readonly enrichWithBelongsTo?: boolean;

  /**
   * Optional callback invoked once per discovered section.
   */
  readonly encountered?: (section: SectionSchema, node: RootContent) => void;
}

/**
 * Type guard for nodes with a `sectionSchema` catalog.
 */
export function hasSectionSchema(
  node: Root | RootContent,
): node is (Root | RootContent) & {
  data: Data & {
    sectionSchema: Record<string, SectionSchema>;
  };
} {
  const d = (node as RootContent | Root).data;
  if (!d || typeof d !== "object") return false;
  const catalog = (d as Data & { sectionSchema?: unknown }).sectionSchema;
  if (!catalog || typeof catalog !== "object") return false;
  return true;
}

/**
 * Type guard for nodes with a `belongsToSection` catalog.
 */
export function hasBelongsToSection(
  node: Root | RootContent,
): node is (Root | RootContent) & {
  data: Data & {
    belongsToSection: Record<string, SectionSchema>;
  };
} {
  const d = (node as RootContent | Root).data;
  if (!d || typeof d !== "object") return false;
  const belongs = (d as Data & { belongsToSection?: unknown }).belongsToSection;
  if (!belongs || typeof belongs !== "object") return false;
  return true;
}

/**
 * Built-in heading rule: any `heading` node at top level starts a section
 * that runs until the next heading, regardless of level.
 * Sections are flat (no nested parent/child relationships).
 */
export function headingSectionRule(): HeadingSectionRule {
  return {
    id: "heading",
    nature: "heading",
    termination: { mode: "until-next-of-same-rule" },
    isStart(node): node is Heading {
      return node.type === "heading";
    },
    buildSection({
      namespace,
      root,
      startIndex,
      endIndex,
      node,
    }): HeadingSectionSchema {
      return {
        nature: "heading",
        namespace,
        startIndex,
        endIndex,
        parent: undefined,
        children: [],
        parentNode: root,
        depth: node.depth,
        heading: node,
      };
    },
  };
}

/**
 * Extract title text from a bold single-line paragraph.
 * Strips trailing colon, is whitespace-insensitive, and only uses the bold text.
 */
function getBoldParagraphTitle(node: RootContent): string | undefined {
  if (node.type !== "paragraph") return undefined;

  const meaningfulChildren = node.children.filter(
    (c) => !(c.type === "text" && c.value.trim() === ""),
  );

  if (!meaningfulChildren.length) return undefined;
  const first = meaningfulChildren[0];

  if (first.type !== "strong") return undefined;

  const strong = first as Strong;
  const raw = strong.children
    .map((c) => (c.type === "text" ? c.value : ""))
    .join("")
    .trim();

  if (!raw) return undefined;

  const title = raw.replace(/[:：]\s*$/u, "").trim();
  return title || undefined;
}

/**
 * Helper: detect a bold single-line paragraph:
 * paragraph whose primary content is `strong`, optionally followed by a colon.
 * Whitespace around is ignored.
 */
function isBoldSingleLineParagraph(node: RootContent): node is Paragraph {
  if (node.type !== "paragraph") return false;

  const meaningfulChildren = node.children.filter(
    (c) => !(c.type === "text" && c.value.trim() === ""),
  );

  if (meaningfulChildren.length === 0) return false;

  if (meaningfulChildren.length === 1) {
    return meaningfulChildren[0].type === "strong";
  }

  if (meaningfulChildren.length === 2) {
    const [first, second] = meaningfulChildren;
    return (
      first.type === "strong" &&
      second.type === "text" &&
      second.value.trim() === ":"
    );
  }

  return false;
}

export interface BoldParagraphSectionSchema extends MarkerSectionSchema {
  readonly markerKind: "bold-paragraph";
  readonly markerNode: Paragraph;
  readonly title: string;
}

export function isBoldParagraphSection(
  s: MarkerSectionSchema,
): s is BoldParagraphSectionSchema {
  return s.markerKind === "bold-paragraph";
}

/**
 * Built-in helper rule: any bold single-line paragraph starts a marker section.
 * In practice this will only match if the entire paragraph is just `**text**`
 * (with an optional trailing colon) and optional surrounding whitespace.
 */
export function boldParagraphSectionRule(): MarkerSectionRule {
  return {
    id: "bold-paragraph",
    nature: "marker",
    termination: { mode: "until-next-any-rule" },
    isStart(node: RootContent): node is Paragraph {
      return isBoldSingleLineParagraph(node);
    },
    buildSection({
      namespace,
      root,
      startIndex,
      endIndex,
      node,
      parent,
    }): MarkerSectionSchema {
      const title = getBoldParagraphTitle(node) ?? "";
      const base: MarkerSectionSchema = {
        nature: "marker",
        namespace,
        startIndex,
        endIndex,
        parent,
        children: [],
        parentNode: root,
        markerKind: "bold-paragraph",
        markerNode: node,
      };
      return {
        ...base,
        title,
      } as BoldParagraphSectionSchema;
    },
  };
}

/**
 * Helper: detect a single-line colon paragraph:
 * paragraph with exactly one text child whose value ends with ':'.
 */
function isColonSingleLineParagraph(node: RootContent): node is Paragraph {
  if (node.type !== "paragraph") return false;
  if (node.children.length !== 1) return false;
  const child = node.children[0];
  return child.type === "text" && child.value.trimEnd().endsWith(":");
}

/**
 * Built-in helper rule: any single-line colon paragraph starts a marker section.
 */
export function colonParagraphSectionRule(): MarkerSectionRule {
  return {
    id: "colon-paragraph",
    nature: "marker",
    termination: { mode: "until-next-any-rule" },
    isStart(node: RootContent): boolean {
      return isColonSingleLineParagraph(node);
    },
    buildSection({
      namespace,
      root,
      startIndex,
      endIndex,
      node,
      parent,
    }): MarkerSectionSchema {
      return {
        nature: "marker",
        namespace,
        startIndex,
        endIndex,
        parent,
        children: [],
        parentNode: root,
        markerKind: "colon-paragraph",
        markerNode: node,
      };
    },
  };
}

/**
 * Compute the end index for a section given a rule and all rules.
 */
function findEndIndex(
  startIndex: number,
  siblings: readonly RootContent[],
  rule: SectionRule,
  allRules: readonly SectionRule[],
): number {
  const { mode } = rule.termination;

  if (mode === "until-next-of-same-rule") {
    for (let i = startIndex + 1; i < siblings.length; i++) {
      const n = siblings[i];
      if (rule.isStart(n, i, siblings as RootContent[])) {
        return i;
      }
    }
    return siblings.length;
  }

  if (mode === "until-next-any-rule") {
    for (let i = startIndex + 1; i < siblings.length; i++) {
      const n = siblings[i];
      for (const r of allRules) {
        if (r.isStart(n, i, siblings as RootContent[])) {
          return i;
        }
      }
    }
    return siblings.length;
  }

  // Fallback, though we shouldn't hit it with current modes.
  return siblings.length;
}

/**
 * Main remark plugin: discovers sections and annotates nodes with per-namespace
 * section schema metadata.
 */
export const documentSchema: Plugin<[DocumentSchemaOptions?], Root> = (
  options = {},
) => {
  const {
    namespace = "prime",
    sectionRules = [],
    includeDefaultHeadingRule = true,
    enrichWithBelongsTo = false,
    encountered,
  } = options;

  return (tree: Root) => {
    const siblings = tree.children as RootContent[];

    const rules: SectionRule[] = [];
    if (includeDefaultHeadingRule) {
      rules.push(headingSectionRule());
    }
    if (sectionRules.length) {
      rules.push(...sectionRules);
    }

    if (!rules.length || siblings.length === 0) {
      return;
    }

    // For now, we treat the entire Root as a flat array of siblings.
    // Parent/child relationships are not nested by depth; each heading/marker
    // simply spans from its startIndex to its computed endIndex.
    const parentNode = tree;
    const headingSectionsByStart: Map<number, HeadingSectionSchema> = new Map();

    // First pass: headings (to optionally use as "parent" for markers).
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      for (const rule of rules) {
        if (rule.nature !== "heading") continue;
        if (!rule.isStart(node, i, siblings)) continue;

        const endIndex = findEndIndex(i, siblings, rule, rules);
        const section = rule.buildSection({
          namespace,
          root: parentNode,
          startIndex: i,
          endIndex,
          node,
          parent: undefined,
        });

        // Attach / accumulate sectionSchema[namespace] on the heading node.
        const data = (node.data ??= {});
        const catalog = (data as Data & {
          sectionSchema?: Record<string, SectionSchema>;
        }).sectionSchema ??= {};

        catalog[namespace] = section;

        headingSectionsByStart.set(i, section);

        if (enrichWithBelongsTo) {
          for (let j = i + 1; j < endIndex; j++) {
            const child = siblings[j];
            const d2 = (child.data ??= {});
            const belongs = (d2 as Data & {
              belongsToSection?: Record<string, SectionSchema>;
            }).belongsToSection ??= {};
            belongs[namespace] = section;
          }
        }

        if (encountered) {
          encountered(section, node);
        }

        // Do NOT break; allow other rules also to consider this node if needed.
      }
    }

    // Second pass: marker rules, using headings as potential parents.
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];

      const parentHeading = findEnclosingHeadingSection(
        i,
        headingSectionsByStart,
      );

      for (const rule of rules) {
        if (rule.nature !== "marker") continue;
        if (!rule.isStart(node, i, siblings)) continue;

        const endIndex = findEndIndex(i, siblings, rule, rules);
        const section = rule.buildSection({
          namespace,
          root: parentNode,
          startIndex: i,
          endIndex,
          node,
          parent: parentHeading ?? undefined,
        });

        if (parentHeading) {
          parentHeading.children.push(section);
        }

        // Attach / accumulate sectionSchema[namespace] on the marker start node.
        const data = (node.data ??= {});
        const catalog = (data as Data & {
          sectionSchema?: Record<string, SectionSchema>;
        }).sectionSchema ??= {};

        catalog[namespace] = section;

        if (enrichWithBelongsTo) {
          for (let j = i + 1; j < endIndex; j++) {
            const child = siblings[j];
            const d2 = (child.data ??= {});
            const belongs = (d2 as Data & {
              belongsToSection?: Record<string, SectionSchema>;
            }).belongsToSection ??= {};
            belongs[namespace] = section;
          }
        }

        if (encountered) {
          encountered(section, node);
        }
      }
    }
  };
};

/**
 * Find a heading section that encloses the given sibling index, if any.
 * This is used as a "logical parent" for marker sections.
 */
function findEnclosingHeadingSection(
  index: number,
  headingSectionsByStart: Map<number, HeadingSectionSchema>,
): HeadingSectionSchema | undefined {
  for (const section of headingSectionsByStart.values()) {
    if (section.startIndex <= index && index < section.endIndex) {
      return section;
    }
  }
  return undefined;
}

export function stringifySections(sections: Iterable<SectionSchema>) {
  const arr = Array.from(sections);
  const byNs = new Map<string, SectionSchema[]>();

  for (const s of arr) {
    const ns = s.namespace;
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns)!.push(s);
  }

  const sectionLabel = (s: SectionSchema) => {
    switch (s.nature) {
      case "heading": {
        const h = s as HeadingSectionSchema;
        const text = h.heading.children
          .map((c) => ("value" in c ? c.value : ""))
          .join("");
        return `heading: "${text}" depth=${h.depth}`;
      }
      case "marker": {
        const m = s as MarkerSectionSchema;
        const mk = m.markerKind;
        const t = "title" in m ? ` title="${m.title}"` : "";
        return `marker: kind=${mk}${t}`;
      }
    }
  };

  const asciiTree = () => {
    const lines: string[] = [];
    for (const ns of [...byNs.keys()].sort()) {
      lines.push(`namespace: ${ns}`);
      const roots = byNs.get(ns)!.filter((s) => s.parent == null);
      for (const r of roots) {
        lines.push(
          `  - ${sectionLabel(r)} [${r.startIndex}, ${r.endIndex})`,
        );
        for (const c of r.children) {
          lines.push(
            `      * ${sectionLabel(c)} [${c.startIndex}, ${c.endIndex})`,
          );
        }
      }
    }
    return lines.join("\n");
  };

  const dumpNode = (lines: string[], s: SectionSchema, pad: string) => {
    lines.push(`${pad}- ${sectionLabel(s)} [${s.startIndex}, ${s.endIndex})`);
    for (const c of s.children) {
      dumpNode(lines, c, pad + "  ");
    }
  };

  const asciiTreeByNamespace = () => {
    const lines: string[] = [];
    for (const ns of [...byNs.keys()].sort()) {
      lines.push(`namespace ${ns}`);
      const roots = byNs.get(ns)!.filter((s) => s.parent == null);
      for (const r of roots) {
        dumpNode(lines, r, "  ");
      }
    }
    return lines.join("\n");
  };

  const listNamespaces = () => [...byNs.keys()];

  const listSections = (namespace?: string) => {
    if (!namespace) return arr;
    return byNs.get(namespace) ?? [];
  };

  return {
    asciiTree,
    asciiTreeByNamespace,
    listNamespaces,
    listSections,
  };
}

export function collectSectionsFromRoot(root: Root) {
  const out: SectionSchema[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (n: any) => {
    if (hasSectionSchema(n)) {
      for (
        const s of Object.values(
          (n.data as { sectionSchema: Record<string, SectionSchema> })
            .sectionSchema,
        )
      ) {
        out.push(s);
      }
    }
    if (n.children) {
      for (const c of n.children) walk(c);
    }
  };
  walk(root);
  return out;
}

export function materializeRoot(root: Root) {
  return stringifySections(collectSectionsFromRoot(root));
}

export default documentSchema;
