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

export const shebangSchema = z.union([
  z.object({ shebang: z.string(), source: z.string() }),
  z.literal(false),
]);

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

export type TaskCell<Provenance> = PlaybookCodeCell<Provenance> & {
  taskDirective: Extract<TaskDirective, { nature: "TASK" }>;
};

export type TaskDirectiveInspector<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = (
  ctx: {
    cell: PlaybookCodeCell<Provenance, CellAttrs>;
    pb: Playbook<Provenance, Frontmatter, CellAttrs, I>;
    registerIssue: (message: string, error?: unknown) => void;
  },
) => TaskDirective | false;

function parsedInfo(candidate?: string) {
  if (!candidate) return false;
  const info = candidate?.trim();
  if (info.length == 0) return false;
  const [first, ...rest] = info.split(/\s+/);
  const remainder = rest.join(" ").trim();
  return {
    first,
    rest,
    remainder,
  };
}

export function partialsInspector<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell, registerIssue }) => {
    const pi = parsedInfo(cell.info);
    if (pi && pi.first.toLocaleUpperCase() == "PARTIAL") {
      const fbc = {
        nature: "PARTIAL",
        partial: fbPartialCandidate(pi.remainder, cell.source, cell.attrs, {
          registerIssue,
        }),
      };
      const parsed = taskDirectiveSchema.safeParse(fbc);
      if (parsed.success) {
        return parsed.data;
      } else {
        registerIssue(
          `Zod error parsing task directive '${cell.info}': ${
            z.prettifyError(parsed.error)
          }`,
          parsed.error,
        );
      }
    }
    return false;
  };
}

export const safeParseShebang = (source: string) =>
  (source.startsWith("#!")
    ? {
      shebang: source.split("\n", 1)[0],
      source: source.slice(source.indexOf("\n") + 1),
    }
    : false) satisfies z.infer<typeof shebangSchema>;

export const spryCodeCellLang = "spry" as const;
export type SpryCodeCellLang = typeof spryCodeCellLang;

export function spryParser<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  isValidLanguage: (cell: PlaybookCodeCell<Provenance, CellAttrs>) => boolean =
    (cell) => cell.language == spryCodeCellLang,
): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell }) => {
    if (!isValidLanguage(cell)) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // TODO: should we warn about this or ignore it?
    return {
      nature: "TASK",
      identity: pi.first,
      source: cell.source,
      task: {
        strategy: "Cliffy.Command",
        command: new Command(), // need `action` to perform task
      },
    } satisfies TaskDirective;
  };
}

// Supports https://docs.deno.com/runtime/reference/cli/task/
export const denoTaskCodeCellLang = "deno-task" as const;
export type DenoTaskCodeCellLang = typeof denoTaskCodeCellLang;

export function denoTaskParser<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  isValidLanguage: (cell: PlaybookCodeCell<Provenance, CellAttrs>) => boolean =
    (cell) => cell.language == denoTaskCodeCellLang,
): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell }) => {
    if (!isValidLanguage(cell)) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // TODO: should we warn about this or ignore it?
    return {
      nature: "TASK",
      identity: pi.first,
      source: cell.source,
      task: { strategy: "Deno.Task" },
    };
  };
}

// Supports any #! language
export const bashCodeCellLang = "bash" as const;
export const shCodeCellLang = "sh" as const;
export const spawnableCellLangs = [shCodeCellLang, bashCodeCellLang] as const;
export type SpawnableCellLang = typeof spawnableCellLangs[number];

export function spawnableParser<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  isValidLanguage: (cell: PlaybookCodeCell<Provenance, CellAttrs>) => boolean =
    (cell) =>
      spawnableCellLangs.find((lang) => lang == cell.language) ? true : false,
): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell }) => {
    if (!isValidLanguage(cell)) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // TODO: should we warn about this or ignore it?
    const shebang = safeParseShebang(cell.source);
    return {
      nature: "TASK",
      identity: pi.first,
      source: cell.source,
      task: {
        strategy: "Deno.Command",
        command: "bash",
        shebang,
      },
    };
  };
}

export class TaskDirectives<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> {
  readonly tdInspectors: TaskDirectiveInspector<
    Provenance,
    Frontmatter,
    CellAttrs,
    I
  >[] = [];
  readonly issues: I[] = [];
  readonly tasks: TaskCell<Provenance>[] = [];

  constructor(
    readonly partials: ReturnType<
      typeof fbPartialsCollection<
        Extract<TaskDirective, { nature: "PARTIAL" }>
      >
    >,
    tdInspectors?: TaskDirectiveInspector<
      Provenance,
      Frontmatter,
      CellAttrs,
      I
    >[],
  ) {
    if (tdInspectors) this.use(...tdInspectors);
    else {
      this.use(
        partialsInspector(), // put this first
        denoTaskParser(),
        spawnableParser(),
        spryParser(),
      );
    }
  }

  use(
    ...tdInspectors: TaskDirectiveInspector<
      Provenance,
      Frontmatter,
      CellAttrs,
      I
    >[]
  ) {
    this.tdInspectors.push(...tdInspectors);
    return this;
  }

  partial(name: string) {
    return this.partials.partial(name);
  }

  registerIssue(issue: I) {
    this.issues.push(issue);
  }

  register(
    cell: PlaybookCodeCell<Provenance, CellAttrs>,
    pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
    opts?: {
      onUnknown?: (
        cell: PlaybookCodeCell<Provenance, CellAttrs>,
        pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
      ) => void;
    },
  ) {
    const tdiInit = {
      cell,
      pb,
      registerIssue: (message: string, error?: unknown) =>
        this.registerIssue({
          kind: "fence-issue",
          disposition: "error",
          error: error,
          message,
          provenance: pb.notebook.provenance,
          startLine: cell.startLine,
          endLine: cell.endLine,
        } as I),
    };

    for (const tdi of this.tdInspectors) {
      const td = tdi(tdiInit);
      if (td) {
        switch (td.nature) {
          case "PARTIAL":
            this.partials.register(td);
            return true;

          case "TASK": {
            const unsafeCell = cell as Any;
            unsafeCell.taskDirective = td;
            if (isTaskDirectiveSupplier(cell)) {
              this.tasks.push(cell as TaskCell<Provenance>);
            } else {
              throw new Error("This should never happen");
            }
            return true;
          }
        }
      }
    }

    opts?.onUnknown?.(cell, pb);
    return false;
  }
}
