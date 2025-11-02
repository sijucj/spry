import {
  errorOnlyShellEventBus,
  shell,
  verboseInfoShellEventBus,
} from "../universal/shell.ts";
import {
  errorOnlyTaskEventBus,
  executeDAG,
  ok,
  Task,
  TaskExecutionPlan,
  TaskExecutorBuilder,
  verboseInfoTaskEventBus,
} from "../universal/task.ts";
import { matchTaskNature } from "./cell.ts";

export async function executeTasks<T extends Task>(
  plan: TaskExecutionPlan<T>,
  verbose?: false | Parameters<typeof verboseInfoShellEventBus>[0]["style"],
  summarize?: boolean,
) {
  type Context = { runId: string };

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
        await sh.auto(cell.source);
        return ok(ctx);
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
