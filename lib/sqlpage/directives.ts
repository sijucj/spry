import { globToRegExp, isGlob } from "jsr:@std/path@^1";
import { z } from "jsr:@zod/zod@4";
import { posix } from "node:path";
import { DocCodeCellMutator, DocumentedCodeCell } from "../notebook/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Schema for typed InfoDirective from `Cell.info?` property */
export const sqlInfoDirectiveSchema = z.discriminatedUnion("nature", [
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
        identity: z.string().min(1), // required for PARTIAL
    }).strict(),
]);

export type SqlInfoDirective = z.infer<typeof sqlInfoDirectiveSchema>;

export const isSqlInfoDirectiveSupplier = (
    o: unknown,
): o is { infoDirective: SqlInfoDirective } =>
    o && typeof o === "object" && "infoDirective" in o &&
        typeof o.infoDirective === "object"
        ? true
        : false;

type DocCodeCellWithDirective<N extends SqlInfoDirective["nature"]> =
    & DocumentedCodeCell<string>
    & { infoDirective: Extract<SqlInfoDirective, { nature: N }> };

function docCodeCellHasNature<N extends SqlInfoDirective["nature"]>(
    cell: DocumentedCodeCell<string> & { infoDirective: SqlInfoDirective },
    nature: N,
): cell is DocCodeCellWithDirective<N> {
    return cell.infoDirective.nature === nature;
}

export class Layouts {
    readonly layouts: (DocumentedCodeCell<string> & {
        infoDirective: Extract<SqlInfoDirective, { nature: "LAYOUT" }>;
    })[] = [];
    protected cached: {
        layout: DocumentedCodeCell<string> & {
            infoDirective: Extract<SqlInfoDirective, { nature: "LAYOUT" }>;
        };
        glob: string;
        g: string;
        re: RegExp;
        wc: number;
        len: number;
    }[] = [];

    register(cell: DocumentedCodeCell<string>) {
        // assume the enrichInfoDirective has already been run
        if (isSqlInfoDirectiveSupplier(cell)) {
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
            const singles =
                (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
            return starStar + singles;
        }

        this.cached = this.layouts.map((layout) => {
            const { glob } = layout.infoDirective;
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

export class InfoDirectiveCells {
    readonly layouts = new Layouts();
    readonly heads: (DocumentedCodeCell<string> & {
        infoDirective: Extract<SqlInfoDirective, { nature: "HEAD" }>;
    })[] = [];
    readonly tails: (DocumentedCodeCell<string> & {
        infoDirective: Extract<SqlInfoDirective, { nature: "TAIL" }>;
    })[] = [];
    readonly partials: (DocumentedCodeCell<string> & {
        infoDirective: Extract<SqlInfoDirective, { nature: "PARTIAL" }>;
    })[] = [];

    register(cell: DocumentedCodeCell<string>) {
        if (this.layouts.register(cell)) return true;

        // assume the enrichInfoDirective has already been run
        if (isSqlInfoDirectiveSupplier(cell)) {
            if (docCodeCellHasNature(cell, "HEAD")) {
                this.heads.push(cell);
                return true;
            } else if (docCodeCellHasNature(cell, "TAIL")) {
                this.tails.push(cell);
                return true;
            } else if (docCodeCellHasNature(cell, "PARTIAL")) {
                this.partials.push(cell);
                return true;
            }
        }
        return false;
    }
}

/**
 * Transform that parses a Cell.info string into an InfoDirective.
 * - HEAD/TAIL → optional identity
 * - LAYOUT → glob defaults to "**\/*" if missing
 * - PARTIAL → requires identity
 * - unknown → defaults to { nature: "sqlpage_file", path: first token }
 */
export const enrichInfoDirective: DocCodeCellMutator<string> = (
    cell,
    { nb, registerIssue },
) => {
    if (isSqlInfoDirectiveSupplier(cell)) return;
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

        case "PARTIAL":
            candidate = { nature: "PARTIAL", identity: remainder };
            break;

        default:
            candidate = { nature: "sqlpage_file", path: first };
            break;
    }

    const parsed = z.safeParse(sqlInfoDirectiveSchema, candidate);
    if (parsed.success) {
        (cell as Any).infoDirective = parsed.data;
        if (!isSqlInfoDirectiveSupplier(cell)) {
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
            provenance: nb.notebook.provenance,
            startLine: cell.startLine,
            endLine: cell.endLine,
        });
    }
};
