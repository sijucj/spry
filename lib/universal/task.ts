/**
 * Task graph planning and deterministic, serial DAG execution utilities.
 *
 * This module provides two core capabilities:
 * 1) `executionPlan()` — builds a reproducible execution plan from a set of
 *    lightweight task descriptors (`Task`) that expose an id and a list of
 *    dependencies. The plan includes useful graph views (ids, byId, edges,
 *    adjacency, indegree), “waves”/layers for natural parallel groupings, and
 *    a topological order (`dag`) when no cycles exist.
 * 2) `executeDAG()` — walks a previously built plan in stable, definition-order
 *    fashion and invokes a user-supplied async `execute()` function for each
 *    task. Execution is serial by design, but the plan’s `layers` can be used
 *    elsewhere for parallel scheduling if needed.
 *
 * Key properties:
 * - Determinism: ties are broken by original definition order; edges are added
 *   in the same stable sequence, producing stable `layers`, `dag`, and events.
 * - Robust planning: declared-but-missing dependencies are captured in
 *   `missingDeps` (they do not create edges). `unresolved` lists ids that could
 *   not be scheduled due to cycles or unmet chains.
 * - Non-destructive indegree: `executionPlan()` returns an `indegree` snapshot
 *   for introspection while `executeDAG()` operates on an internal copy.
 * - Event hooks: `executeDAG()` can emit lifecycle events via an optional
 *   event bus created by `eventBus<TaskExecEventMap<…>>()`.
 *
 * Definitions:
 * - Task: any object with `taskId(): string` and `taskDeps(): string[]`.
 * - Plan: a `TaskExecutionPlan<T>` computed by `executionPlan(tasks)`.
 * - Section stack: the array of previously completed task frames passed to the
 *   executor to enable contextual or incremental behavior.
 *
 * Performance notes:
 * - Planning is O(V + E) over the existing-dependency edges.
 * - Execution is O(V + E) with stable sorting limited to the frontier.
 *
 * Example
 * ```ts
 * type MyTask = {
 *   taskId: () => string;
 *   taskDeps: () => string[];
 *   run: () => Promise<void>;
 * };
 *
 * const tasks: MyTask[] = [
 *   { taskId: () => "build", taskDeps: () => ["clean"], run: async () => {} },
 *   { taskId: () => "clean", taskDeps: () => [],            run: async () => {} },
 * ];
 *
 * const plan = executionPlan(tasks);
 *
 * const summary = await executeDAG(plan, async (task, section) => {
 *   try {
 *     await task.run();
 *     return {
 *       disposition: "continue",
 *       ...{
 *         ctx: { runId: "demo" },
 *         success: true,
 *         exitCode: 0,
 *         startedAt: new Date(),
 *         endedAt: new Date(),
 *       },
 *     };
 *   } catch (error) {
 *     return {
 *       disposition: "terminate",
 *       ...{
 *         ctx: { runId: "demo" },
 *         success: false,
 *         exitCode: 1,
 *         error,
 *         startedAt: new Date(),
 *         endedAt: new Date(),
 *       },
 *     };
 *   }
 * });
 * ```
 */
import { eventBus } from "../universal/event-bus.ts";

export type Task = {
  taskId: () => string;
  taskDeps?: () => string[] | undefined;
};

export interface TaskExecutionPlan<T extends Task> {
  /** Tasks in the order they were defined in the notebook */
  readonly tasks: readonly T[];
  /** Task identities in definition order (convenience) */
  readonly ids: readonly string[];
  /** Quick lookup by id */
  readonly byId: Readonly<Record<string, T>>;
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
  readonly dag: readonly T[];
  /**
   * Nodes left with in-degree > 0 after Kahn’s algorithm.
   * Non-empty means a cycle or unmet dependency chain.
   */
  readonly unresolved: readonly string[];
}

/**
 * Build a deterministic execution plan for a set of tasks.
 *
 * Uses Kahn’s algorithm to compute:
 * - `layers`: “waves” of ids that can run together (all prereqs satisfied)
 * - `dag`: topological order when the graph is acyclic
 * - `unresolved`: ids that could not be scheduled (cycles or unmet chains)
 *
 * Additional views are included for diagnostics and scheduling:
 * - `ids`: task ids in definition order
 * - `byId`: id → task lookup
 * - `missingDeps`: task id → declared deps that are not present as tasks
 * - `adjacency`: dep → [tasks that depend on it] (existing deps only)
 * - `indegree`: original indegree snapshot (non-destructive)
 * - `edges`: list of (dep, task) edges in definition-stable order
 *
 * Dependency handling:
 * - Each task’s dependency list is normalized to preserve first occurrence and
 *   remove duplicates.
 * - Missing dependencies are recorded in `missingDeps` and excluded from the
 *   edge set (preventing accidental indegree inflation).
 *
 * Determinism:
 * - Zero-indegree frontiers are ordered by original definition index to keep
 *   `layers` and `dag` stable between runs given identical inputs.
 *
 * Complexity:
 * - O(V + E) where E counts only edges connecting tasks that exist in `byId`.
 *
 * @template T extends Task
 * @param tasks Tasks in definition order.
 * @returns A complete `TaskExecutionPlan<T>` with graph views, layers, and topo.
 *
 * @example
 * const plan = executionPlan(tasks);
 * console.log(plan.layers);       // [['clean'], ['build']]
 * console.log(plan.unresolved);   // [] if acyclic
 * console.log(plan.missingDeps);  // { build: ['unknown-dep'] } if any
 */
export function executionPlan<T extends Task>(
  tasks: T[],
): TaskExecutionPlan<T> {
  // Index, ids, and lookup
  const ids = tasks.map((t) => t.taskId());
  const byId: Record<string, T> = Object.fromEntries(
    tasks.map((t) => [t.taskId(), t] as const),
  );

  // Normalize deps per task (keep order, dedupe while preserving first occurrence)
  const normDeps: Record<string, string[]> = {};
  for (const task of tasks) {
    const id = task.taskId();
    const raw = task.taskDeps?.() ?? [];
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

/** Derive a TaskExecutionPlan<T> induced by targets ∪ their transitive ancestors. */

export function executionSubplan<T extends Task>(
  plan: TaskExecutionPlan<T>,
  only: Iterable<string>,
): TaskExecutionPlan<T> {
  // Build parent index once (child -> parents)
  const parents = new Map<string, string[]>();
  for (const id of plan.ids) parents.set(id, []);
  for (const [dep, child] of plan.edges) parents.get(child)!.push(dep);

  // Ancestor closure (ignore unknown targets safely)
  const want = new Set(only);
  const selected = new Set<string>();
  const stack: string[] = [];
  for (const t of want) if (t in plan.byId) stack.push(t);
  while (stack.length) {
    const cur = stack.pop()!;
    if (selected.has(cur)) continue;
    selected.add(cur);
    for (const p of (parents.get(cur) ?? [])) stack.push(p);
  }

  // Induced plan structures, preserving original definition order
  const ids = plan.ids.filter((id) => selected.has(id));
  const byId: Record<string, T> = Object.fromEntries(
    ids.map((id) => [id, plan.byId[id]] as const),
  );

  const adjacency: Record<string, string[]> = {};
  const indegree: Record<string, number> = {};
  for (const id of ids) {
    adjacency[id] = [];
    indegree[id] = 0;
  }

  const edges: [string, string][] = [];
  for (const [dep, child] of plan.edges) {
    if (selected.has(dep) && selected.has(child)) {
      adjacency[dep].push(child);
      indegree[child] += 1;
      edges.push([dep, child]);
    }
  }

  // Kahn on the induced subgraph (stable by original definition order)
  const indegWork = { ...indegree };
  const zeroQueue: string[] = ids.filter((id) => indegWork[id] === 0);
  const layers: string[][] = [];
  const topo: string[] = [];
  while (zeroQueue.length) {
    const wave = [...zeroQueue];
    layers.push(wave);
    zeroQueue.length = 0;
    for (const u of wave) {
      topo.push(u);
      for (const v of adjacency[u]) {
        indegWork[v] -= 1;
        if (indegWork[v] === 0) zeroQueue.push(v);
      }
      zeroQueue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }
  const inTopo = new Set(topo);
  const unresolved = ids.filter((id) => !inTopo.has(id));
  const dag = topo.map((id) => byId[id]);

  // Filter missing deps to selected nodes only (signal, not noise)
  const missingDeps = Object.fromEntries(
    Object.entries(plan.missingDeps).filter(([id]) => selected.has(id)),
  );

  return {
    tasks: ids.map((id) => byId[id]),
    ids,
    byId,
    missingDeps,
    adjacency,
    indegree,
    edges,
    layers,
    dag,
    unresolved,
  };
}

/* ========================
 * Result & event types
 * ======================== */

export type TaskExecutionResult<
  Context,
  StdOut = Uint8Array,
  StdErr = Uint8Array,
> =
  & {
    ctx: Context;
    success: boolean;
    exitCode: number;
    startedAt: Date;
    endedAt: Date;
  }
  & ({ success: true; stdout?: () => StdOut } | {
    success: false;
    stderr?: () => StdErr;
    error?: unknown;
  });

/** Only the events we actually emit in this file. */
export type TaskExecEventMap<T extends Task, Context> = {
  "run:start": {
    ctx: Context;
    plan: TaskExecutionPlan<T>;
    startedAt: Date;
  };
  "plan:ready": {
    ctx: Context;
    ids: readonly string[];
    unresolved: readonly string[];
    missingDeps: Readonly<Record<string, string[]>>;
  };
  "dag:ready": { ctx: Context; ids: readonly string[] };
  "dag:release": { ctx: Context; from: string; to: readonly string[] };
  "task:scheduled": { ctx: Context; id: string };
  "task:start": {
    ctx: Context;
    id: string;
    task: T;
    at: Date;
  };
  "task:end": {
    ctx: Context;
    id: string;
    result: TaskExecutionResult<Context>;
  };
  "run:end": {
    ctx: Context;
    endedAt: Date;
    durationMs: number;
    totals: {
      tasks: number;
      failed: number;
      succeeded: number;
      unresolved: number;
      missingDeps: number;
    };
  };
  error: {
    message: string;
    cause?: unknown;
    taskId?: string;
    stage?:
      | "plan"
      | "schedule"
      | "task-start"
      | "task-run"
      | "task-end"
      | "finalize";
  };
};

export type ContinueOrTerminate = "continue" | "terminate";

/** One completed execution in the section stack. */
export type SectionFrame<T extends Task, Context> = {
  taskId: string;
  task: T;
  result: TaskExecutionResult<Context>;
};

/** Read-only view passed to the executor. */
export type SectionStack<T extends Task, Context> = readonly SectionFrame<
  T,
  Context
>[]; // <- as before

export interface ExecuteSummary<T extends Task, Context> {
  ran: readonly string[];
  terminated: boolean;
  section: ReadonlyArray<SectionFrame<T, Context>>;
}

/* ========================
 * Internals
 * ======================== */

type MaybeBus<T extends Task, C> =
  | ReturnType<typeof eventBus<TaskExecEventMap<T, C>>>
  | undefined;

function makeResult<Context>(
  ctx: Context,
  ok: true | false,
  extra?:
    & Partial<Omit<TaskExecutionResult<Context>, "ok" | "ctx">>
    & { error?: unknown },
): TaskExecutionResult<Context> {
  const now = new Date();
  return {
    ctx,
    success: ok,
    exitCode: ok ? 0 : (extra?.exitCode ?? 1),
    startedAt: extra?.startedAt ?? now,
    endedAt: extra?.endedAt ?? now,
    ...(ok ? {} : { error: extra?.error }),
  } as TaskExecutionResult<Context>;
}

function defaultCtx(): { runId: string } {
  const runId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `run-${Math.random().toString(36).slice(2)}`;
  return { runId };
}

/**
 * Execute a previously planned DAG in deterministic, serial order.
 *
 * Scheduling:
 * - Seeds the ready queue with zero-indegree task ids using `plan.indegree`.
 * - Always picks the next id by original definition rank for stable behavior.
 * - After each completion, decrements successors’ indegree and releases any
 *   that reach zero, again maintaining stable ordering.
 *
 * Execution contract:
 * - You supply an async `execute(task, section)` that returns a full
 *   `TaskExecutionResult<Context>` plus a `disposition` of `"continue"` or
 *   `"terminate"`. Returning `"terminate"` stops further scheduling immediately.
 * - The `section` argument is the completed stack (read-only view) containing
 *   frames `{ taskId, task, result }`, enabling incremental or dependent logic.
 *
 * Context:
 * - If no `ctx` is provided, a default `{ runId }` is created.
 *
 * Events (optional):
 * - If an `eventBus` created via `eventBus<TaskExecEventMap<T, Context>>()` is
 *   provided, the executor emits:
 *   - "run:start"         — run begins with plan and timestamp
 *   - "plan:ready"        — ids, unresolved, and missingDeps announced
 *   - "dag:ready"         — initial ready queue
 *   - "task:scheduled"    — task id scheduled
 *   - "task:start"        — task about to execute
 *   - "task:end"          — task finished with its result
 *   - "dag:release"       — successors released by a completed task
 *   - "run:end"           — final tallies and duration
 *   - "error"             — thrown error during task execution (synthesizes a
 *                           failing result and terminates)
 *
 * Failure behavior:
 * - If `execute` throws, a failing result is synthesized, an "error" event is
 *   emitted, and execution terminates.
 *
 * Returns:
 * - `ran`: ids in the order they were executed
 * - `terminated`: whether execution ended early due to disposition or error
 * - `section`: final read-only stack of completed frames
 *
 * @template T extends Task
 * @template Context
 * @param plan A `TaskExecutionPlan<T>` returned by `executionPlan()`.
 * @param execute User-supplied async runner for a single task.
 * @param init Optional `{ eventBus, ctx }`.
 * @returns Summary with `ran`, `terminated`, and `section` frames.
 *
 * @example
 * const summary = await executeDAG(plan, async (task, section) => {
 *   const startedAt = new Date();
 *   try {
 *     await task.run();
 *     return {
 *       disposition: "continue",
 *       ctx: { runId: "demo" },
 *       success: true,
 *       exitCode: 0,
 *       startedAt,
 *       endedAt: new Date(),
 *     };
 *   } catch (error) {
 *     return {
 *       disposition: "terminate",
 *       ctx: { runId: "demo" },
 *       success: false,
 *       exitCode: 1,
 *       error,
 *       startedAt,
 *       endedAt: new Date(),
 *     };
 *   }
 * });
 */
export async function executeDAG<T extends Task, Context = { runId: string }>(
  plan: TaskExecutionPlan<T>,
  execute: (
    task: T,
    ctx: Context,
    section: SectionStack<T, Context>,
  ) => Promise<
    TaskExecutionResult<Context> & { disposition: ContinueOrTerminate }
  >,
  init?: { eventBus?: MaybeBus<T, Context>; ctx?: Context },
): Promise<ExecuteSummary<T, Context>> {
  const bus = init?.eventBus;
  const ctx = init?.ctx ?? (defaultCtx() as Context);
  const startedAt = new Date();
  const missingDepsCount = Object.keys(plan.missingDeps).length;

  const ran: string[] = [];
  const section: SectionFrame<T, Context>[] = [];

  bus?.emit("run:start", { ctx, plan, startedAt });
  bus?.emit("plan:ready", {
    ctx,
    ids: plan.ids,
    unresolved: plan.unresolved,
    missingDeps: plan.missingDeps,
  });

  // ---- Hardened, deterministic scheduling (stable by definition order)
  const rank = new Map(plan.ids.map((id, i) => [id, i] as const));

  // Seed indegrees for all ids (default 0 if missing)
  const indeg: Record<string, number> = Object.fromEntries(
    plan.ids.map((id) => [id, plan.indegree[id] ?? 0]),
  );

  const ready: string[] = [];
  const pushReady = (id: string) => {
    ready.push(id);
    ready.sort((a, b) => (rank.get(a)! - rank.get(b)!));
  };
  for (const id of plan.ids) {
    if ((indeg[id] ?? 0) === 0) pushReady(id);
  }

  bus?.emit("dag:ready", { ctx, ids: ready });

  let terminated = false;

  while (ready.length && !terminated) {
    const id = ready.shift();
    if (!id) break;

    const task = plan.byId[id];
    bus?.emit("task:scheduled", { ctx, id });
    bus?.emit("task:start", { ctx, id, task, at: new Date() });

    try {
      // NEW: caller returns a full TaskExecutionResult with a disposition
      const { disposition, ...result } = await execute(
        task,
        ctx,
        section as SectionStack<T, Context>,
      );

      // Record + emit using the caller-provided result
      ran.push(id);
      bus?.emit("task:end", { ctx, id, result });
      section.push({ taskId: id, task, result });

      if (disposition === "terminate") {
        terminated = true;
        break;
      }

      // Release successors with defensive defaults
      const released: string[] = [];
      const succ = plan.adjacency[id] ?? [];
      for (const nxt of succ) {
        const nextDeg = (indeg[nxt] = (indeg[nxt] ?? 0) - 1);
        if (nextDeg === 0) {
          pushReady(nxt);
          released.push(nxt);
        }
      }
      if (released.length) {
        bus?.emit("dag:release", { ctx, from: id, to: released });
      }
    } catch (cause) {
      // On throw, synthesize a failing result and terminate
      const result = makeResult(ctx, false, { error: cause });
      bus?.emit("task:end", { ctx, id, result });
      section.push({ taskId: id, task, result });

      bus?.emit("error", {
        message: "Task threw during execution",
        cause,
        taskId: id,
        stage: "task-run",
      });
      terminated = true;
      break;
    }
  }

  const endedAt = new Date();
  const failedCount = section.filter((f) => !f.result.success).length;

  bus?.emit("run:end", {
    ctx,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    totals: {
      tasks: section.length,
      failed: failedCount,
      succeeded: section.length - failedCount,
      unresolved: plan.unresolved.length,
      missingDeps: missingDepsCount,
    },
  });

  return { ran, terminated, section };
}
