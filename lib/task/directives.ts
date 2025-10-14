import { Command } from "jsr:@cliffy/command@1.0.0-rc.8";
import { z } from "jsr:@zod/zod@4";
import { Issue } from "../universal/md-notebook.ts";
import {
  fbPartialCandidate,
  fbPartialsCollection,
  mdFencedBlockPartialSchema,
} from "../universal/md-partial.ts";
import { Playbook, PlaybookCodeCell } from "../universal/md-playbook.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const spryCodeCellLang = "spry" as const;

// Supports https://docs.deno.com/runtime/reference/cli/task/
export const denoTaskCodeCellLang = "deno-task" as const;

// Supports any #! language
export const shCodeCellLang = "sh" as const;
export const bashCodeCellLang = "bash" as const;

export const shebangSchema = z.union([
  z.object({ shebang: z.string(), source: z.string() }),
  z.literal(false),
]);

export const safeParseShebang = (source: string) =>
  (source.startsWith("#!")
    ? {
      shebang: source.split("\n", 1)[0],
      source: source.slice(source.indexOf("\n") + 1),
    }
    : false) satisfies z.infer<typeof shebangSchema>;

/** Schema for typed TaskDirective from `Cell.info?` property */
export const taskSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("Cliffy.Command"), // a "typed" command known to Spry like `spry make`
    command: z.instanceof(Command),
  }).strict(),
  z.object({
    strategy: z.literal("Deno.Command"), // "untyped" commands not known to Spry
    command: z.string().min(1), // required, pass into Deno.Command.spawn()
    arguments: z.array(z.string()).optional(), // pass into Deno.Command.spawn()
    shebang: shebangSchema,
  }).strict(),
  z.object({
    strategy: z.literal("Deno.Task"), // pass each line into cross platform `deno task --eval "X"`
  }).strict(),
]);

/** Schema for typed TaskDirective from `Cell.info?` property */
export const taskDirectiveSchema = z.discriminatedUnion("nature", [
  z.object({
    nature: z.literal("TASK"),
    identity: z.string().min(1), // required, names the task
    source: z.string(),
    task: taskSchema,
    deps: z.array(z.string()).optional(), // dependencies which allow DAGs to be created
  }).strict(),
  z.object({
    nature: z.literal("PARTIAL"),
    partial: mdFencedBlockPartialSchema,
  }).strict(),
]);

export type TaskDirective = z.infer<typeof taskDirectiveSchema>;

export const isTaskDirectiveSupplier = (
  o: unknown,
): o is { taskDirective: TaskDirective } =>
  o && typeof o === "object" && "taskDirective" in o &&
    typeof o.taskDirective === "object"
    ? true
    : false;

// --- Add near other exports ---
export type TaskCell<Provenance> = PlaybookCodeCell<Provenance> & {
  taskDirective: Extract<TaskDirective, { nature: "TASK" }>;
};

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

export class TaskDirectives<
  Provenance,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> {
  readonly issues: I[] = [];
  readonly tasks: (PlaybookCodeCell<Provenance> & {
    taskDirective: Extract<TaskDirective, { nature: "TASK" }>;
  })[] = [];

  constructor(
    readonly partials: ReturnType<
      typeof fbPartialsCollection<
        Extract<TaskDirective, { nature: "PARTIAL" }>
      >
    >,
  ) {
  }

  partial(name: string) {
    return this.partials.partial(name);
  }

  registerIssue(issue: I) {
    this.issues.push(issue);
  }

  register(
    cell: PlaybookCodeCell<Provenance, CellAttrs>,
    pb: Playbook<Provenance, Record<string, unknown>, CellAttrs, I>,
    opts: {
      onEmptyInfo?: (cell: PlaybookCodeCell<Provenance, CellAttrs>) => void;
      onUnknown?: (cell: PlaybookCodeCell<Provenance, CellAttrs>) => void;
    },
  ) {
    if (isTaskDirectiveSupplier(cell)) return true;

    let info = cell.info;
    info = info?.trim() ?? "";
    if (info.length == 0) {
      opts?.onEmptyInfo?.(cell);
      return false;
    }

    const [first, ...rest] = info.split(/\s+/);
    const remainder = rest.join(" ").trim();

    let candidate: unknown;
    switch (first.toLocaleUpperCase()) {
      case "PARTIAL": {
        candidate = {
          nature: "PARTIAL",
          partial: fbPartialCandidate(remainder, cell.source, cell.attrs, {
            registerIssue: (message, error) =>
              this.registerIssue({
                kind: "fence-issue",
                disposition: "error",
                error,
                message,
                provenance: pb.notebook.provenance,
                startLine: cell.startLine,
                endLine: cell.endLine,
              } as I),
          }),
        };
        break;
      }

      default: {
        const shebang = safeParseShebang(cell.source);
        let cellLang = cell.language;
        if (
          (cellLang == shCodeCellLang || cellLang == bashCodeCellLang) &&
          !shebang
        ) cellLang = denoTaskCodeCellLang;

        switch (cellLang) {
          case spryCodeCellLang: {
            candidate = {
              nature: "TASK",
              identity: first,
              source: cell.source,
              task: {
                strategy: "Cliffy.Command",
                command: new Command(), // need `action` to perform task
              },
            } satisfies TaskDirective;

            break;
          }

          case denoTaskCodeCellLang: {
            candidate = {
              nature: "TASK",
              identity: first,
              source: cell.source,
              task: { strategy: "Deno.Task" },
            } satisfies TaskDirective;
            break;
          }

          case shCodeCellLang:
          case bashCodeCellLang: {
            candidate = {
              nature: "TASK",
              identity: first,
              source: cell.source,
              task: {
                strategy: "Deno.Command",
                command: "bash",
                shebang,
              },
            } satisfies TaskDirective;
            break;
          }

          default: {
            opts?.onUnknown?.(cell);
            return false;
          }
        }
        break;
      }
    }

    const parsed = z.safeParse(taskDirectiveSchema, candidate);
    if (parsed.success) {
      (cell as Any).taskDirective = parsed.data;
      if (isTaskDirectiveSupplier(cell)) {
        if (cell.taskDirective.nature === "PARTIAL") {
          this.partials.register(cell.taskDirective);
        } else {
          this.tasks.push(
            cell as (PlaybookCodeCell<Provenance> & {
              taskDirective: Extract<TaskDirective, { nature: "TASK" }>;
            }),
          );
        }
        return true;
      } else {
        throw Error("This should never happen, some compiler or typing error");
      }
    } else {
      this.registerIssue({
        kind: "fence-issue",
        disposition: "error",
        error: parsed.error,
        message: `Zod error parsing task directive '${cell.info}': ${
          z.prettifyError(parsed.error)
        }`,
        provenance: pb.notebook.provenance,
        startLine: cell.startLine,
        endLine: cell.endLine,
      } as I);
    }

    return false;
  }

  plan(): TaskExecutionPlan<Provenance> {
    // Snapshot in-definition order
    const tasks = [...this.tasks] as const;

    // Index, ids, and lookup
    const ids = tasks.map((t) => t.taskDirective.identity);
    const byId: Record<string, TaskCell<Provenance>> = Object.fromEntries(
      tasks.map((t) => [t.taskDirective.identity, t as TaskCell<Provenance>]),
    );

    // Normalize deps per task (keep order, dedupe while preserving first occurrence)
    const normDeps: Record<string, string[]> = {};
    for (const t of tasks) {
      const id = t.taskDirective.identity;
      const raw = t.taskDirective.deps ?? [];
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
    const indegree: Record<string, number> = {};
    for (const id of ids) {
      adjacency[id] = [];
      indegree[id] = 0;
    }

    const edges: [string, string][] = [];
    // Preserve definition-order stability: iterate tasks in order, deps in listed order
    for (const taskId of ids) {
      for (const dep of normDeps[taskId]) {
        if (!(dep in byId)) continue; // skip missing
        adjacency[dep].push(taskId);
        indegree[taskId] += 1;
        edges.push([dep, taskId]);
      }
    }

    // Kahn’s algorithm with definition-order tie breaking
    const zeroQueue: string[] = ids.filter((id) => indegree[id] === 0);
    const layers: string[][] = [];
    const topo: string[] = [];

    // Process in “waves” to expose natural parallelism
    while (zeroQueue.length) {
      // Current wave is whatever is currently zero in queue (ordered)
      const wave = [...zeroQueue];
      layers.push(wave);
      zeroQueue.length = 0;

      for (const u of wave) {
        topo.push(u);
        for (const v of adjacency[u]) {
          indegree[v] -= 1;
          if (indegree[v] === 0) zeroQueue.push(v);
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
      indegree,
      edges,
      layers,
      dag,
      unresolved,
    };
  }
}
