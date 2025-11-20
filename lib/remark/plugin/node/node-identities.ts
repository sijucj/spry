/**
 * @module remark/node-identities
 *
 * @summary
 * A highly-extensible remark plugin that assigns **stable, multi-supplier
 * identities** to mdast nodes—derived from node structure, heading
 * frontmatter, and document-schema section metadata—while also allowing
 * callers to build **identity catalogs** and run custom event hooks.
 *
 * @description
 * This plugin is intended for advanced Markdown processing pipelines where
 * nodes must be addressable, classified, cross-referenced, or federated
 * across multiple upstream “identity suppliers.” It is especially useful in
 * systems that:
 *
 *   - Use **multiple remark plugins** (frontmatter, headingFrontmatter,
 *     documentSchema, injected nodes, code-frontmatter, etc.) and need
 *     a *unified identity model* after all transformations.
 *
 *   - Need to uniquely identify nodes based on **semantic cues**:
 *       - content-dependent signatures (`identityFromNode(node)`)
 *       - metadata (`identityFromFM(frontmatter, node)`)
 *       - structural or schema-based context
 *         (`identityFromSection(sectionInfo, node)`)
 *
 *   - Need to maintain a persistent **catalog** of identities → nodes,
 *     allowing later phases to perform lookups, crosslinks, or mapping
 *     between suppliers (e.g., “FOO id `abc123` refers to node X, while
 *     BAR identifies the same node as `xyz`, store both”).
 *
 * ## When to Use
 * - When building compilers, static site generators, documentation systems,
 *   schema-driven notebooks, or AI-assisted Markdown toolchains requiring:
 *     - repeatable node identification
 *     - provenance tracking
 *     - globally-composable indexing
 *     - deterministic references or anchors
 *
 * - When you want node identities that are:
 *     - **post-remark** (after all mutations)
 *     - **structurally stable**
 *     - **semantically meaningful**
 *     - **multi-sourced** (from different logical suppliers)
 *
 * - **Identity suppliers are part of your public API.**
 *   Treat `supplier` like a namespace: `"fm"`, `"schema"`, `"xref"`,
 *   `"external-db"`, etc. Once adopted, changing a supplier name breaks every
 *   consumer of the identity catalog. Version them as carefully as schemas.
 *
 * - **Defer identity assignment to the end of your pipeline.**
 *   Many remark plugins restructure or clone nodes. Run `nodeIdentities`
 *   *after* structural transforms so identities correspond to the final,
 *   stable shape of the tree—not some transient intermediate layout.
 *
 * - **Separate “where the identity comes from” from “how it is formatted”.**
 *   Use different suppliers for different semantics:
 *
 *     - `"fm"` for frontmatter-based IDs or slugs
 *     - `"schema"` for section / documentSchema IDs
 *     - `"content"` for hash-based or text-derived IDs
 *
 *   You can later combine them (e.g., build URLs from multiple suppliers),
 *   but keeping them separate lets you migrate or rotate one source at a time.
 *
 * - **Avoid identities based solely on positional data.**
 *   Line/column-based IDs feel stable but are easily invalidated by minor
 *   edits or upstream plugins. Prefer semantic anchors: frontmatter keys,
 *   headings, section labels, directive attributes, etc.
 *
 * - **Use `identityFromSection` for cross-cutting semantics.**
 *   SectionInfo (from documentSchema) gives you *contextual* identity:
 *   “this node belongs to the `objective` section of `study-xyz`.” That’s far
 *   more robust than “third paragraph in file.”
 *
 * - **Make `identityFromNode` narrowly focused.**
 *   Because it has no frontmatter or section context, it should be used for
 *   identities intrinsic to the node: hashes of code blocks, stable directive
 *   names, inline anchors, etc. Don’t overload it with cross-document logic.
 *
 * - **Be intentional with catalogs.**
 *   The `catalog()` callback gives you a global
 *
 *     `Record<supplier, Record<identity, Node>>`
 *
 *   This is powerful but easy to overuse. For large documents or many files,
 *   catalogs can be big. Use them when you truly need global lookups or
 *   cross-document references, otherwise rely on per-node `data.identities`.
 *
 * - **Use `identifiedAs` for observability and secondary indexes.**
 *   Instead of mutating unrelated state inside your identity suppliers,
 *   treat `identifiedAs(node, ids)` as the single event where you:
 *     - log diagnostics
 *     - build secondary indexes
 *     - attach derived metadata
 *     - detect conflicts or duplicates
 *
 * ## Using the Plugin
 *
 * ```ts
 * import { unified } from "npm:unified";
 * import remarkParse from "npm:remark-parse";
 * import { nodeIdentities } from "./node-identities.ts";
 *
 * const processor = unified()
 *   .use(remarkParse)
 *   // ... headingFrontmatter, documentSchema, etc.
 *   .use(nodeIdentities, {
 *     // purely node-based identities
 *     identityFromNode: (node) => {
 *       if (node.type === "code" && node.lang === "ts") {
 *         return { supplier: "content", identity: "ts-snippet" };
 *       }
 *       return false;
 *     },
 *
 *     // identities derived from heading frontmatter only
 *     identityFromFM: (fm, node) => {
 *       if (fm?.id && node.type === "heading") {
 *         return { supplier: "fm", identity: String(fm.id) };
 *       }
 *       return false;
 *     },
 *
 *     // identities derived from documentSchema section info
 *     identityFromSection: (sectionInfo, node) => {
 *       // sectionInfo is whatever documentSchema put on the node
 *       if ((sectionInfo as any)?.nature === "marker") {
 *         return { supplier: "schema", identity: "marker-section" };
 *       }
 *       return false;
 *     },
 *
 *     identifiedAs: (node, ids) => {
 *       // central place to react when a node gets identities
 *       // e.g., enforce uniqueness, log conflicts, etc.
 *       // console.debug(node.type, ids);
 *     },
 *
 *     catalog: (catalog) => {
 *       // optional global lookup table
 *       // catalog.fm["my-id"] -> heading node
 *     },
 *   });
 *
 * const file = await processor.process(markdownSource);
 * ```
 *
 * ## Result
 * - Each node that matched any identity supplier will contain:
 *
 *   ```ts
 *   node.data.identities = {
 *     content: ["ts-snippet"],
 *     fm: ["my-id"],
 *     schema: ["marker-section"],
 *   };
 *   ```
 *
 * - If a `catalog()` callback was supplied, you will receive:
 *
 *   ```ts
 *   {
 *     content: { "ts-snippet": Node, ... },
 *     fm:      { "my-id": Node, ... },
 *     schema:  { "marker-section": Node, ... },
 *   }
 *   ```
 *
 * This plugin is intentionally **low-level and composable**—it defines the
 * mechanism for supplying identities, not the policy. Your surrounding system
 * decides what constitutes an identity and how suppliers are interpreted.
 */

import type { Node, Root, RootContent } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { hasSectionSchema } from "../doc/doc-schema.ts";
import { isHeadingWithFrontmatter } from "./heading-frontmatter.ts";

export type TextIdentity = string;

export interface SuppliedIdentity<Supplier extends string = string> {
  readonly supplier: Supplier;
  readonly identity: TextIdentity | TextIdentity[];
}

export type NodeIdentities<Supplier extends string = string> = Partial<
  Record<
    Supplier,
    TextIdentity[]
  >
>;

export interface NodeIdentitiesOptions<
  Supplier extends string = string,
  FM extends Record<string, unknown> = Record<string, unknown>,
  SectionInfo = unknown,
> {
  /**
   * Identity computed purely from the node itself.
   * No frontmatter, no section info is passed. Root is provided in case
   * you want to retrieve the identity from somewhere else.
   */
  readonly identityFromNode?: (node: Node, root: Root) =>
    | SuppliedIdentity<Supplier>
    | SuppliedIdentity<Supplier>[]
    | false
    | null
    | undefined;

  /**
   * Identities derived from heading frontmatter (attached by
   * headingFrontmatter plugin). Only called for headings with frontmatter.
   */
  readonly identityFromHeadingFM?: (fm: FM, node: Node, root: Root) =>
    | SuppliedIdentity<Supplier>
    | SuppliedIdentity<Supplier>[]
    | false
    | null
    | undefined;

  /**
   * Identities derived from section metadata (attached by documentSchema).
   * The first argument is the section object, not frontmatter.
   */
  readonly identityFromSection?: (
    sectionInfo: SectionInfo,
    node: Node,
    root: Root,
  ) =>
    | SuppliedIdentity<Supplier>
    | SuppliedIdentity<Supplier>[]
    | false
    | null
    | undefined;

  /**
   * Optional hook invoked after all suppliers have contributed identities
   * for a given node, but before catalog emission.
   */
  readonly identifiedAs?: (
    node: Node,
    ids: NodeIdentities<Supplier>,
  ) => void;

  /**
   * Optional callback that receives a global catalog of identities → nodes,
   * grouped by supplier.
   */
  readonly catalog?: (
    catalog: Record<Supplier, Record<TextIdentity, Node>>,
  ) => void;
}

// deno-lint-ignore no-explicit-any
type Any = any;

function mergeIdentities<Supplier extends string>(
  target: Partial<NodeIdentities<Supplier>>,
  value:
    | SuppliedIdentity<Supplier>
    | SuppliedIdentity<Supplier>[]
    | false
    | null
    | undefined,
): void {
  if (value === undefined || value === null || value === false) return;
  const supplied = Array.isArray(value) ? value : [value];
  for (const item of supplied) {
    const supplier = item.supplier;
    const identities = Array.isArray(item.identity)
      ? item.identity
      : [item.identity];

    if (!target[supplier]) {
      target[supplier] = [] as TextIdentity[];
    }

    const bucket = target[supplier] as TextIdentity[];
    for (const id of identities) {
      if (!bucket.includes(id)) {
        bucket.push(id);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Type guard
// ----------------------------------------------------------------------------

export function hasNodeIdentities<Supplier extends string = string>(
  node: Node,
): node is RootContent & { data: { identities: NodeIdentities<Supplier> } } {
  const data = (node as Any).data;
  if (!data || typeof data !== "object") return false;
  const ids = (data as Any).identities;
  if (!ids || typeof ids !== "object") return false;
  return true;
}

// ----------------------------------------------------------------------------
// Plugin
// ----------------------------------------------------------------------------

export const nodeIdentities: Plugin<
  [NodeIdentitiesOptions<Any, Any, Any>?],
  Root
> = (rawOptions?: NodeIdentitiesOptions<Any, Any, Any>) => {
  const options = (rawOptions ?? {}) as NodeIdentitiesOptions<
    string,
    Record<string, unknown>,
    Any
  >;

  const {
    identityFromNode,
    identityFromHeadingFM,
    identityFromSection,
    identifiedAs,
    catalog,
  } = options;

  return (tree: Root) => {
    const catalogDict: Record<string, Map<TextIdentity, Node>> = {};

    //     const data = (root.data ??= {});
    // const existing: readonly Graph[] = Array.isArray((data as Any).graphs)
    //   ? (data as Any).graphs
    //   : [];
    // (data as Any).graphs = [...existing, graph];

    visit(tree, (node) => {
      const perNodeIdentities: Partial<NodeIdentities<string>> = {};

      // 1. identityFromNode (purely node-based)
      if (identityFromNode) {
        mergeIdentities(perNodeIdentities, identityFromNode(node, tree));
      }

      // 2. identityFromFM (only if heading with frontmatter)
      if (identityFromHeadingFM && isHeadingWithFrontmatter(node)) {
        mergeIdentities(
          perNodeIdentities,
          identityFromHeadingFM(node.data.headingFM, node, tree),
        );
      }

      // 3. identityFromSection (only if has section schema)
      if (identityFromSection && hasSectionSchema(node)) {
        mergeIdentities(
          perNodeIdentities,
          identityFromSection(node.data.sectionSchema, node, tree),
        );
      }

      const suppliers = Object.keys(perNodeIdentities);
      if (suppliers.length > 0) {
        const data = node.data ??= {};

        const finalized = perNodeIdentities as NodeIdentities<string>;
        (data as Any).identities = finalized;

        if (identifiedAs) {
          identifiedAs(node, finalized);
        }

        if (catalog) {
          for (const supplier of suppliers) {
            const ids = finalized[supplier] ?? [];
            if (ids.length === 0) continue;

            let byId = catalogDict[supplier];
            if (!byId) {
              byId = new Map<TextIdentity, Node>();
              catalogDict[supplier] = byId;
            }

            for (const id of ids) {
              byId.set(id, node);
            }
          }
        }
      }
    });

    if (catalog) {
      const out: Record<string, Record<TextIdentity, Node>> = {} as Any;

      for (const [supplier, byId] of Object.entries(catalogDict)) {
        const m: Record<TextIdentity, Node> = {};
        for (const [id, node] of byId.entries()) {
          m[id] = node;
        }
        out[supplier] = m;
      }

      catalog?.(out);
    }

    return tree;
  };
};

export default nodeIdentities;
