import type { TaskExecutionPlan } from "./plan.ts";
import type { TaskCell } from "./directives.ts";
import { eventBus } from "../universal/event-bus.ts";

/* ========================
 * Result & event types
 * ======================== */

export type TaskExecutionResult<Context> =
  & {
    ctx: Context;
    ok: boolean;
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    startedAt: Date;
    endedAt: Date;
  }
  & ({ ok: true } | { ok: false; error?: unknown });

export interface ExecError {
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
}

/** Only the events we actually emit in this file. */
export type TaskExecEventMap<Provenance, Context> = {
  "run:start": {
    ctx: Context;
    plan: TaskExecutionPlan<Provenance>;
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
    task: TaskCell<Provenance>;
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
  error: ExecError;
};

export type ContinueOrTerminate = "continue" | "terminate";

/** One completed execution in the section stack. */
export type SectionFrame<Provenance, Context> = {
  id: string;
  task: TaskCell<Provenance>;
  result: TaskExecutionResult<Context>;
};
/** Read-only view passed to the executor. */
export type SectionStack<Provenance, Context> = readonly SectionFrame<
  Provenance,
  Context
>[]; // <- as before

export interface ExecuteSummary<Provenance, Context> {
  ran: readonly string[];
  terminated: boolean;
  section: ReadonlyArray<SectionFrame<Provenance, Context>>;
}

/* ========================
 * Internals
 * ======================== */

type MaybeBus<P, C> =
  | ReturnType<typeof eventBus<TaskExecEventMap<P, C>>>
  | undefined;
const emptyU8 = new Uint8Array();

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
    ok,
    exitCode: ok ? 0 : (extra?.exitCode ?? 1),
    stdout: extra?.stdout ?? emptyU8,
    stderr: extra?.stderr ?? emptyU8,
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

/* ======================
 * DAG (async, serial)
 * ====================== */

/**
 * NOTE: execute() now returns a concrete TaskExecutionResult<Context>
 * plus { disposition }, instead of just "continue" | "terminate".
 */
export async function executeDAG<
  Provenance,
  Context = { runId: string },
>(
  plan: TaskExecutionPlan<Provenance>,
  execute: (
    task: TaskCell<Provenance>,
    section: SectionStack<Provenance, Context>,
  ) => Promise<
    TaskExecutionResult<Context> & { disposition: ContinueOrTerminate }
  >,
  init?: { eventBus?: MaybeBus<Provenance, Context>; ctx?: Context },
): Promise<ExecuteSummary<Provenance, Context>> {
  const bus = init?.eventBus;
  const ctx = init?.ctx ?? (defaultCtx() as Context);
  const startedAt = new Date();
  const missingDepsCount = Object.keys(plan.missingDeps).length;

  const ran: string[] = [];
  const section: SectionFrame<Provenance, Context>[] = [];

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
        section as SectionStack<Provenance, Context>,
      );

      // Record + emit using the caller-provided result
      ran.push(id);
      bus?.emit("task:end", { ctx, id, result });
      section.push({ id, task, result });

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
      section.push({ id, task, result });

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
  const failedCount = section.filter((f) => !f.result.ok).length;

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
