import { globToRegExp, isGlob } from "jsr:@std/path@^1";
import { z } from "jsr:@zod/zod@4";
import { posix } from "node:path";
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
    nature: z.literal("LAYOUT"),
    glob: z.string().min(1).default("**/*"), // default glob
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

export class Layouts {
  readonly layouts: (PlaybookCodeCell<string> & {
    sqlDirective: Extract<SqlDirective, { nature: "LAYOUT" }>;
  })[] = [];
  protected cached: {
    layout: PlaybookCodeCell<string> & {
      sqlDirective: Extract<SqlDirective, { nature: "LAYOUT" }>;
    };
    glob: string;
    g: string;
    re: RegExp;
    wc: number;
    len: number;
  }[] = [];

  register(cell: PlaybookCodeCell<string>) {
    // assume the enrichSqlDirective has already been run
    if (isSqlDirectiveSupplier(cell)) {
      if (docCodeCellHasNature(cell, "LAYOUT")) {
        this.layouts.push(cell);
        this.rebuildCaches();
        return true;
      }
    }
    return false;
  }

  /** Build a matcher once; use findLayout(path) to get the closest matching glob. */
  protected rebuildCaches() {
    function toRegex(glob: string): RegExp {
      if (!isGlob(glob)) {
        // Treat literal as exact match (normalize + escape)
        const exact = posix.normalize(glob).replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        return new RegExp(`^${exact}$`);
      }
      return globToRegExp(glob, {
        extended: true,
        globstar: true,
        caseInsensitive: false,
      });
    }

    function wildcardCount(g: string): number {
      // Penalize '**' heavier so it's considered less specific
      const starStar = (g.match(/\*\*/g) ?? []).length * 2;
      const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
      return starStar + singles;
    }

    this.cached = this.layouts.map((layout) => {
      const { glob } = layout.sqlDirective;
      const gg = posix.normalize(glob);
      return {
        layout,
        glob,
        g: gg,
        re: toRegex(gg),
        wc: wildcardCount(gg),
        len: gg.length,
      };
    });
  }

  findLayout(path: string) {
    const p = posix.normalize(path);
    const hits = this.cached.filter((c) => c.re.test(p));
    if (!hits.length) return undefined;
    hits.sort((a, b) => (a.wc - b.wc) || (b.len - a.len));
    const cell = hits[0].layout;
    return { cell, wrap: (text: string) => `${cell.source}\n${text}` };
  }
}

export class SqlDirectiveCells {
  readonly layouts = new Layouts();
  readonly heads: (PlaybookCodeCell<string> & {
    sqlDirective: Extract<SqlDirective, { nature: "HEAD" }>;
  })[] = [];
  readonly tails: (PlaybookCodeCell<string> & {
    sqlDirective: Extract<SqlDirective, { nature: "TAIL" }>;
  })[] = [];

  constructor(
    readonly partials: ReturnType<
      typeof fbPartialsCollection<
        Extract<SqlDirective, { nature: "PARTIAL" }>
      >
    >,
  ) {
  }

  register(cell: PlaybookCodeCell<string>) {
    if (cell.language !== sqlCodeCellLang) return false;
    if (this.layouts.register(cell)) return true;

    // assume the enrichSqlDirective has already been run
    if (isSqlDirectiveSupplier(cell)) {
      if (docCodeCellHasNature(cell, "HEAD")) {
        this.heads.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "TAIL")) {
        this.tails.push(cell);
        return true;
      } else if (docCodeCellHasNature(cell, "PARTIAL")) {
        this.partials.register(cell.sqlDirective);
        return true;
      }
    }
    return false;
  }

  partial(name: string) {
    return this.partials.partial(name);
  }
}

/**
 * Transform that parses a Cell.info string into an SqlDirective.
 * - HEAD/TAIL → optional identity
 * - LAYOUT → glob defaults to "**\/*" if missing
 * - PARTIAL → requires identity
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

    case "LAYOUT":
      candidate = { nature: "LAYOUT", glob: remainder || "**/*" };
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
