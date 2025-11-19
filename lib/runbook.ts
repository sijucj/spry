#!/usr/bin/env -S deno run -A --node-modules-dir=auto

import { Command, EnumType } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import {
  bold,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "@std/fmt/colors";
import { relative } from "@std/path";
import { Code } from "types/mdast";
import { visit } from "unist-util-visit";
import { MarkdownDoc } from "./markdown/fluent-doc.ts";
import { markdownASTs, Yielded } from "./remark/mdastctl/io.ts";
import * as mdastCtl from "./remark/mdastctl/mod.ts";
import {
  CodeWithFrontmatterNode,
  isCodeWithFrontmatterNode,
} from "./remark/plugin/node/code-frontmatter.ts";
import { markdownShellEventBus } from "./task/mdbus.ts";
import { languageRegistry, LanguageSpec } from "./universal/code.ts";
import { ColumnDef, ListerBuilder } from "./universal/lister-tabular-tui.ts";
import { PosixPIQuery, queryPosixPI } from "./universal/posix-pi.ts";
import {
  errorOnlyShellEventBus,
  verboseInfoShellEventBus,
} from "./universal/shell.ts";
import {
  errorOnlyTaskEventBus,
  executionPlan,
  executionSubplan,
  verboseInfoTaskEventBus,
} from "./universal/task.ts";
import { computeSemVerSync } from "./universal/version.ts";

import { hasFlagOfType } from "./universal/cline.ts";
import { eventBus } from "./universal/event-bus.ts";
import { gitignore } from "./universal/gitignore.ts";
import { unsafeInterpolator } from "./universal/interpolate.ts";
import { shell, ShellBusEvents } from "./universal/shell.ts";
import {
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
} from "./universal/task.ts";
import { ensureTrailingNewline } from "./universal/text-utils.ts";
import { safeJsonStringify } from "./universal/tmpl-literal-aide.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type TaskExecContext = { runId: string };

export type TaskExecCapture = {
  cell: CodeWithFrontmatterNode;
  ctx: TaskExecContext;
  interpResult: Awaited<
    ReturnType<ReturnType<typeof execTasksState>["interpolateUnsafely"]>
  >;
  execResult?: Awaited<ReturnType<ReturnType<typeof shell>["auto"]>>;

  text: () => string;
  json: () => unknown;
};

export const typicalOnCapture = async (
  ci: string,
  tec: TaskExecCapture,
  capturedTaskExecs: Record<string, TaskExecCapture>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export const gitignorableOnCapture = async (
  ci: string,
  tec: TaskExecCapture,
  capturedTaskExecs: Record<string, TaskExecCapture>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
    const flags = tec.cell.data.codeFM.pi.flags;
    if (flags && hasFlagOfType(flags, "gitignore")) {
      const gi = ci.slice("./".length);
      if (hasFlagOfType(flags, "gitignore", "string")) {
        await gitignore(gi, flags.gitignore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export function execTasksState(
  tasks: Iterable<{ code: CodeWithFrontmatterNode }>,
  opts?: {
    unsafeInterp?: ReturnType<typeof unsafeInterpolator>;
    onCapture?: (
      ci: string,
      tec: TaskExecCapture,
      capturedTaskExecs: Record<string, TaskExecCapture>,
    ) => void | Promise<void>;
  },
) {
  const capturedTaskExecs = {} as Record<string, TaskExecCapture>;
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
    tec: Pick<TaskExecCapture, "cell" | "ctx" | "interpResult" | "execResult">,
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
    return { ...tec, text, json } satisfies TaskExecCapture;
  };

  const captureTaskExec = async (cap: TaskExecCapture) => {
    const { cell: { data: { codeFM: { pi } } } } = cap;
    const captureFlags = [
      pi.flags.capture,
      pi.flags.C,
    ].filter((v) => v !== undefined);

    const captureInstructions = captureFlags.flatMap((v) =>
      typeof v === "boolean" ? [pi.pos[0]] : Array.isArray(v) ? v : [v]
    ).filter((v) => v !== undefined).map(String);

    for (const ci of captureInstructions) {
      await onCapture(ci, cap, capturedTaskExecs);
    }
  };

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: { code: CodeWithFrontmatterNode },
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
    const qppi = queryPosixPI(cell.code.data.codeFM.pi);
    const source = cell.code.value;
    if (!qppi.hasFlag("interpolate", "I")) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, {
        ...ctx,
        cell,
        captured: capturedTaskExecs,
        // deno-lint-ignore require-await
        partial: async (
          name: string,
          _partialLocals?: Record<string, unknown>,
        ) => {
          // const found = tasks.partials.get(name);
          // if (found) {
          //   const partialCell = tasks.partialDirectives.find((pd) =>
          //     pd.partialDirective.partial.identity == found.identity
          //   );
          //   const { content: partial, interpolate, locals } = await found
          //     .content({
          //       cell,
          //       captured: capturedTaskExecs,
          //       ...ctx,
          //       ...partialLocals,
          //       partial: partialCell,
          //     });
          //   if (!interpolate) return partial;
          //   return await unsafeInterp.interpolate(partial, locals, [{
          //     template: partial,
          //   }]);
          // } else {
          //   return `/* partial '${name}' not found */`;
          // }
          return `/* TODO: partials '${name}' not implemented */`;
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
  T extends Task & { code: CodeWithFrontmatterNode },
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

// -----------------------------------------
// CLI
// -----------------------------------------

const MISSING = "??";

export type LsTaskRow = {
  code: Code;
  name: string;
  origin: string;
  language: string;
  descr: string;
  deps?: string;
};

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
    format: (v) => brightYellow(v), // TODO: give per-language color
  };
}

function lsLanguageField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["language"]>
> {
  return {
    header: "Lang",
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

export enum VerboseStyle {
  Plain = "plain",
  Rich = "rich",
  Markdown = "markdown",
}

export function informationalEventBuses<T extends Task, Context>(
  verbose?: VerboseStyle,
) {
  if (!verbose) {
    return {
      shellEventBus: errorOnlyShellEventBus({ style: "rich" }),
      tasksEventBus: errorOnlyTaskEventBus<T, Context>({ style: "rich" }),
    };
  }

  switch (verbose) {
    case VerboseStyle.Plain:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "plain" }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "plain" }),
      };

    case VerboseStyle.Rich:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "rich" }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "rich" }),
      };

    case VerboseStyle.Markdown: {
      const md = new MarkdownDoc();
      const mdSEB = markdownShellEventBus({ md });
      return {
        mdSEB,
        shellEventBus: mdSEB.bus,
        tasksEventBus: undefined, // TODO: add tasks to markdown
        md,
        emit: () => console.log(md.write()),
      };
    }
  }
}

const verboseOpt = [
  "--verbose <style:verboseStyle>",
  "Emit information messages verbosely",
] as const;

const verboseStyle = new EnumType(VerboseStyle);

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

export class CLI {
  readonly mdastCLI: mdastCtl.CLI;
  readonly isSpawnable: (
    code: Code,
  ) => LanguageSpec | undefined;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[]; // load these markdown files/remotes when no CLI arguments given
      readonly mdastCLI?: mdastCtl.CLI;
      readonly isSpawnable?: CLI["isSpawnable"];
    },
  ) {
    this.isSpawnable = conf?.isSpawnable ??
      ((code) =>
        spawnableLangSpecs.find((lang) =>
          lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
        ));
    this.mdastCLI = conf?.mdastCLI ??
      new mdastCtl.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name("runbook.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`Spry Runbook operator`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("mdast", this.mdastCLI.mdastCommand())
      .command("ls", this.lsCommand())
      .command("task", this.taskCommand())
      .command("run", this.runCommand());
  }

  async *markdownASTs(positional: string[], defaults: string[]) {
    const merged = [
      ...(positional.length ? positional : defaults),
    ];
    if (merged.length > 0) {
      yield* markdownASTs(merged, {
        onError: (src, error) => {
          console.error({ src, error });
          return false;
        },
      });
    }
  }

  async markdownTasks(mdASTs: ReturnType<CLI["markdownASTs"]>) {
    const tasksWithOrigin: {
      taskId: () => string; // satisfies Task interface
      taskDeps: () => string[]; // satisfies Task interface
      code: CodeWithFrontmatterNode;
      md: Yielded<typeof mdASTs>;
      qppi: PosixPIQuery;
    }[] = [];
    for await (const md of mdASTs) {
      visit(md.mdastRoot, "code", (node) => {
        if (this.isSpawnable(node) && isCodeWithFrontmatterNode(node)) {
          if (node.data.codeFM.pi.posCount) {
            const qppi = queryPosixPI(node.data.codeFM.pi);
            tasksWithOrigin.push({
              taskId: () => qppi.getFirstBareWord()!,
              taskDeps: () => qppi.getTextFlagValues("dep"),
              code: node,
              md,
              qppi,
            });
          } else {
            console.error(
              `markdownTasks error: no task ID for cell at ${md.fileRef(node)}`,
            );
          }
        }
      });
    }
    const tasks = tasksWithOrigin.map((t) => t.code);
    return tasksWithOrigin.map((t) => {
      return {
        ...t,
        // overwrite the final dependencies with "injected" ones, too
        deps: () => this.taskDeps(tasks, t.taskId(), t.taskDeps()),
      };
    });
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "runbook";
    const { defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./runbook.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://SpryMD.org/runbook.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./runbook.d https://qualityfolio.dev/runbook.md another.md`,
      );
  }

  taskCommand() {
    return new Command()
      .name("task")
      .description(`execute a specific cell and dependencies`)
      .type("verboseStyle", verboseStyle)
      .arguments("<taskId> [paths...:string]")
      .option(...verboseOpt)
      .option("--summarize", "Emit summary after execution in JSON")
      .action(
        async (opts, taskId, ...paths: string[]) => {
          const tasks = await this.markdownTasks(
            this.markdownASTs(paths, this.conf?.defaultFiles ?? []),
          );
          if (tasks.find((t) => t.taskId() == taskId)) {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              TaskExecContext
            >(opts?.verbose);
            const runbook = await executeTasks(
              executionSubplan(executionPlan(tasks), [taskId]),
              execTasksState(tasks, {
                onCapture: gitignorableOnCapture,
              }),
              { shellBus: ieb.shellEventBus, tasksBus: ieb.tasksEventBus },
            );
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(runbook);
            }
          } else {
            console.warn(`Task '${taskId}' not found.`);
          }
        },
      );
  }

  runCommand() {
    return new Command()
      .name("run")
      .description(`execute all code cells in markdown documents as a DAG`);
  }

  // -------------------------------------------------------------------------
  // ls command (tabular "physical" view)
  // -------------------------------------------------------------------------

  /**
   * `ls` – list mdast nodes in a tabular, content-hierarchy-friendly way.
   *
   * - By default: includes every node in the tree.
   * - With `--select <expr>`: only nodes matching that mdastql expression.
   * - With `--data`: adds a DATA column showing `Object.keys(node.data)`.
   * - With automatic node classification (via frontmatter + nodeClassifier),
   *   shows a CLASS column with key:value pairs.
   */
  protected lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`list code cells (tasks) in markdown documents`)
      .arguments("[paths...:string]")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const tasks = await this.markdownTasks(
            this.markdownASTs(paths, this.conf?.defaultFiles ?? []),
          );
          const lsRows = tasks.map((task) => {
            const { qppi } = task;
            return {
              code: task.code,
              name: task.taskId(),
              deps: task.taskDeps().join(", "),
              descr: qppi.getTextFlag("descr") ?? "",
              origin: task.md.fileRef(task.code, Deno.cwd()),
              language: task.code.lang ?? MISSING,
            } satisfies LsTaskRow;
          });

          if (lsRows.length === 0) {
            console.log(
              gray(
                "No nodes matched (did you supply any valid markdown files?).",
              ),
            );
            return;
          }

          const useColor = options.color;
          const builder = new ListerBuilder<LsTaskRow>()
            .from(lsRows)
            .declareColumns("name", "language", "deps", "descr", "origin")
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.field("name", "name", lsTaskIdField());
          builder.field("language", "language", lsLanguageField());
          builder.field("deps", "deps", {
            header: "DEPS",
            defaultColor: brightYellow,
          });
          builder.field("descr", "descr", { header: "DESCR" });
          builder.field("origin", "origin", lsColorPathField("ORIGIN"));

          builder.select("name", "language", "deps", "descr", "origin");

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }

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
   *
   * Assumptions:
   *
   * - `this.tasks` exists and is an array of task-like code cells.
   * - Each task that participates has `parsedPI.firstToken` (string task name) and
   *   `parsedPI.flags` (an object).
   *
   * @param taskId The task identifier we are resolving deps for.
   *
   * @param taskDeps Existing, explicit dependencies for this task. Used only for de-duping.
   *
   * @example
   * ```ts
   * const { injected, errors } = this.injectedDeps("build", ["clean"]);
   * // injected could be ["lint","compile"]
   * // errors could be [{ taskId: "weirdTask", regEx: "(" }]
   * ```
   */
  injectedDeps(
    tasks: Iterable<Code>,
    taskId: string,
    taskDeps: string[] = [],
  ) {
    const injected: string[] = [];
    const errors: { taskId: string; regEx: string }[] = [];

    // normalize taskDeps just in case caller passed something weird
    const safeTaskDeps = Array.isArray(taskDeps) ? taskDeps : [];

    for (const t of tasks) {
      if (!isCodeWithFrontmatterNode(t)) continue;

      const { codeFM: { pi } } = t.data;
      if (!pi.posCount) continue; // no cell identifier
      const cellName = pi.pos[0];

      const flags = pi.flags;
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
          } catch {
            // Record invalid regex source
            errors.push({
              taskId: typeof cellName === "string" && cellName
                ? cellName
                : "(unknown-task)",
              regEx: expr,
            });
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
        if (re instanceof RegExp && re.test(taskId)) {
          matches = true;
          break;
        }
      }

      if (!matches) continue;

      // Inject this task's firstToken (the task name)
      const depName = cellName;
      if (
        typeof depName === "string" &&
        depName.length > 0 &&
        !safeTaskDeps.includes(depName) &&
        !injected.includes(depName)
      ) {
        injected.push(depName);
      }
    }

    return { injected, errors };
  }

  /**
   * Returns a merged list of explicit and injected dependencies for a given task.
   *
   * This is a lightweight wrapper around {@link injectedDeps} that merges
   * the explicitly declared `taskDeps` (if any) with automatically injected
   * dependencies discovered via `--injected-dep` flags on other tasks.
   *
   * Results are cached per `taskId` in the provided `cellDepsCache` map.
   *
   * @param taskId The task identifier to resolve dependencies for.
   *
   * @param taskDeps Optional list of explicitly declared dependencies for this task.
   *
   * @param cellDepsCache Cache map used to store and retrieve previously resolved dependency lists.
   *
   * @returns A unique, ordered list of merged dependencies for the given `taskId`.
   *
   * @example
   * ```ts
   * const cache = new Map<string, string[]>();
   * const deps = this.cellDeps("build", ["clean"], cache);
   * // => ["clean", "compile", "lint"]
   * ```
   */
  taskDeps(
    tasks: Iterable<Code>,
    taskId: string,
    taskDeps: string[] | undefined,
    cellDepsCache?: Map<string, string[]>,
  ) {
    // Return cached value if available
    if (cellDepsCache) {
      const cached = cellDepsCache.get(taskId);
      if (cached) return cached;
    }

    // Compute injected dependencies
    const { injected } = this.injectedDeps(tasks, taskId, taskDeps ?? []);

    // Merge explicit + injected dependencies, ensuring uniqueness and order
    const merged = Array.from(
      new Set([...injected, ...(taskDeps ?? [])]),
    );

    // Cache and return result
    cellDepsCache?.set(taskId, merged);
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await new CLI().run();
}
