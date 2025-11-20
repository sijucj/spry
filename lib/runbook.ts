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
import { MarkdownDoc } from "./markdown/fluent-doc.ts";
import { markdownASTs, Yielded } from "./remark/mdastctl/io.ts";
import * as mdastCtl from "./remark/mdastctl/mod.ts";
import {
  CodeWithFrontmatterNode,
} from "./remark/plugin/node/code-frontmatter.ts";
import { markdownShellEventBus } from "./task/mdbus.ts";
import { languageRegistry, LanguageSpec } from "./universal/code.ts";
import { ColumnDef, ListerBuilder } from "./universal/lister-tabular-tui.ts";
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

import { visit } from "unist-util-visit";
import { depsResolver } from "./remark/mdast/depends.ts";
import { codePartialsCollection } from "./remark/plugin/node/code-partial.ts";
import {
  CodeSpawnableNode,
  isCodeSpawnableNode,
} from "./remark/plugin/node/code-spawnable.ts";
import { hasFlagOfType } from "./universal/cline.ts";
import { eventBus } from "./universal/event-bus.ts";
import { gitignore } from "./universal/gitignore.ts";
import { unsafeInterpolator } from "./universal/interpolate.ts";
import { shell, ShellBusEvents } from "./universal/shell.ts";
import {
  executionPlanVisuals,
  ExecutionPlanVisualStyle,
} from "./universal/task-visuals.ts";
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
  cell: CodeSpawnableNode;
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
  partialsCollec: ReturnType<typeof codePartialsCollection>,
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
    ).filter((v) => v !== undefined).filter((v) => typeof v === "string");

    for (const ci of captureInstructions) {
      await onCapture(ci, cap, capturedTaskExecs);
    }
  };

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: { code: CodeSpawnableNode },
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
  T extends Task & { code: CodeSpawnableNode },
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

export type LsTaskRow = {
  code: Code;
  name: string;
  origin: string;
  engine: ReturnType<ReturnType<typeof shell>["strategy"]>;
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

function lsCmdEngineField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["engine"]>
> {
  return {
    header: "ENGINE",
    format: (v) => {
      switch (v.engine) {
        case "shebang":
          return green(v.label);
        case "deno-task":
          return cyan(v.label);
      }
    },
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

  async *markdownASTs(
    positional: string[],
    defaults: string[],
    options?: Parameters<typeof markdownASTs>[1],
  ) {
    const merged = [
      ...(positional.length ? positional : defaults),
    ];
    if (merged.length > 0) {
      yield* markdownASTs(merged, {
        onError: (src, error) => {
          console.error({ src, error });
          return false;
        },
        ...options,
      });
    }
  }

  async markdownTasks(mdASTs: ReturnType<CLI["markdownASTs"]>) {
    const tasksWithOrigin: {
      taskId: () => string; // satisfies Task interface
      taskDeps: () => string[]; // satisfies Task interface
      code: CodeSpawnableNode;
      md: Yielded<typeof mdASTs>;
    }[] = [];
    for await (const md of mdASTs) {
      visit(md.mdastRoot, "code", (code) => {
        if (isCodeSpawnableNode(code)) {
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
    const dr = depsResolver(
      tasksWithOrigin.map((t) => {
        return {
          nodeName: t.taskId(),
          injectableFlags: t.code.data.codeFM.pi.flags,
        };
      }),
    );
    return tasksWithOrigin.map((t) => {
      return {
        ...t,
        // overwrite the final dependencies with "injected" ones, too
        deps: () => dr.deps(t.taskId(), t.taskDeps()),
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
          const partialsCollec = codePartialsCollection();
          const tasks = await this.markdownTasks(
            this.markdownASTs(paths, this.conf?.defaultFiles ?? [], {
              codePartialsCollec: partialsCollec,
            }),
          );
          if (tasks.find((t) => t.taskId() == taskId)) {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              TaskExecContext
            >(opts?.verbose);
            const runbook = await executeTasks(
              executionSubplan(executionPlan(tasks), [taskId]),
              execTasksState(tasks, partialsCollec, {
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
      .description(`execute all code cells in markdown documents as a DAG`)
      .type("verboseStyle", verboseStyle)
      .type("visualStyle", new EnumType(ExecutionPlanVisualStyle))
      .arguments("[paths...:string]")
      .option(...verboseOpt)
      .option("--summarize", "Emit summary after execution in JSON")
      .option("--visualize <style:visualStyle>", "Visualize the DAG")
      .action(
        async (opts, ...paths: string[]) => {
          const partialsCollec = codePartialsCollection();
          const tasks = await this.markdownTasks(
            this.markdownASTs(paths, this.conf?.defaultFiles ?? [], {
              codePartialsCollec: partialsCollec,
            }),
          );
          const plan = executionPlan(tasks);
          if (opts?.visualize) {
            const epv = executionPlanVisuals(plan);
            console.log(epv.visualText(opts.visualize));
          } else {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              TaskExecContext
            >(opts?.verbose);
            const runbook = await executeTasks(
              plan,
              execTasksState(tasks, partialsCollec, {
                onCapture: gitignorableOnCapture,
              }),
              { shellBus: ieb.shellEventBus, tasksBus: ieb.tasksEventBus },
            );
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(runbook);
            }
          }
        },
      );
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
          const sh = shell();
          const tasks = await this.markdownTasks(
            this.markdownASTs(paths, this.conf?.defaultFiles ?? []),
          );
          const lsRows = tasks.map((task) => {
            const { code: { data: { codeSpawnable: { pi } } } } = task;
            return {
              code: task.code,
              name: task.taskId(),
              deps: task.taskDeps().join(", "),
              descr: pi.getTextFlag("descr") ?? "",
              origin: task.md.fileRef(task.code, Deno.cwd()),
              engine: sh.strategy(task.code.value),
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
            .declareColumns("name", "engine", "deps", "descr", "origin")
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.field("name", "name", lsTaskIdField());
          builder.field("engine", "engine", lsCmdEngineField());
          builder.field("deps", "deps", {
            header: "DEPS",
            defaultColor: yellow,
          });
          builder.field("descr", "descr", { header: "DESCR" });
          builder.field("origin", "origin", lsColorPathField("ORIGIN"));

          builder.select("name", "deps", "descr", "origin", "engine");

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await new CLI().run();
}
