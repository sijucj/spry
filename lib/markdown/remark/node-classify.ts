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
 * - A remark plugin (`nodeClassifier`) that:
 *   - Runs mdastql selectors against the tree.
 *   - Applies user-defined classification rules.
 *   - Optionally builds a catalog of classifications.
 * - Helpers to:
 *   - Build static classifier lists (`staticClassifiers`).
 *   - Materialize a catalog onto `root.data` (`catalogToRootData`).
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
 */

import type { Root, RootContent } from "npm:@types/mdast@^4";
import type { Plugin } from "npm:unified@^11";

import { mdastql } from "./mdastql.ts";

export type ClassificationNamespace = string;
export type ClassificationPath = string;

export type AnyBaggage = Record<string, unknown>;

/**
 * A single classification instance attached to a node:
 *
 * - `path` identifies the specific class within a namespace.
 * - `baggage` carries arbitrary, structured metadata associated with this
 *   classification (e.g. IDs, severity, feature flags, etc.).
 */
export type Classification<Baggage extends AnyBaggage> = {
  readonly path: ClassificationPath;
  readonly baggage?: Baggage;
};

/**
 * Per-node class map: namespace → list of classifications.
 */
export type NodeClassMap<Baggage extends AnyBaggage> = Record<
  ClassificationNamespace,
  Classification<Baggage>[]
>;

/**
 * Data shape we attach to nodes that are classified.
 *
 * (We intersect this into remark/unist `Data` at usage sites.)
 */
export interface ClassifiedNodeData<Baggage extends AnyBaggage> {
  readonly class?: NodeClassMap<Baggage>;
}

/**
 * Node type with guaranteed `data.class` map.
 */
export type ClassedNode<
  T extends { data?: RootContent["data"] },
  Baggage extends AnyBaggage,
> = T & {
  data: RootContent["data"] & {
    class: NodeClassMap<Baggage>;
  };
};

/**
 * Catalog type: namespace → path → nodes.
 *
 * This is purely an in-memory structure. The plugin no longer decides
 * where it is stored; callers decide via the `catalog` callback.
 *
 * Note: the catalog does not carry `baggage`—it is an index of where
 * particular (namespace, path) pairs occur.
 */
export type ClassifierCatalog = Record<
  ClassificationNamespace,
  Record<ClassificationPath, RootContent[]>
>;

/**
 * Single classification entry produced by a rule.
 *
 * - `namespace` is the top-level classifier namespace.
 * - `path` is one or more classification paths within that namespace.
 * - `baggage` is optional extra metadata to attach to each (namespace, path)
 *   classification entry applied to the target nodes.
 */
export interface ClassificationEntry<
  Baggage extends AnyBaggage = AnyBaggage,
> {
  readonly namespace: ClassificationNamespace;
  readonly path: ClassificationPath | ClassificationPath[];
  readonly baggage?: Baggage;
}

/**
 * Single classifier rule.
 */
export interface NodeClassifierRule<
  Baggage extends AnyBaggage = AnyBaggage,
> {
  readonly nodes: readonly string[] | ((root: Root) => Iterable<RootContent>);
  readonly classify: (
    found: readonly RootContent[],
  ) =>
    | false
    | ClassificationEntry<Baggage>
    | Iterator<ClassificationEntry<Baggage>>;
}

/**
 * Options for the nodeClassifier plugin.
 *
 * The `Baggage` type describes the shape of the per-classification metadata
 * carried on nodes in `NodeClassMap<Baggage>`.
 */
export interface NodeClassifierOptions<
  Baggage extends AnyBaggage = AnyBaggage,
> {
  readonly classifiers: (
    root: Root,
  ) => Iterable<NodeClassifierRule<Baggage>>;

  readonly catalog?: <CC extends ClassifierCatalog>(
    catalog: CC,
    root: Root,
  ) => void;
}

/**
 * Convenience: wrap a fixed list of rules into a classifier factory.
 */
export function staticClassifiers<
  Baggage extends AnyBaggage = AnyBaggage,
>(
  ...rules: NodeClassifierRule<Baggage>[]
): (root: Root) => Iterable<NodeClassifierRule<Baggage>> {
  return (_root: Root) => rules;
}

/**
 * Convenience: create a catalog callback that stores the catalog on
 * `root.data[fieldName]`.
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
 *
 * Note: at runtime we only check that `data.class` exists and is an object;
 * the specific `Baggage` type is enforced at compile time.
 */
export function hasNodeClass<
  T extends { data?: RootContent["data"] },
  Baggage extends AnyBaggage,
>(
  node: T,
): node is ClassedNode<T, Baggage> {
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

/**
 * remark plugin: classify nodes based on selectors or a node-supplying
 * function, and attach `Classification<Baggage>` entries to node.data.class.
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
    const ensureClassMap = (
      node: RootContent,
    ): NodeClassMap<AnyBaggage> => {
      const anyNode = node as RootContent & {
        data?:
          | (RootContent["data"] & {
            class?: NodeClassMap<AnyBaggage>;
          })
          | undefined;
      };

      if (!anyNode.data) {
        anyNode.data = {} as RootContent["data"];
      }

      const data = anyNode.data as RootContent["data"] & {
        class?: NodeClassMap<AnyBaggage>;
      };

      if (!data.class || typeof data.class !== "object") {
        data.class = {};
      }

      return data.class;
    };

    const applyClassificationEntry = (
      entry: ClassificationEntry<AnyBaggage>,
      nodes: readonly RootContent[],
    ) => {
      const { namespace, path, baggage } = entry;
      const paths = Array.isArray(path) ? path : [path];

      for (const node of nodes) {
        const classMap = ensureClassMap(node);

        const existingList = classMap[namespace] ??
          (classMap[namespace] = [] as Classification<AnyBaggage>[]);

        for (const p of paths) {
          // Avoid duplicate path entries; keep the first baggage we see.
          if (!existingList.some((c) => c.path === p)) {
            existingList.push(
              baggage ? { path: p, baggage } : { path: p },
            );
          }
        }

        if (catalog) {
          const byNamespace = catalog[namespace] ??
            (catalog[namespace] = {} as Record<
              ClassificationPath,
              RootContent[]
            >);

          for (const p of paths) {
            const bucket = byNamespace[p] ??
              (byNamespace[p] = [] as RootContent[]);
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

      if ("namespace" in result) {
        // Single classification entry.
        applyClassificationEntry(
          result as ClassificationEntry<AnyBaggage>,
          foundNodes,
        );
      } else {
        // Iterator of classification entries.
        const iterator = result as Iterator<ClassificationEntry<AnyBaggage>>;
        let step = iterator.next();
        while (!step.done) {
          applyClassificationEntry(step.value, foundNodes);
          step = iterator.next();
        }
      }
    };

    for (const rule of rules) {
      const { nodes, classify } = rule;

      if (Array.isArray(nodes)) {
        if (nodes.length === 0) continue;

        for (const selectorText of nodes) {
          const { nodes: selectorNodes } = mdastql(root, selectorText);
          if (!selectorNodes.length) continue;

          runRuleOnNodes(selectorNodes, classify);
        }

        continue;
      }

      if (typeof nodes === "function") {
        const iterable = nodes(root);
        const foundNodes = Array.from(iterable);
        if (!foundNodes.length) continue;

        runRuleOnNodes(foundNodes, classify);
        continue;
      }
    }

    if (catalog && catalogCallback) {
      catalogCallback(catalog, root);
    }
  };
};

export default nodeClassifier;
