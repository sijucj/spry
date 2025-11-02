import { unsafeInterpolator } from "../universal/interpolate.ts";
import {
  errorOnlyShellEventBus,
  shell,
  verboseInfoShellEventBus,
} from "../universal/shell.ts";
import {
  errorOnlyTaskEventBus,
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecutionPlan,
  TaskExecutorBuilder,
  verboseInfoTaskEventBus,
} from "../universal/task.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import { matchTaskNature, TaskCell } from "./cell.ts";

export async function executeTasks<T extends Task>(
  plan: TaskExecutionPlan<T>,
  verbose?: false | Parameters<typeof verboseInfoShellEventBus>[0]["style"],
  summarize?: boolean,
) {
  type Context = { runId: string };
  const unsafeInterp = unsafeInterpolator({ safeJsonStringify });

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: TaskCell<string>,
    ctx: Context,
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
    const source = cell.source;
    if (!cell.parsedPI?.hasEitherFlagOfType?.("interpolate", "I", "boolean")) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, { ...ctx, cell });
      if (mutated !== source) return { status: "mutated", source: mutated };
      return { status: "unmodified", source };
    } catch (error) {
      return { status: false, error, source };
    }
  }

  const sh = shell({
    bus: verbose
      ? verboseInfoShellEventBus({ style: verbose })
      : errorOnlyShellEventBus({ style: verbose ? verbose : "rich" }),
  });

  const exec = new TaskExecutorBuilder<Task, Context>()
    .handle(
      // if is task of nature "TASK" and does not handle its own execute process
      // then check if it's spawnable and handle spawning via shebang or Deno
      matchTaskNature("TASK"),
      async (cell, ctx) => {
        const ir = await interpolateUnsafely(cell, ctx);
        if (ir.status) {
          await sh.auto(ir.source);
          return ok(ctx);
        } else {
          return fail(ctx, ir.error);
        }
      },
    )
    .build();

  const summary = await executeDAG(plan, exec, {
    eventBus: verbose
      ? verboseInfoTaskEventBus<T, Context>({ style: verbose })
      : errorOnlyTaskEventBus<T, Context>({
        style: verbose ? verbose : "rich",
      }),
  });
  if (summarize) console.dir({ summary });
  return summary;
}
