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
import { matchTaskNature, TaskCell, TaskDirectives } from "./cell.ts";
import { markdownShellEventBus } from "./mdbus.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export async function executeTasks<T extends Task>(
  plan: TaskExecutionPlan<T>,
  directives: TaskDirectives<Any, Any, Any, Any>,
  verbose?:
    | false
    | Parameters<typeof verboseInfoShellEventBus>[0]["style"]
    | ReturnType<typeof markdownShellEventBus>,
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
      const mutated = await unsafeInterp.interpolate(source, {
        ...ctx,
        cell,
        partial: async (
          name: string,
          partialLocals?: Record<string, unknown>,
        ) => {
          const found = directives.partials.get(name);
          if (found) {
            const partialCell = directives.partialDirectives.find((pd) =>
              pd.partialDirective.partial.identity == found.identity
            );
            const { content: partial, interpolate, locals } = await found
              .content({
                cell,
                ...ctx,
                ...partialLocals,
                partial: partialCell,
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

  const sh = shell({
    bus: verbose
      ? typeof verbose === "string"
        ? verboseInfoShellEventBus({ style: verbose })
        : verbose.bus
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
      ? verboseInfoTaskEventBus<T, Context>({ style: "rich" })
      : errorOnlyTaskEventBus<T, Context>({
        style: verbose ? verbose : "rich",
      }),
  });
  if (summarize) console.dir({ summary });
  return summary;
}
