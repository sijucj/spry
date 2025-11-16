/**
 * @module node-classify
 *
 * Markdown / mdast classification utilities and a remark plugin for attaching
 * structured "classes" to nodes based on selectors, frontmatter, or arbitrary
 * logic.
 *
 * # Overview
 *
 * This module provides:
 *
 * - A lightweight "class map" type (`NodeClassMap`) attached to mdast nodes.
 * - A remark plugin (`documentClassifier`) that:
 *   - Runs mdastql selectors against the tree.
 *   - Applies user-defined classification rules.
 *   - Optionally builds a catalog of classifications.
 * - Helpers to:
 *   - Build static classifier lists (`staticClassifiers`).
 *   - Materialize a catalog onto `root.data` (`catalogToRootData`).
 *   - Drive classifiers directly from document frontmatter
 *     (`classifiersFromFrontmatter`).
 *
 * The core idea is to treat Markdown documents as "classifiable" content:
 * headings, paragraphs, code blocks, etc. can be tagged with roles, kinds,
 * tags, or any other classification key/value you need. Once attached, those
 * classes can be used downstream for:
 *
 * - Test/documentation structures (projects, suites, plans, cases, steps).
 * - Automated navigation, TOCs, and document outlines.
 * - Extraction of specific sections (e.g., "test-strategy" sections).
 * - Cross-document catalogs of important nodes.
 * - Code generation / orchestration based on annotated headings or blocks.
 *
 * # Node classes
 *
 * Each classified node carries a `data.class` field conforming to
 * `NodeClassMap`:
 *
 *   type NodeClassMap = Record<string, string | string[]>;
 *
 * Keys are arbitrary strings (e.g. `"role"`, `"kind"`, `"tag"`), and values
 * are either a single string or a list of strings. The plugin handles
 * merging and deduplication when the same key is assigned multiple times.
 *
 * The `hasNodeClass` type guard lets you safely refine any mdast node to a
 * `ClassedNode<T>` with a guaranteed `data.class` map.
 *
 * # documentClassifier plugin
 *
 * The `documentClassifier` remark plugin is the engine that applies
 * classifications. It is configured with:
 *
 *   - `classifiers(root)` — a function that returns an iterable of
 *     `DocumentClassifierRule`s for the given root.
 *   - `catalog(catalog, root)?` — an optional callback that receives a
 *     `ClassifierCatalog` after all classifications are applied.
 *
 * A `DocumentClassifierRule` consists of:
 *
 *   - `mdastSelectors`: an array of mdastql selector strings.
 *   - `classify(found)`: a function that receives the nodes selected by a
 *     given selector and returns one of:
 *       - `false` → skip this rule for these nodes.
 *       - a single `{ key, value }` entry.
 *       - an `Iterator<{ key, value }>` of multiple class entries.
 *
 * The plugin:
 *
 *   - Runs each selector via `mdastql(root, selectorText)`.
 *   - Passes the resulting nodes into `classify(nodes)`.
 *   - Applies the returned class entries to each node in `nodes`, merging
 *     with any existing `data.class` keys and values.
 *
 * The `classify` return type is intentionally flexible:
 *
 *   - For simple cases, return a single `{ key, value }`.
 *   - For richer cases (multiple keys or multi-step logic), yield multiple
 *     `{ key, value }` entries via an iterator/generator.
 *
 * See the tests for concrete examples of each pattern.
 *
 * # Classification catalog
 *
 * When a `catalog` callback is provided in `DocumentClassifierOptions`:
 *
 *   - The plugin builds a `ClassifierCatalog`:
 *
 *       type ClassifierCatalog = Record<
 *         string,                  // class key (e.g. "role")
 *         Record<string, RootContent[]> // class value → nodes
 *       >;
 *
 *   - Every applied classification updates this catalog, keyed by class key
 *     and value, with an array of nodes that received that classification.
 *   - After all rules are processed, the catalog is passed to:
 *
 *       catalog(catalog, root).
 *
 * The plugin itself does not decide where the catalog is stored. The callback
 * can:
 *
 *   - Attach it to `root.data` via `catalogToRootData("classifierCatalog")`.
 *   - Log it, aggregate it, or publish it elsewhere.
 *
 * This makes the catalog behavior fully opt-in and caller-controlled.
 *
 * # Helpers
 *
 * - `staticClassifiers(...rules)`:
 *     Wraps a static list of `DocumentClassifierRule`s into a
 *     `(root) => Iterable<DocumentClassifierRule>` factory, useful when you
 *     want fully static rules without inspecting the root.
 *
 * - `catalogToRootData(fieldName?)`:
 *     Returns a `catalog` callback that simply stores the catalog under
 *     `root.data[fieldName]`. This mimics the old behavior where the catalog
 *     lived at `root.data.classifierCatalog`, while remaining opt-in.
 *
 * - `classifiersFromFrontmatter(options?)`:
 *     Builds classifiers from the document frontmatter parsed by the
 *     `documentFrontmatter` plugin. It expects a frontmatter key that
 *     contains an array describing classification rules. By default, this key
 *     is `"doc-classify"`, but can be changed via `options.key`.
 *
 * # Frontmatter-driven classification
 *
 * When used together with:
 *
 *   - `remark-frontmatter` (to create the YAML node), and
 *   - `documentFrontmatter` (to parse YAML and attach `documentFrontmatter`),
 *
 * you can describe classification rules directly in YAML frontmatter and let
 * `classifiersFromFrontmatter()` turn them into `DocumentClassifierRule`s.
 *
 * The frontmatter DSL is designed to be author-friendly while remaining
 * flexible:
 *
 *   - Each entry must specify `select` (string or string[]) with mdastql
 *     selectors.
 *   - Class keys can be declared via:
 *       - shorthand keys (e.g. `role: project`), or
 *       - a nested `class` object (e.g. `class: { role: project, tag: [x,y] }`)
 *     or both, with values merged.
 *
 * Multiple keys can be applied to the same selector, and they are exposed as
 * an iterator of `{ key, value }` internally.
 *
 * # Typical pipelines and use cases
 *
 * Although this module is generic, common patterns include:
 *
 * - Test documentation / Qualityfolio-like hierarchies
 *   - Using headings as `project`, `test-strategy`, `test-plan`,
 *     `test-case`, etc.
 *   - Building catalogs by `role` to drive UIs or further processing.
 *
 * - Structured documents with semantic sections
 *   - Tagging headings and sections with semantic roles (`intro`,
 *     `background`, `api-docs`, `examples`, etc.).
 *   - Extracting specific sections or generating TOCs.
 *
 * - Content-aware tools and orchestration
 *   - Driving scripts or pipelines based on classified nodes.
 *   - Linking code fences, tables, or lists to conceptual roles for later
 *     processing.
 *
 * In practice, most real-world usage combines:
 *
 *   - Frontmatter-driven classifiers (`classifiersFromFrontmatter`) for
 *     author-facing configuration.
 *   - Additional programmatic classifiers (via `staticClassifiers` or custom
 *     factories) for richer or dynamic behavior.
 *
 * # Examples
 *
 * To keep this module focused, inline examples are limited. For the best,
 * fully worked examples of:
 *
 *   - Single `{ key, value }` classifications.
 *   - Iterator-based `classify` with multiple entries.
 *   - Generator-based classifier factories.
 *   - Frontmatter-driven classifiers using `"doc-classify"`.
 *   - Catalog handling and attachment via `catalogToRootData`.
 *
 * please refer to the corresponding test file:
 *
 *   - `doc-classify_test.ts`
 *
 * The tests are written to serve as executable documentation for both the
 * API and the intended developer experience.
 */
import type { Root, RootContent } from "npm:@types/mdast@^4";
import type { Plugin } from "npm:unified@^11";

import { isRootWithDocumentFrontmatter } from "./doc-frontmatter.ts";
import { mdastql } from "./mdastql.ts";

/**
 * Per-node class map: superclass key → string or list of strings.
 */
export type NodeClassMap = Record<string, string | string[]>;

/**
 * Data shape we attach to nodes that are classified.
 *
 * (We intersect this into remark/unist `Data` at usage sites.)
 */
export interface ClassifiedNodeData {
  class?: NodeClassMap;
}

/**
 * Node type with guaranteed `data.class` map.
 */
export type ClassedNode<T extends { data?: RootContent["data"] }> = T & {
  data: RootContent["data"] & {
    class: NodeClassMap;
  };
};

/**
 * Catalog type: superclass → subclass → nodes.
 *
 * This is purely an in-memory structure. The plugin no longer decides
 * where it is stored; callers decide via the `catalog` callback.
 */
export type ClassifierCatalog = Record<
  string,
  Record<string, RootContent[]>
>;

/**
 * Single classification entry.
 */
export interface ClassificationEntry {
  readonly superclass: string;
  readonly subclass: string | string[];
}

/**
 * Single classifier rule:
 *
 * - `nodes`:
 *     - `readonly string[]` → treated as mdastql selector strings; each
 *       selector is run separately and passed into `classify`.
 *     - `(root: Root) => Iterable<RootContent>` → a function that directly
 *       supplies the nodes to classify in one shot.
 *
 * - `classify(found)`:
 *     - receives the nodes found for a given selector (string[] case) or the
 *       nodes produced by the function (function case), and returns:
 *       - false → skip this rule for these nodes
 *       - a single { superclass, subclass }
 *       - an Iterator<{ superclass, subclass }> of multiple class entries.
 */
export interface NodeClassifierRule {
  readonly nodes: readonly string[] | ((root: Root) => Iterable<RootContent>);
  readonly classify: (
    found: readonly RootContent[],
  ) => false | ClassificationEntry | Iterator<ClassificationEntry>;
}

/**
 * Options for the documentClassifier plugin.
 *
 * - `classifiers` is required and returns an Iterable (array or generator)
 *   so rules can be dynamic and depend on the parsed root.
 * - `catalog` is optional: if provided, we build a ClassifierCatalog and
 *   hand it to this callback after all classifications have been applied.
 *   The callback decides where (or whether) to store the catalog.
 */
export interface NodeClassifierOptions {
  /**
   * Function that receives the mdast root and returns an iterable
   * of classifier rules (array, generator, etc.).
   */
  readonly classifiers: (root: Root) => Iterable<NodeClassifierRule>;

  /**
   * Optional catalog handler:
   * If provided, a ClassifierCatalog is built and passed into this callback
   * after all classification is complete.
   *
   * The callback is responsible for deciding what to do with the catalog
   * (e.g., attach it to root.data, log it, store elsewhere, etc.).
   */
  readonly catalog?: <CC extends ClassifierCatalog>(
    catalog: CC,
    root: Root,
  ) => void;
}

/**
 * Convenience: wrap a fixed list of rules into a classifier factory.
 *
 * Example:
 *   remark().use(documentClassifier, {
 *     classifiers: staticClassifiers(ruleA, ruleB),
 *   });
 */
export function staticClassifiers(
  ...rules: NodeClassifierRule[]
): (root: Root) => Iterable<NodeClassifierRule> {
  return (_root: Root) => rules;
}

/**
 * Convenience: create a catalog callback that stores the catalog on
 * `root.data[fieldName]`. This mirrors the old behavior where the plugin
 * always wrote to `root.data.classifierCatalog`, but is now opt-in.
 *
 * Example:
 *   remark().use(documentClassifier, {
 *     classifiers: staticClassifiers(...),
 *     catalog: catalogToRootData("classifierCatalog"),
 *   });
 */
export function catalogToRootData(
  fieldName = "classifierCatalog",
): (catalog: ClassifierCatalog, root: Root) => void {
  return (catalog, root) => {
    const anyRoot = root as Root & { data?: Record<string, unknown> };
    if (!anyRoot.data) {
      anyRoot.data = {};
    }
    (anyRoot.data as Record<string, unknown>)[fieldName] = catalog;
  };
}

/**
 * Type guard: does this node have a strongly-typed `data.class` map?
 */
export function hasNodeClass<T extends { data?: RootContent["data"] }>(
  node: T,
): node is ClassedNode<T> {
  if (!node || typeof node !== "object") return false;

  const anyNode = node as {
    data?: (RootContent["data"] & { class?: unknown }) | undefined;
  };
  if (!anyNode.data || typeof anyNode.data !== "object") return false;

  const data = anyNode.data as RootContent["data"] & { class?: unknown };
  if (!("class" in data)) return false;

  const cls = data.class;
  return !!cls && typeof cls === "object";
}

// Small internal helpers for the frontmatter-based classifier support.

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
 * Helper: build classifiers from document frontmatter.
 *
 * Designed to be passed directly as DocumentClassifierOptions.classifiers:
 *
 *   remark()
 *     .use(remarkFrontmatter)
 *     .use(documentFrontmatter)
 *     .use(documentClassifier, {
 *       classifiers: classifiersFromFrontmatter(),
 *     });
 *
 * Frontmatter DSL example:
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
 * Each entry must have:
 *   - select: string | string[]
 *
 * Class keys can be declared in two ways:
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
 */
export function classifiersFromFrontmatter(
  options?: {
    readonly classifiersFromFM?: (fm: Dict) => Array<unknown>;
  },
): (root: Root) => Iterable<NodeClassifierRule> {
  const { classifiersFromFM = (fm: Dict) => fm["doc-classify"] } = options ??
    {};

  return (root: Root): Iterable<NodeClassifierRule> => {
    if (!isRootWithDocumentFrontmatter(root)) return [];

    const fm = root.data.documentFrontmatter.parsed.fm as Dict;
    const raw = classifiersFromFM(fm);

    if (!Array.isArray(raw)) return [];

    const rules: NodeClassifierRule[] = [];

    for (const entry of raw) {
      if (!isPlainObject(entry)) continue;

      const e = entry as Dict;
      const selectRaw = e.select;

      let selectors: string[];
      if (typeof selectRaw === "string") {
        selectors = [selectRaw];
      } else if (
        Array.isArray(selectRaw) &&
        selectRaw.every((s) => typeof s === "string")
      ) {
        selectors = [...selectRaw] as string[];
      } else {
        // No usable selector → skip this entry
        continue;
      }

      // Build class map from both "class" and shorthand keys.
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

      const classEntries: ClassificationEntry[] = Object.entries(classMap).map(
        ([superclass, subclass]) => ({ superclass, subclass }),
      );

      if (!classEntries.length) continue;

      const classify: NodeClassifierRule["classify"] = (found) => {
        if (!found.length) return false;
        if (classEntries.length === 1) return classEntries[0]!;
        return classEntries.values();
      };

      rules.push({
        nodes: selectors, // <-- selectors as mdastql strings
        classify,
      });
    }

    return rules;
  };
}

/**
 * remark plugin: classify nodes based on either:
 *   - mdastql selector strings (NodeClassifierRule.nodes as string[]), or
 *   - a function that directly returns nodes to classify.
 *
 * For string[]:
 *   - Each selector is run via mdastql(root, selectorText).
 *   - classify(nodesForSelector) is called per selector.
 *
 * For function:
 *   - The function is invoked once with the root.
 *   - classify(allFoundNodes) is called once.
 *
 * In both cases, the results of classify(...) are merged into node.data.class.
 */
export const nodeClassifier: Plugin<[NodeClassifierOptions], Root> = (
  options,
) => {
  const { classifiers, catalog: catalogCallback } = options;

  return (root: Root) => {
    const rulesIterable = classifiers(root);
    const rules = Array.from(rulesIterable);

    // Only build a catalog if a callback is supplied.
    const catalog: ClassifierCatalog | undefined = catalogCallback
      ? {}
      : undefined;

    // If no rules and no catalog callback, nothing to do.
    if (rules.length === 0 && !catalog) return;

    // Helper: ensure a node has data + class map.
    const ensureClassMap = (node: RootContent): NodeClassMap => {
      const anyNode = node as RootContent & {
        data?: (RootContent["data"] & { class?: NodeClassMap }) | undefined;
      };

      if (!anyNode.data) {
        anyNode.data = {} as RootContent["data"];
      }

      const data = anyNode.data as RootContent["data"] & {
        class?: NodeClassMap;
      };

      if (!data.class || typeof data.class !== "object") {
        data.class = {};
      }

      return data.class;
    };

    // Helper to merge a new value (string or string[]) into an existing
    // value (string or string[]), returning the merged representation.
    const mergeClassValue = (
      existing: string | string[] | undefined,
      incoming: string | string[],
    ): string | string[] => {
      const incomingArr = Array.isArray(incoming) ? incoming : [incoming];

      if (existing === undefined) {
        // If only one incoming value, keep it as a scalar, otherwise array.
        return incomingArr.length === 1 ? incomingArr[0]! : incomingArr;
      }

      const existingArr = Array.isArray(existing) ? existing : [existing];
      const merged = [...existingArr];

      for (const val of incomingArr) {
        if (!merged.includes(val)) merged.push(val);
      }

      return merged.length === 1 ? merged[0]! : merged;
    };

    const applyClassificationEntry = (
      entry: ClassificationEntry,
      nodes: readonly RootContent[],
    ) => {
      const { superclass: key, subclass: value } = entry;
      const valuesArray = Array.isArray(value) ? value : [value];

      for (const node of nodes) {
        const classMap = ensureClassMap(node);

        // Merge this classification into the node's class map.
        const existing = classMap[key];
        classMap[key] = mergeClassValue(existing, value);

        // Update catalog if enabled.
        if (catalog) {
          const byKey = catalog[key] ??
            (catalog[key] = {} as Record<string, RootContent[]>);

          for (const v of valuesArray) {
            const bucket = byKey[v] ?? (byKey[v] = [] as RootContent[]);
            if (!bucket.includes(node)) {
              bucket.push(node);
            }
          }
        }
      }
    };

    const runRuleOnNodes = (
      foundNodes: readonly RootContent[],
      classify: NodeClassifierRule["classify"],
    ) => {
      if (!foundNodes.length) return;

      const result = classify(foundNodes);
      if (!result) return;

      if ("superclass" in result) {
        // Single classification
        applyClassificationEntry(result, foundNodes);
      } else {
        // Iterator of classifications
        let step = result.next();
        while (!step.done) {
          applyClassificationEntry(step.value, foundNodes);
          step = result.next();
        }
      }
    };

    for (const rule of rules) {
      const { nodes, classify } = rule;

      // Case 1: nodes is an array of mdastql selector strings.
      if (Array.isArray(nodes)) {
        if (nodes.length === 0) continue;

        for (const selectorText of nodes) {
          const { nodes: selectorNodes } = mdastql(root, selectorText);
          if (!selectorNodes.length) continue;

          runRuleOnNodes(selectorNodes, classify);
        }

        continue;
      }

      // Case 2: nodes is a function returning Iterable<RootContent>.
      if (typeof nodes === "function") {
        const iterable = nodes(root);
        const foundNodes = Array.from(iterable);
        if (!foundNodes.length) continue;

        runRuleOnNodes(foundNodes, classify);
        continue;
      }
    }

    // After all classification, invoke catalog callback if any.
    if (catalog && catalogCallback) {
      catalogCallback(catalog, root);
    }
  };
};

export default nodeClassifier;
