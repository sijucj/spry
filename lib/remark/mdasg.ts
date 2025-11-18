import type { Root, RootContent } from "types/mdast";
import { visit } from "unist-util-visit";
import { queryPosixPI } from "../universal/posix-pi.ts";
import { isCodeWithFrontmatterNode } from "./code-frontmatter.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Human-readable graph identifier. */
export type NodeGraphName = string;

/**
 * Edge between node references.
 *
 * - N: NodeRef instance type for endpoints (i.e., mdast Content)
 * - Label: semantic edge label ("depends-on", "flows-to", etc.)
 * - Baggage: edge-level metadata
 */
export interface NodeEdge<
  N extends RootContent = RootContent,
  Label = string,
  Baggage = unknown,
> {
  readonly from: N;
  readonly to: N;
  readonly label?: Label;
  readonly baggage?: Baggage;
}

/**
 * A graph layered on top of the markdown AST.
 */
export interface NodeGraph<
  GraphBaggage = unknown,
  N extends RootContent = RootContent,
  E extends NodeEdge<N> = NodeEdge<N>,
> {
  readonly name: NodeGraphName;
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
  readonly baggage?: GraphBaggage;
}

/** Heterogeneous list of graphs. */
export type NodeGraphCollection = readonly NodeGraph<Any, Any, Any>[];

/**
 * Top-level type guard.
 *
 * Returns true only if:
 *   - root.data exists
 *   - root.data.graphs exists
 *   - root.data.graphs is an array
 */
export function isGraphsCollection(
  root: Root,
): root is Root & { data: Root["data"] & { graphs: NodeGraphCollection } } {
  const data = root.data;
  return Boolean(
    data &&
      typeof data === "object" &&
      Array.isArray((data as Any).graphs),
  );
}

/**
 * Factory: creates ergonomic helper methods bound to a specific Root.
 *
 * You can pass a more specific Graph type to get typed results:
 *
 *    const gq = mdastGraphs<CellGraph>(root)
 *    const g = gq.find("cell-deps")  // CellGraph | undefined
 */
export function mdastGraphs<
  Graph extends NodeGraph<Any, Any, Any> = NodeGraph<Any, Any, Any>,
>(root: Root) {
  function has() {
    return isGraphsCollection(root);
  }

  function all() {
    if (isGraphsCollection(root)) {
      return root.data.graphs as readonly Graph[];
    }
    return [] as const as readonly Graph[];
  }

  function add(graph: Graph) {
    const data = (root.data ??= {});
    const existing: readonly Graph[] = Array.isArray((data as Any).graphs)
      ? (data as Any).graphs
      : [];
    (data as Any).graphs = [...existing, graph];
  }

  function find(name: NodeGraphName) {
    return all().find((g) => g.name === name);
  }

  function count() {
    return all().length;
  }

  function names() {
    return all().map((g) => g.name);
  }

  function first() {
    return all()[0];
  }

  function some(fn: (g: Graph) => boolean) {
    return all().some(fn);
  }

  function every(fn: (g: Graph) => boolean) {
    return all().every(fn);
  }

  function filter(fn: (g: Graph) => boolean) {
    return all().filter(fn);
  }

  function map<T>(fn: (g: Graph) => T) {
    return all().map(fn);
  }

  return {
    root,
    has,
    all,
    add,
    find,
    count,
    names,
    first,
    some,
    every,
    filter,
    map,
  };
}

/* ------------------------------------------------------------------------------------------------
 * DAG builder: dagFromNodes
 * ------------------------------------------------------------------------------------------------ */

/**
 * Simplified DAG builder: constructs a DAG using a `dependsOn` rule.
 *
 * - N: mdast Content node type (NodeRef)
 * - GraphBaggage: optional graph-level metadata
 *
 * The `dependsOn` callback receives:
 *   - node: the current node
 *   - index: index of node in the input array
 *   - allNodes: the full node list (for cross-reference)
 *
 * It must return an Iterable of nodes that `node` depends on.
 * Edges are created as:
 *
 *   from: node
 *   to:   each dependency returned by dependsOn(node, ...)
 */
export function dagFromNodes<
  GraphBaggage = unknown,
  N extends RootContent = RootContent,
>(
  nodes: Iterable<N>,
  options: {
    name: NodeGraphName;
    readonly dependsOn: (
      node: N,
      index: number,
      allNodes: readonly N[],
    ) => Iterable<N>;
    readonly graphBaggage?:
      | GraphBaggage
      | ((
        nodeRefs: readonly N[],
        edges: readonly NodeEdge<N>[],
      ) => GraphBaggage);
  },
) {
  const nodeRefs: N[] = Array.from(nodes);
  const edges: NodeEdge<N>[] = [];

  nodeRefs.forEach((node, index) => {
    const deps = options.dependsOn(node, index, nodeRefs);
    for (const dep of deps) {
      // Only create edges to nodes that are actually in the nodeRefs list.
      if (!nodeRefs.includes(dep)) continue;
      edges.push({
        from: node,
        to: dep,
        label: "depends-on",
      });
    }
  });

  const baggage = typeof options.graphBaggage === "function"
    ? (options.graphBaggage as (
      ns: readonly N[],
      es: readonly NodeEdge<N>[],
    ) => GraphBaggage)(nodeRefs, edges)
    : options.graphBaggage;

  return {
    name: options.name,
    nodes: nodeRefs,
    edges,
    baggage,
    ensureAcyclic: () => ensureAcyclic(nodeRefs, edges),
  };
}

/**
 * Internal helper to ensure the graph is acyclic.
 *
 * Assumes:
 *   - edges' `from` / `to` nodes are the exact same object references
 *     as those in `nodes` (i.e., built from the same array).
 */
function ensureAcyclic<N extends RootContent, E extends NodeEdge<N>>(
  nodes: readonly N[],
  edges: readonly E[],
): void {
  const indexByNode = new Map<N, number>();
  nodes.forEach((n, i) => indexByNode.set(n, i));

  const adj: number[][] = nodes.map(() => []);

  for (const edge of edges) {
    const fromIndex = indexByNode.get(edge.from);
    const toIndex = indexByNode.get(edge.to);
    if (fromIndex == null || toIndex == null) {
      // Edge references a node not in the nodes list: ignore or throw.
      // For now, ignore silently.
      continue;
    }
    adj[fromIndex].push(toIndex);
  }

  const visiting: boolean[] = new Array(nodes.length).fill(false);
  const visited: boolean[] = new Array(nodes.length).fill(false);
  const stack: number[] = [];

  function describeNode(node: N, idx: number): string {
    const anyNode = node as Any;
    const type = anyNode.type ?? "unknown";
    const id = anyNode.identifier ??
      anyNode.id ??
      anyNode.name ??
      undefined;

    const pos = anyNode.position;
    let loc = "";
    if (pos?.start && typeof pos.start.line === "number") {
      loc = `@${pos.start.line}:${pos.start.column}`;
    }

    const idPart = id ? `(${String(id)})` : "";
    return `#${idx} ${type}${idPart}${loc}`;
  }

  function throwCycleError(backEdgeTarget: number): never {
    // backEdgeTarget is the index in `nodes` we just found a back-edge to
    const startIdxInStack = stack.indexOf(backEdgeTarget);
    const cycleIndexes = startIdxInStack >= 0
      // Only include the cycle segment, and close the loop by repeating the first node.
      ? [...stack.slice(startIdxInStack), backEdgeTarget]
      // Fallback: whole stack plus the back-edge target.
      : [...stack, backEdgeTarget];

    const cycleNodes = cycleIndexes.map((i) => nodes[i]);
    const cycleDesc = cycleIndexes
      .map((i) => describeNode(nodes[i], i))
      .join(" -> ");

    const err = new Error(
      [
        "Cycle detected in DAG built by dagFromNodes().",
        "Cycle path:",
        `  ${cycleDesc}`,
        "",
        "Diagnostics:",
        `  nodeIndexes: [${cycleIndexes.join(", ")}]`,
        `  nodeCount: ${nodes.length}`,
        `  edgeCount: ${edges.length}`,
      ].join("\n"),
    );

    (err as Any).cycleNodeIndexes = cycleIndexes;
    (err as Any).cycleNodes = cycleNodes;
    (err as Any).allNodes = nodes;
    (err as Any).allEdges = edges;

    throw err;
  }

  function dfs(i: number): void {
    if (visiting[i]) {
      // Should normally be caught via the back-edge checks below,
      // but keep this as a safe guard.
      throwCycleError(i);
    }
    if (visited[i]) return;

    visiting[i] = true;
    stack.push(i);

    for (const next of adj[i]) {
      if (visiting[next]) {
        // Found a back-edge: we have a cycle.
        throwCycleError(next);
      }
      if (!visited[next]) {
        dfs(next);
      }
    }

    stack.pop();
    visiting[i] = false;
    visited[i] = true;
  }

  for (let i = 0; i < nodes.length; i++) {
    if (!visited[i]) dfs(i);
  }
}

/** Reuse dagFromNodes' options type via Parameters utility. */
export type DagFromNodesOptions<
  GraphBaggage = unknown,
  N extends RootContent = RootContent,
> = Parameters<typeof dagFromNodes<GraphBaggage, N>>[1];

/**
 * Extra options for the code-deps plugin.
 *
 * - getIdentifiedNode: given an identifier and the full node list,
 *   returns the node that identifier refers to (or undefined).
 */
export interface DagFromCodeDepsPluginOptions<
  GraphBaggage = unknown,
  N extends RootContent = RootContent,
> extends DagFromNodesOptions<GraphBaggage, N> {
  readonly getIdentifiedNode: (
    id: string,
    nodes: readonly N[],
  ) => N | undefined;
}

/**
 * remark plugin: builds a DAG of code-cell dependencies and stores it
 * into the Root's graph collection via mdastGraphs(root).add(...).
 *
 * It:
 *   1. Collects all `code` nodes as N.
 *   2. Uses dagFromNodes() with either:
 *      - options.dependsOn (if provided), or
 *      - a default dependsOn that:
 *          - checks isCodeWithFrontmatterNode(node)
 *          - reads `--deps` from frontmatter
 *          - resolves each dep via options.getIdentifiedNode(id, nodes)
 */
export function dagFromCodeDepsPlugin<
  GraphBaggage = unknown,
  N extends RootContent = RootContent,
>(
  options: DagFromCodeDepsPluginOptions<GraphBaggage, N>,
) {
  return function transformer(root: Root): void {
    const codeNodes: N[] = [];

    visit(root, "code", (node) => {
      codeNodes.push(node as N);
    });

    if (codeNodes.length === 0) return;

    const dependsOn = options.dependsOn ??
      ((node: N, _index: number, allNodes: readonly N[]): Iterable<N> => {
        const deps: N[] = [];

        if (!isCodeWithFrontmatterNode(node)) {
          return deps;
        }

        const qppi = queryPosixPI(node.data.codeFM.pi);
        const depNames = qppi.getTextFlagValues("deps");
        if (!depNames.length) return deps;

        for (const name of depNames) {
          const target = options.getIdentifiedNode(name, allNodes);
          if (target) deps.push(target);
        }

        return deps;
      });

    const graph = dagFromNodes<GraphBaggage, N>(codeNodes, {
      ...options,
      dependsOn,
    });

    mdastGraphs(root).add(graph);
  };
}
