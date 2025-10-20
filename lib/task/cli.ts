import {
  bold,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "jsr:@std/fmt@^1/colors";
import { relative } from "jsr:@std/path@^1";
import { ColumnDef, ListerBuilder } from "../universal/lister-tabular-tui.ts";
import { isTaskDirectiveSupplier, TaskCell } from "./cell.ts";
import {
  ContinueOrTerminate,
  executeDAG,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
  TaskExecutionResult,
} from "../universal/task.ts";
import { eventBus } from "../universal/event-bus.ts";

export type LsTaskRow = {
  name: string;
  notebook: string;
  language: string;
  deps?: string[];
  error?: unknown;
};

export async function ls<Provenance>(tasks: TaskCell<Provenance>[]) {
  function lsColorPathField<Row extends LsTaskRow>(
    header: string,
  ): Partial<ColumnDef<Row, string>> {
    return {
      header,
      format: (supplied) => {
        const p = relative(Deno.cwd(), supplied);
        const i = p.lastIndexOf("/");
        return i < 0 ? bold(p) : gray(p.slice(0, i + 1)) + bold(p.slice(i + 1));
      },
      rules: [{
        when: (_v, r) =>
          "error" in r
            ? ((r.error ? String(r.error)?.trim().length ?? 0 : 0) > 0)
            : false,
        color: red,
      }],
    };
  }

  function lsTaskIdField<Row extends LsTaskRow>(): Partial<
    ColumnDef<Row, Row["name"]>
  > {
    return {
      header: "Name",
      format: (v) =>
        v === "head_sql"
          ? green(v)
          : v === "tail_sql"
          ? yellow(v)
          : v === "sqlpage_file_upsert"
          ? brightYellow(v)
          : cyan(v),
    };
  }

  function lsLanguageField<Row extends LsTaskRow>(): Partial<
    ColumnDef<Row, Row["language"]>
  > {
    return {
      header: "Language",
      format: (v) =>
        v === "head_sql"
          ? green(v)
          : v === "tail_sql"
          ? yellow(v)
          : v === "sqlpage_file_upsert"
          ? brightYellow(v)
          : cyan(v),
    };
  }

  const tasksList = tasks.map((t) => {
    return {
      name: t.taskId(),
      notebook: String(t.provenance),
      language: t.language,
      deps: t.taskDeps?.(),
    } satisfies LsTaskRow;
  });

  await new ListerBuilder<LsTaskRow>()
    .declareColumns("name", "notebook", "language", "deps", "error")
    .from(tasksList)
    .field("name", "name", lsTaskIdField())
    .field("language", "language", lsLanguageField())
    .field("notebook", "notebook", lsColorPathField("Notebook"))
    .field("error", "error", { header: "Err" })
    .sortBy("name").sortDir("asc")
    .build()
    .ls(true);
}

export async function executeTasks<T extends Task>(plan: TaskExecutionPlan<T>) {
  type Context = { runId: string };

  const bus = eventBus<TaskExecEventMap<T, Context>>();
  bus.on(
    "task:start",
    ({ id }) => console.info({ event: "task:start", task: id }),
  );
  bus.on(
    "error",
    ({ message }) => console.error({ error: message }),
  );
  bus.on(
    "task:end",
    ({ id }) => console.info({ event: "task:start", task: id }),
  );

  await executeDAG(
    plan,
    // deno-lint-ignore require-await
    async (supplied, ctx) => {
      const invalid = (error: Error) => {
        console.error(error);
        return {
          disposition: "continue",
          ctx,
          success: false,
          exitCode: -1,
          startedAt: now,
          endedAt: now,
          error,
        } satisfies TaskExecutionResult<Context> & {
          disposition: ContinueOrTerminate;
        };
      };
      const now = new Date();

      // task is a TaskCell<Provenance> discrimated type
      if (!isTaskDirectiveSupplier(supplied)) {
        return invalid(
          new Error("Unknown type of task: not a TaskDirectiveSupplier"),
        );
      }

      const { taskDirective: td } = supplied;
      switch (td.nature) {
        case "TASK": {
          console.log(td.nature, td.task.strategy);
          switch (td.task.strategy) {
            case "Deno.Task": {
              break;
            }
            default:
              return invalid(
                new Error(
                  `Unknown type of task: is a TaskDirectiveSupplier with known task nature '${td.nature}' but strategy '${td.task.strategy}' unknown`,
                ),
              );
          }
          break;
        }

        default:
          return invalid(
            new Error(
              `Unknown type of task: is a TaskDirectiveSupplier but unknown task nature '${td.nature}'`,
            ),
          );
      }

      return {
        disposition: "continue",
        ctx,
        success: true,
        exitCode: 0,
        startedAt: now,
        endedAt: now,
      };
    },
    { eventBus: bus },
  );
}
