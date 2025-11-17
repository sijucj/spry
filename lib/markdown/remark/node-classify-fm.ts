/**
 * @module node-classify-fm
 *
 * Markdown / mdast classification helpers for node-classify remark plugin for
 * attaching structured "classes" to nodes based on frontmatter.
 */
import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";

import { assert } from "https://deno.land/std@0.198.0/assert/assert.ts";
import { visit } from "npm:unist-util-visit@^5";
import { isRootWithDocumentFrontmatter } from "./doc-frontmatter.ts";
import { isHeadingWithFrontmatter } from "./heading-frontmatter.ts";
import { ClassificationEntry, NodeClassifierRule } from "./node-classify.ts";

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClassValue(
  value: unknown,
): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strs = value.filter((v): v is string => typeof v === "string");
    if (!strs.length) return undefined;
    return strs.length === 1 ? strs[0] : strs;
  }
  return undefined;
}

/**
 * Build classification entries from a single frontmatter entry object.
 * Shared by document- and heading-level frontmatter handling.
 */
function classificationEntriesFromEntry(
  e: Dict,
): ClassificationEntry[] {
  const classMap: Record<string, string | string[]> = {};

  const classObj = e.class;
  if (isPlainObject(classObj)) {
    for (const [key, value] of Object.entries(classObj)) {
      const normalized = normalizeClassValue(value);
      if (normalized !== undefined) {
        classMap[key] = normalized;
      }
    }
  }

  for (const [key, value] of Object.entries(e)) {
    if (key === "select" || key === "class") continue;
    const normalized = normalizeClassValue(value);
    if (normalized !== undefined) {
      classMap[key] = normalized;
    }
  }

  return Object.entries(classMap).map(([superclass, subclass]) => ({
    superclass,
    subclass,
  }));
}

/**
 * Helper: build classifiers from document frontmatter and per-heading
 * frontmatter.
 *
 * Designed to be passed directly as NodeClassifierOptions.classifiers:
 *
 *   remark()
 *     .use(remarkFrontmatter)
 *     .use(documentFrontmatter)
 *     .use(headingFrontmatter)
 *     .use(nodeClassifier, {
 *       classifiers: classifiersFromFrontmatter(),
 *     });
 *
 * Document Frontmatter DSL example:
 *
 *   ---
 *   doc-classify:
 *     - select: h1
 *       role: project
 *     - select: h2
 *       role: test-strategy
 *     - select: h3
 *       role: test-plan
 *     - select: h4
 *       role: test-case
 *   ---
 *
 * Each document frontmatter entry must have:
 *   - select: string | string[]
 *
 * Document frontmatter class keys can be declared in two ways:
 *   1) Shorthand keys:
 *        - select: h1
 *          role: project
 *
 *   2) Nested "class" object:
 *        - select: h1
 *          class:
 *            role: project
 *            tag: [top, primary]
 *
 * Both forms may be combined; shorthand keys are merged with `class`.
 *
 * Each heading frontmatter entry must have either `nature` or `doc-classify` (no `select`):
 *
 *   doc-classify:
 *    - role: project
 *    - role2: another
 */
export function classifiersFromFrontmatter(
  options?: {
    readonly classifiersFromDocFM?: (fm: Dict) => Array<unknown>;
    readonly classifiersFromHeadFM?: (
      fm: Dict,
      node: Heading,
    ) => Array<unknown>;
  },
): (root: Root) => Iterable<NodeClassifierRule> {
  const {
    // Document-level classifiers default to fm["doc-classify"].
    // This mirrors the historical DSL and preserves backward compatibility.
    classifiersFromDocFM = (fm: Dict) => fm["doc-classify"],

    // Heading-level classifiers default to `nature` first, then fallback
    // to `doc-classify` inside *heading frontmatter*. That allows headings
    // to define their own local DSL without requiring a `select`.
    classifiersFromHeadFM = (fm: Dict) => fm["nature"] ?? fm["doc-classify"],
  } = options ?? {};

  return (root: Root): Iterable<NodeClassifierRule> => {
    // If there is no parsed FRONTMATTER at document level,
    // nothing can be built. Early exit prevents wasted traversal.
    if (!isRootWithDocumentFrontmatter(root)) return [];

    const fm = root.data.documentFrontmatter.parsed.fm as Dict;
    const rules: NodeClassifierRule[] = [];

    // ---------------------------------------------------------------------
    // 1) DOCUMENT-LEVEL CLASSIFIERS
    // ---------------------------------------------------------------------
    //
    // These behave like global rules: each entry must specify `select:` so
    // we can expand them into mdastql selector-driven NodeClassifierRules.
    //
    // These are run first so that heading-level FM can override or append.
    // ---------------------------------------------------------------------

    const rawDoc = classifiersFromDocFM(fm);
    if (Array.isArray(rawDoc)) {
      for (const entry of rawDoc) {
        if (!isPlainObject(entry)) continue;

        const selectRaw = entry.select;

        // Normalize the `select` field into a string[] of mdastql selectors.
        // If invalid or not provided → skip silently (authoring error).
        let selectors: string[];
        if (typeof selectRaw === "string") {
          selectors = [selectRaw];
        } else if (
          Array.isArray(selectRaw) &&
          selectRaw.every((s) => typeof s === "string")
        ) {
          selectors = [...selectRaw] as string[];
        } else {
          // No usable selector → no rule possible.
          continue;
        }

        // Generate one or more classification entries from the FM keys.
        // Handles shorthand keys and nested `class: {}` definitions.
        const classEntries = classificationEntriesFromEntry(entry);
        if (!classEntries.length) continue;

        // Wrap classifier entries into a NodeClassifierRule.
        // Each selector yields a separate call to classify() with the
        // mdastql-selected nodes.
        const classify: NodeClassifierRule["classify"] = (found) => {
          if (!found.length) return false;
          if (classEntries.length === 1) return classEntries[0]!;
          return classEntries.values();
        };

        rules.push({
          nodes: selectors, // mdastql selector strings
          classify,
        });
      }
    }

    // ---------------------------------------------------------------------
    // 2) HEADING-LEVEL CLASSIFIERS
    // ---------------------------------------------------------------------
    //
    // Unlike document-level FM, heading FM rules do NOT use `select`: they
    // apply strictly to the *heading that owns the FM*. This allows semantic
    // annotation of a single node without needing mdastql.
    //
    // We traverse all headings and lift their local FM objects using `visit()`.
    //
    // The key unobvious behavior:
    //    - If the heading has nested frontmatter inheritance, we ignore
    //      inherited FM — only local heading FM is used for rules.
    //    - Heading FM DSL produces either:
    //        • a single JSON object representing a rule, or
    //        • an array of rule objects
    //
    //    - Each rule object is transformed into classEntries and converted
    //      into a NodeClassifierRule that targets EXACTLY one node.
    // ---------------------------------------------------------------------

    if (classifiersFromHeadFM) {
      visit(root, "heading", (node) => {
        // Only headings enhanced by headingFrontmatter qualify.
        if (!isHeadingWithFrontmatter(node)) return;

        // Extract heading-local FM and feed it through the custom or default
        // classifier extraction strategy.
        let rawHeadRules = classifiersFromHeadFM(node.data.headingFM, node);

        // Allow the heading FM function to return a single object or an array.
        // Normalization ensures the main loop can treat everything uniformly.
        if (!Array.isArray(rawHeadRules) && !isPlainObject(rawHeadRules)) {
          return;
        }
        if (isPlainObject(rawHeadRules)) rawHeadRules = [rawHeadRules];
        assert(Array.isArray(rawHeadRules));

        for (const rule of rawHeadRules) {
          if (!isPlainObject(rule)) continue;

          // Convert the rule object into structured `{ superclass, subclass }` entries.
          const classEntries = classificationEntriesFromEntry(rule);
          if (!classEntries.length) continue;

          // Classification function for this heading node.
          // It ignores `found` entirely except for empty checks, because
          // heading-specific rules always apply to exactly one explicit node.
          const classify: NodeClassifierRule["classify"] = (found) => {
            if (!found.length) return false;
            if (classEntries.length === 1) return classEntries[0]!;
            return classEntries.values();
          };

          // This rule applies only to *this heading node*, never via mdastql.
          // We represent this as a function that returns the single node.
          rules.push({
            nodes: (_root: Root) => [node as unknown as RootContent],
            classify,
          });
        }
      });
    }

    return rules;
  };
}
