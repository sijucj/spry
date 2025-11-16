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
 *   - parent / children   – logical nesting
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
 * Built-in heading rule: any `heading` node at top level starts a section.
 * Sections are later nested by heading depth.
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
 * For a given array of sections, return the "innermost" section
 * covering an index (if any). Innermost = largest startIndex where start < i < end.
 */
function innermostSectionAtIndex(
  sections: readonly SectionSchema[],
  index: number,
): SectionSchema | undefined {
  let best: SectionSchema | undefined;
  for (const s of sections) {
    if (index > s.startIndex && index < s.endIndex) {
      if (!best || s.startIndex > best.startIndex) {
        best = s;
      }
    }
  }
  return best;
}

/**
 * Build heading hierarchy (parent/children) and recompute endIndex spans
 * based on heading depth.
 */
function buildHeadingHierarchy(
  headings: readonly HeadingSectionSchema[],
  totalSiblings: number,
): void {
  if (!headings.length) return;

  const sorted = [...headings].sort(
    (a, b) => a.startIndex - b.startIndex,
  );

  const stack: HeadingSectionSchema[] = [];

  for (const h of sorted) {
    while (stack.length && stack[stack.length - 1].depth >= h.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      (h as { parent?: SectionSchema }).parent = parent;
      parent.children.push(h);
    } else {
      (h as { parent?: SectionSchema }).parent = undefined;
    }
    stack.push(h);
  }

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    let end = totalSiblings;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      if (next.depth <= current.depth) {
        end = next.startIndex;
        break;
      }
    }
    (current as { endIndex: number }).endIndex = end;
  }
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

    const parentNode = tree;
    const headingSectionsByStart: Map<number, HeadingSectionSchema> = new Map();
    const allSectionsForNamespace: SectionSchema[] = [];

    // First pass: headings (to use as "parent" for markers and for hierarchy).
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

        const data = (node.data ??= {});
        const catalog = (data as Data & {
          sectionSchema?: Record<string, SectionSchema>;
        }).sectionSchema ??= {};

        catalog[namespace] = section;

        headingSectionsByStart.set(i, section);
        allSectionsForNamespace.push(section);

        if (encountered) {
          encountered(section, node);
        }
      }
    }

    // Build heading hierarchy and adjust heading spans based on depth.
    const headingSections = [...headingSectionsByStart.values()];
    buildHeadingHierarchy(headingSections, siblings.length);

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

        const data = (node.data ??= {});
        const catalog = (data as Data & {
          sectionSchema?: Record<string, SectionSchema>;
        }).sectionSchema ??= {};

        catalog[namespace] = section;

        allSectionsForNamespace.push(section);

        if (encountered) {
          encountered(section, node);
        }
      }
    }

    // Third pass: populate belongsToSection with innermost section per index.
    if (enrichWithBelongsTo && allSectionsForNamespace.length > 0) {
      for (let i = 0; i < siblings.length; i++) {
        const node = siblings[i];
        const inner = innermostSectionAtIndex(allSectionsForNamespace, i);
        if (!inner) continue;

        const d2 = (node.data ??= {});
        const belongs = (d2 as Data & {
          belongsToSection?: Record<string, SectionSchema>;
        }).belongsToSection ??= {};

        belongs[namespace] = inner;
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
  let best: HeadingSectionSchema | undefined;
  for (const section of headingSectionsByStart.values()) {
    if (section.startIndex <= index && index < section.endIndex) {
      if (!best || section.startIndex > best.startIndex) {
        best = section;
      }
    }
  }
  return best;
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
    const base = (() => {
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
          const t = "title" in m ? ` title="${m.title}"` : "";
          return `marker: kind=${m.markerKind}${t}`;
        }
      }
    })();

    const childCount = s.children.length;
    const parentInfo = s.parent
      ? ` parent@${s.parent.startIndex}`
      : " parent=null";

    return `${base}${parentInfo} children=${childCount}`;
  };

  const nodeLabel = (node: RootContent, index: number) => {
    let snippet = "";
    if ("value" in node && typeof node.value === "string") {
      snippet = node.value;
    } else if ("children" in node && Array.isArray(node.children)) {
      const texts = node.children
        .filter((c) => "value" in c && typeof c.value === "string")
        // deno-lint-ignore no-explicit-any
        .map((c: any) => c.value)
        .join(" ");
      snippet = texts;
    }
    snippet = snippet.replace(/\s+/g, " ").trim();
    if (snippet.length > 40) {
      snippet = `${snippet.slice(0, 37)}...`;
    }
    return `node[${index}]: type=${node.type}${snippet ? ` "${snippet}"` : ""}`;
  };

  const asciiTree = () => {
    const lines: string[] = [];
    const nsKeys = [...byNs.keys()].sort();

    const dumpNode = (
      s: SectionSchema,
      prefix: string,
      isLast: boolean,
    ) => {
      const connector = isLast ? "└─ " : "├─ ";
      lines.push(
        `${prefix}${connector}${
          sectionLabel(s)
        } [${s.startIndex}, ${s.endIndex})`,
      );

      const ns = s.namespace;
      const rootChildren = s.parentNode.children as RootContent[];

      const belongingNodes = rootChildren
        .map((n, idx) => ({ n, idx }))
        .filter(({ n }) =>
          hasBelongsToSection(n) && n.data.belongsToSection?.[ns] === s
        )
        .sort((a, b) => a.idx - b.idx);

      const sectionChildren = [...s.children].sort(
        (a, b) => a.startIndex - b.startIndex,
      );

      const childEntries: Array<
        | { kind: "section"; section: SectionSchema }
        | { kind: "node"; node: RootContent; index: number }
      > = [];

      for (const childSection of sectionChildren) {
        childEntries.push({ kind: "section", section: childSection });
      }
      for (const { n, idx } of belongingNodes) {
        childEntries.push({ kind: "node", node: n, index: idx });
      }

      const childPrefix = prefix + (isLast ? "   " : "│  ");

      childEntries.forEach((entry, idx) => {
        const lastChild = idx === childEntries.length - 1;
        if (entry.kind === "section") {
          dumpNode(entry.section, childPrefix, lastChild);
        } else {
          const nodeConnector = lastChild ? "└─ " : "├─ ";
          lines.push(
            `${childPrefix}${nodeConnector}${
              nodeLabel(entry.node, entry.index)
            }`,
          );
        }
      });
    };

    nsKeys.forEach((ns, nsIdx) => {
      lines.push(`namespace ${ns}`);
      const all = byNs.get(ns)!;
      const roots = all
        .filter((s) => s.parent == null)
        .sort((a, b) => a.startIndex - b.startIndex);
      roots.forEach((r, idx) => dumpNode(r, "  ", idx === roots.length - 1));
      if (nsIdx < nsKeys.length - 1) {
        lines.push("");
      }
    });

    return lines.join("\n");
  };

  return {
    sections: arr,
    sectionByNS: byNs,
    asciiTree,
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

export function stringifyRoot(root: Root) {
  return stringifySections(collectSectionsFromRoot(root));
}

export default documentSchema;
