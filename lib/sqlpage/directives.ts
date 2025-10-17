import { z } from "jsr:@zod/zod@4";
import {
  fbPartialCandidate,
  fbPartialsCollection,
  mdFencedBlockPartialSchema,
} from "../universal/md-partial.ts";
import {
  PlaybookCodeCell,
  PlaybookCodeCellMutator,
} from "../universal/md-playbook.ts";

export const sqlCodeCellLang = "sql" as const;

// deno-lint-ignore no-explicit-any
type Any = any;

/** Schema for typed SqlDirective from `Cell.info?` property */
export const sqlDirectiveSchema = z.discriminatedUnion("nature", [
  z.object({
    nature: z.enum(["HEAD", "TAIL"]),
    identity: z.string().min(1).optional(), // optional for HEAD/TAIL
  }).strict(),
  z.object({
    nature: z.literal("sqlpage_file"),
    path: z.string().min(1),
  }).strict(),
  z.object({
    nature: z.literal("PARTIAL"),
    partial: mdFencedBlockPartialSchema,
  }).strict(),
]);

export type SqlDirective = z.infer<typeof sqlDirectiveSchema>;

export const isSqlDirectiveSupplier = (
  o: unknown,
): o is { sqlDirective: SqlDirective } =>
  o && typeof o === "object" && "sqlDirective" in o &&
    typeof o.sqlDirective === "object"
    ? true
    : false;

type DocCodeCellWithDirective<N extends SqlDirective["nature"]> =
  & PlaybookCodeCell<string>
  & { sqlDirective: Extract<SqlDirective, { nature: N }> };

function docCodeCellHasNature<N extends SqlDirective["nature"]>(
  cell: PlaybookCodeCell<string> & { sqlDirective: SqlDirective },
  nature: N,
): cell is DocCodeCellWithDirective<N> {
  return cell.sqlDirective.nature === nature;
}

export class SqlDirectiveCells {
  readonly heads: (PlaybookCodeCell<string> & {
    sqlDirective: Extract<SqlDirective, { nature: "HEAD" }>;
  })[] = [];
  readonly tails: (PlaybookCodeCell<string> & {
    sqlDirective: Extract<SqlDirective, { nature: "TAIL" }>;
  })[] = [];

  constructor(
    readonly partials: ReturnType<typeof fbPartialsCollection>,
  ) {
  }

  register(cell: PlaybookCodeCell<string>) {
    if (cell.language !== sqlCodeCellLang) return false;

    // assume the enrichSqlDirective has already been run
    if (isSqlDirectiveSupplier(cell)) {
      if (docCodeCellHasNature(cell, "HEAD")) {
        this.heads.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "TAIL")) {
        this.tails.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "PARTIAL")) {
        this.partials.register(cell.sqlDirective.partial);
        return true;
      }
    }
    return false;
  }

  partial(name: string) {
    return this.partials.get(name);
  }
}

/**
 * Transform that parses a Cell.info string into an SqlDirective.
 * - HEAD/TAIL → optional identity
 * - PARTIAL → requires identity and optional --inject, --prepend, --append
 * - unknown → defaults to { nature: "sqlpage_file", path: first token }
 */
export const enrichSqlDirective: PlaybookCodeCellMutator<string> = (
  cell,
  { pb, registerIssue },
) => {
  if (isSqlDirectiveSupplier(cell)) return;
  if (cell.language !== sqlCodeCellLang) return;
  if (!cell.info) return;

  let info = cell.info;
  info = info?.trim() ?? "";
  if (info.length === 0) return undefined;

  const [first, ...rest] = info.split(/\s+/);
  const remainder = rest.join(" ").trim();

  let candidate: unknown;
  switch (first.toLocaleUpperCase()) {
    case "HEAD":
    case "TAIL":
      candidate = remainder
        ? { nature: first, identity: remainder }
        : { nature: first };
      break;

    case "PARTIAL": {
      candidate = {
        nature: "PARTIAL",
        partial: fbPartialCandidate(remainder, cell.source, cell.attrs, {
          registerIssue: (message, error) =>
            registerIssue({
              kind: "fence-issue",
              disposition: "error",
              error,
              message,
              provenance: pb.notebook.provenance,
              startLine: cell.startLine,
              endLine: cell.endLine,
            }),
        }),
      };
      break;
    }

    default:
      candidate = { nature: "sqlpage_file", path: first };
      break;
  }

  const parsed = z.safeParse(sqlDirectiveSchema, candidate);
  if (parsed.success) {
    (cell as Any).sqlDirective = parsed.data;
    if (!isSqlDirectiveSupplier(cell)) {
      throw Error("This should never happen");
    }
  } else {
    registerIssue({
      kind: "fence-issue",
      disposition: "error",
      error: parsed.error,
      message: `Zod error parsing info directive '${cell.info}': ${
        z.prettifyError(parsed.error)
      }`,
      provenance: pb.notebook.provenance,
      startLine: cell.startLine,
      endLine: cell.endLine,
    });
  }
};
