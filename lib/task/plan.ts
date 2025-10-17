import { TaskCell } from "./directives.ts";

export interface TaskExecutionPlan<Provenance> {
  /** Tasks in the order they were defined in the notebook */
  readonly tasks: readonly TaskCell<Provenance>[];
  /** Task identities in definition order (convenience) */
  readonly ids: readonly string[];
  /** Quick lookup by id */
  readonly byId: Readonly<Record<string, TaskCell<Provenance>>>;
  /** Declared deps that don’t exist as tasks (by task id) */
  readonly missingDeps: Readonly<Record<string, string[]>>;
  /** Adjacency: dep -> [tasks that depend on it] (existing deps only) */
  readonly adjacency: Readonly<Record<string, string[]>>;
  /** In-degree per node considering only existing deps */
  readonly indegree: Readonly<Record<string, number>>;
  /** All edges (dep -> task) for existing deps, definition-order stable */
  readonly edges: readonly [string, string][];
  /**
   * Kahn “waves” (levels). Each inner array lists task ids that
   * can run in parallel at that level (all prereqs satisfied).
   */
  readonly layers: readonly string[][];
  /** Tasks in computed execution order (topological; respects deps) */
  readonly dag: readonly TaskCell<Provenance>[];
  /**
   * Nodes left with in-degree > 0 after Kahn’s algorithm.
   * Non-empty means a cycle or unmet dependency chain.
   */
  readonly unresolved: readonly string[];
}

export function executionPlan<Provenance>(
  tasks: TaskCell<Provenance>[],
): TaskExecutionPlan<Provenance> {
  // Index, ids, and lookup
  const ids = tasks.map((t) => t.taskDirective.identity);
  const byId: Record<string, TaskCell<Provenance>> = Object.fromEntries(
    tasks.map((cell) => [cell.taskDirective.identity, cell] as const),
  );

  // Normalize deps per task (keep order, dedupe while preserving first occurrence)
  const normDeps: Record<string, string[]> = {};
  for (const task of tasks) {
    const id = task.taskDirective.identity;
    const raw = task.taskDirective.deps ?? [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const d of raw) {
      if (!seen.has(d)) {
        seen.add(d);
        list.push(d);
      }
    }
    normDeps[id] = list;
  }

  // Missing deps (declared but not defined as tasks)
  const missingDeps: Record<string, string[]> = {};
  for (const id of ids) {
    const miss = normDeps[id].filter((d) => !(d in byId));
    if (miss.length) missingDeps[id] = miss;
  }

  // Build graph using only existing deps: edge (dep) -> (task)
  const adjacency: Record<string, string[]> = {};
  const indegreeSnapshot: Record<string, number> = {}; // FIX: snapshot container
  for (const id of ids) {
    adjacency[id] = [];
    indegreeSnapshot[id] = 0;
  }

  const edges: [string, string][] = [];
  // Preserve definition-order stability: iterate tasks in order, deps in listed order
  for (const taskId of ids) {
    for (const dep of normDeps[taskId]) {
      if (!(dep in byId)) continue; // skip missing
      adjacency[dep].push(taskId);
      indegreeSnapshot[taskId] += 1; // FIX: count only in snapshot
      edges.push([dep, taskId]);
    }
  }

  // ----- Kahn’s algorithm with definition-order tie breaking
  // FIX: work on a *copy* so snapshot stays pristine
  const indegWork: Record<string, number> = { ...indegreeSnapshot };

  const zeroQueue: string[] = ids.filter((id) => indegWork[id] === 0);
  const layers: string[][] = [];
  const topo: string[] = [];

  // Process in “waves” to expose natural parallelism
  while (zeroQueue.length) {
    const wave = [...zeroQueue];
    layers.push(wave);
    zeroQueue.length = 0;

    for (const u of wave) {
      topo.push(u);
      for (const v of adjacency[u]) {
        indegWork[v] -= 1; // FIX: decrement the work copy
        if (indegWork[v] === 0) zeroQueue.push(v);
      }
      // Keep new zeros stable by original definition order
      zeroQueue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }

  // Any node not in topo has unresolved in-degree (cycle or blocked chain)
  const inTopo = new Set(topo);
  const unresolved = ids.filter((id) => !inTopo.has(id));

  // Map topological ids back to TaskCells (ignore unresolved)
  const dag = topo.map((id) => byId[id]);

  return {
    tasks,
    ids,
    byId,
    missingDeps,
    adjacency,
    indegree: indegreeSnapshot, // FIX: return the original snapshot
    edges,
    layers,
    dag,
    unresolved,
  };
}
