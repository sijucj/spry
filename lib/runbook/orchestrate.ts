import { visit } from "unist-util-visit";
import { markdownASTs, Yielded } from "../remark/mdastctl/io.ts";
import {
  CodeWithFrontmatterNode,
} from "../remark/plugin/node/code-frontmatter.ts";

import { z } from "@zod/zod";
import { codePartialsCollection } from "../remark/plugin/node/code-partial.ts";
import {
  CodeSpawnableNode,
  isCodeSpawnableNode,
} from "../remark/plugin/node/code-spawnable.ts";
import { depsResolver } from "../universal/depends.ts";
import { eventBus } from "../universal/event-bus.ts";
import { gitignore } from "../universal/gitignore.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { shell, ShellBusEvents } from "../universal/shell.ts";
import {
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
} from "../universal/task.ts";
import { ensureTrailingNewline } from "../universal/text-utils.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * codeSpawnablePiFlags = {
 *   capture?: string;
 *   interpolate?: string;
 *   C?: string;  // shorthand
 *   I?: string;  // shorthand
 * }
 *
 * The transform ensures:
 *   - if C is present → capture = C
 *   - if I is present → interpolate = I
 */
export const codeSpawnablePiFlagsSchema = z.object({
  capture: z.string().optional(),
  interpolate: z.string().optional(),

  C: z.string().optional(),
  I: z.string().optional(),
}).transform((raw) => ({
  capture: raw.C ?? raw.capture,
  interpolate: raw.I ?? raw.interpolate,
}));

export type CodeSpawnablePiFlags = z.infer<typeof codeSpawnablePiFlagsSchema>;

export function spawnableDepsResolver<
  SpawnablePiFlags extends Record<string, unknown>,
>(
  catalog: Iterable<CodeSpawnableNode<SpawnablePiFlags>>,
  init?: {
    onImplicitTasksError?: () => void;
  },
) {
  const { onImplicitTasksError } = init ?? {};

  return depsResolver(catalog, {
    getId: (node) => node.data.codeSpawnable.identity,

    /**
     * Find tasks that should be *implicitly* injected as dependencies of `taskId`
     * based on other tasks' `--injected-dep` flags, and report invalid regexes.
     *
     * Behavior:
     *
     * - Any task may declare `--injected-dep`. The value can be:
     *   - boolean true  → means ["*"] (match all taskIds)
     *   - string        → treated as [that string]
     *   - string[]      → used as-is
     *
     * - Each string is treated as a regular expression source. We compile all of them
     *   once and cache them in `t.parsedPI.flags[".injected-dep-cache"]` as `RegExp[]`.
     *
     * - Special case: "*" means "match everything", implemented as `/.*\/`.
     *
     * - If ANY compiled regex for task `t` matches the given `taskId`, then that task’s
     *   `parsedPI.firstToken` (the task's own name/id) will be considered an injected
     *   dependency. It will be added to the returned `injected` list unless it is already
     *   present in `taskDeps` or already added.
     *
     * Reliability:
     *
     * - The only error we surface is regex compilation failure. If a pattern cannot be
     *   compiled, it is skipped and recorded in `errors` as `{ taskId, regEx }`.
     *
     * - No exceptions propagate. Bad inputs are ignored safely.
     */
    getImplicit: (node) => {
      const injected: string[] = [];
      const errors: { taskId: string; regEx: string; error: unknown }[] = [];

      const tasks = Array.from(catalog).map((n) =>
        n.data.codeSpawnable.identity
      );
      for (const task of catalog) {
        const {
          codeFM: { pi: { flags } },
          codeSpawnable: { identity: taskId },
        } = task.data;

        if (!flags || typeof flags !== "object") continue;
        if (!("injected-dep" in flags)) continue;

        // Normalize `--injected-dep` forms into an array of string patterns
        const diFlag = flags["injected-dep"];
        let di: string[] = [];

        if (typeof diFlag === "boolean") {
          if (diFlag === true) {
            di = ["*"];
          }
        } else if (typeof diFlag === "string") {
          di = [diFlag];
        } else if (Array.isArray(diFlag)) {
          di = diFlag.filter((x) => typeof x === "string");
        }

        if (di.length === 0) continue;

        // Compile/cache regexes if not already done
        if (!Array.isArray(flags[".injected-dep-cache"])) {
          const compiledList: RegExp[] = [];

          for (const expr of di) {
            const source = expr === "*" ? ".*" : expr;

            try {
              compiledList.push(new RegExp(source));
            } catch (error) {
              // Record invalid regex source
              errors.push({ taskId, regEx: expr, error });
              // skip adding invalid one
            }
          }

          // deno-lint-ignore no-explicit-any
          (flags as any)[".injected-dep-cache"] = compiledList;
        }

        // deno-lint-ignore no-explicit-any
        const cached = (flags as any)[".injected-dep-cache"] as RegExp[];

        if (!Array.isArray(cached) || cached.length === 0) {
          // nothing valid compiled, move on
          continue;
        }

        // Check whether ANY of the compiled regexes matches the requested taskId
        let matches = false;
        for (const re of cached) {
          if (
            re instanceof RegExp && re.test(node.data.codeSpawnable.identity)
          ) {
            matches = true;
            break;
          }
        }

        if (!matches) continue;

        if (
          !tasks.includes(taskId) &&
          !injected.includes(taskId)
        ) {
          injected.push(taskId);
        }
      }

      onImplicitTasksError?.();
      return injected.length ? injected : undefined;
    },
  });
}

export type TaskExecContext = { runId: string };

export type TaskExecCapture<SpawnablePiFlags extends Record<string, unknown>> =
  {
    cell: CodeSpawnableNode<SpawnablePiFlags>;
    ctx: TaskExecContext;
    interpResult: Awaited<
      ReturnType<
        ReturnType<
          typeof execTasksState<SpawnablePiFlags>
        >["interpolateUnsafely"]
      >
    >;
    execResult?: Awaited<ReturnType<ReturnType<typeof shell>["auto"]>>;

    text: () => string;
    json: () => unknown;
  };

export const typicalOnCapture = async <
  SpawnablePiFlags extends Record<string, unknown>,
>(
  ci: string,
  tec: TaskExecCapture<SpawnablePiFlags>,
  capturedTaskExecs: Record<string, TaskExecCapture<SpawnablePiFlags>>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export const gitignorableOnCapture = async <
  SpawnablePiFlags extends Record<string, unknown>,
>(
  ci: string,
  tec: TaskExecCapture<SpawnablePiFlags>,
  capturedTaskExecs: Record<string, TaskExecCapture<SpawnablePiFlags>>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
    const { pi } = tec.cell.data.codeSpawnable;
    const gitIgnore = pi.getFlag("gitignore");
    if (gitIgnore) {
      const gi = ci.slice("./".length);
      if (typeof gitIgnore === "string") {
        await gitignore(gi, gitIgnore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export function execTasksState<
  SpawnablePiFlags extends Record<string, unknown>,
>(
  tasks: Iterable<{ code: CodeWithFrontmatterNode }>,
  partialsCollec: ReturnType<typeof codePartialsCollection>,
  opts?: {
    unsafeInterp?: ReturnType<typeof unsafeInterpolator>;
    onCapture?: (
      ci: string,
      tec: TaskExecCapture<SpawnablePiFlags>,
      capturedTaskExecs: Record<string, TaskExecCapture<SpawnablePiFlags>>,
    ) => void | Promise<void>;
  },
) {
  const capturedTaskExecs = {} as Record<
    string,
    TaskExecCapture<SpawnablePiFlags>
  >;
  const defaults: Required<typeof opts> = {
    unsafeInterp: unsafeInterpolator({
      directives: tasks,
      safeJsonStringify,
      capturedTaskExecs,
    }),
    onCapture: typicalOnCapture,
  };
  const {
    unsafeInterp = defaults.unsafeInterp,
    onCapture = defaults.onCapture,
  } = opts ?? {};
  const td = new TextDecoder();

  const isCapturable = (
    cell: CodeWithFrontmatterNode,
  ) => ("capture" in cell.data.codeFM.pi.flags ||
    "C" in cell.data.codeFM.pi.flags);

  const prepTaskExecCapture = (
    tec: Pick<
      TaskExecCapture<SpawnablePiFlags>,
      "cell" | "ctx" | "interpResult" | "execResult"
    >,
  ) => {
    const text = () => {
      if (tec.execResult) {
        if (Array.isArray(tec.execResult)) {
          return tec.execResult.map((er) => td.decode(er.stdout)).join("\n");
        } else {
          return td.decode(tec.execResult.stdout);
        }
      } else {
        return tec.interpResult.source;
      }
    };
    const json = () => JSON.parse(text());
    return { ...tec, text, json } satisfies TaskExecCapture<SpawnablePiFlags>;
  };

  const captureTaskExec = async (cap: TaskExecCapture<SpawnablePiFlags>) => {
    const { cell: { data: { codeFM: { pi } } } } = cap;
    const captureFlags = [
      pi.flags.capture,
      pi.flags.C,
    ].filter((v) => v !== undefined);

    const captureInstructions = captureFlags.flatMap((v) =>
      typeof v === "boolean" ? [pi.pos[0]] : Array.isArray(v) ? v : [v]
    ).filter((v) => v !== undefined).filter((v) => typeof v === "string");

    for (const ci of captureInstructions) {
      await onCapture(ci, cap, capturedTaskExecs);
    }
  };

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: { code: CodeSpawnableNode<SpawnablePiFlags> },
    ctx: TaskExecContext,
  ): Promise<
    & { status: false | "unmodified" | "mutated" }
    & ({ status: "mutated"; source: string } | {
      status: "unmodified";
      source: string;
    } | {
      status: false;
      source: string;
      error: unknown;
    })
  > {
    const qppi = cell.code.data.codeSpawnable.pi;
    const source = cell.code.value;
    if (!qppi.hasFlag("interpolate", "I")) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, {
        ...ctx,
        cell: cell.code,
        safeJsonStringify,
        captured: capturedTaskExecs,
        partial: async (
          name: string,
          partialLocals?: Record<string, unknown>,
        ) => {
          const found = partialsCollec.get(name);
          if (found) {
            const { content: partial, interpolate, locals } = await found.data
              .codePartial.content({
                cell: cell.code,
                safeJsonStringify,
                captured: capturedTaskExecs,
                ...ctx,
                ...partialLocals,
                partial: found.data.codePartial,
              });
            if (!interpolate) return partial;
            return await unsafeInterp.interpolate(partial, locals, [{
              template: partial,
            }]);
          } else {
            return `/* partial '${name}' not found */`;
          }
        },
      });
      if (mutated !== source) return { status: "mutated", source: mutated };
      return { status: "unmodified", source };
    } catch (error) {
      return { status: false, error, source };
    }
  }

  return {
    isCapturable,
    onCapture,
    unsafeInterp,
    interpolateUnsafely,
    capturedTaskExecs,
    captureTaskExec,
    prepTaskExecCapture,
  };
}

export type ExecTasksState = ReturnType<typeof execTasksState>;

export async function executeTasks<
  SpawnablePiFlags extends Record<string, unknown>,
  T extends Task & { code: CodeSpawnableNode<SpawnablePiFlags> },
  Context extends TaskExecContext = TaskExecContext,
>(
  plan: TaskExecutionPlan<T>,
  tei: ExecTasksState,
  opts?: {
    shellBus?: ReturnType<typeof eventBus<ShellBusEvents>>;
    tasksBus?: ReturnType<typeof eventBus<TaskExecEventMap<T, Context>>>;
  },
) {
  const { isCapturable, captureTaskExec, prepTaskExecCapture } = tei;
  const sh = shell({ bus: opts?.shellBus });
  return await executeDAG(plan, async (task, ctx) => {
    const interpResult = await tei.interpolateUnsafely(task, ctx);
    if (interpResult.status) {
      const execResult = await sh.auto(interpResult.source);
      if (isCapturable(task.code)) {
        await captureTaskExec(
          prepTaskExecCapture({
            cell: task.code,
            ctx,
            interpResult,
            execResult,
          }),
        );
      }
      return ok(ctx);
    } else {
      return fail(ctx, interpResult.error);
    }
  }, { eventBus: opts?.tasksBus });
}

export async function markdownTasks<
  SpawnablePiFlags extends Record<string, unknown>,
>(
  mdASTs: ReturnType<typeof markdownASTs>,
) {
  const tasksWithOrigin: {
    taskId: () => string; // satisfies Task interface
    taskDeps: () => string[]; // satisfies Task interface
    code: CodeSpawnableNode<SpawnablePiFlags>;
    md: Yielded<typeof mdASTs>;
  }[] = [];
  for await (const md of mdASTs) {
    visit(md.mdastRoot, "code", (code) => {
      if (isCodeSpawnableNode<SpawnablePiFlags>(code)) {
        const { codeSpawnable } = code.data;
        tasksWithOrigin.push({
          taskId: () => codeSpawnable.identity,
          taskDeps: () => codeSpawnable.pi.getTextFlagValues("dep"),
          code,
          md,
        });
      }
    });
  }
  // we want to resolve dependencies in tasks across all markdowns loaded
  const dr = spawnableDepsResolver(tasksWithOrigin.map((t) => t.code));
  return tasksWithOrigin.map((t) => {
    return {
      ...t,
      // overwrite the final dependencies with "injected" ones, too
      deps: () => dr.deps(t.taskId(), t.taskDeps()),
    };
  });
}
