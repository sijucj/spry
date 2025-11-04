/**
 * CQL-mini — CodeCell filter compiler for Spry notebooks.
 *
 * This module compiles a tiny, CodeCell-specific predicate DSL (CQL-mini) into a
 * type-safe filter function over `CodeCell[]`. It’s intentionally minimal:
 *  - Only a single boolean expression (no SELECT, ORDER, LIMIT).
 *  - Compiles to `cells.filter(c => /* predicate *\/)`.
 *  - Targets the fields that actually exist on CodeCell in notebook.ts.
 *
 * Field aliases (DSL → CodeCell)
 *  - lang      → c.language
 *  - text      → c.source
 *  - path      → c.provenance.path
 *  - filename  → c.provenance.filename || basename(c.provenance.path)
 *  - tags      → c.tags || c.attrs.tags  (array)
 *  - flags     → c.parsedPI.flags        (record)
 *  - pi.kind   → c.parsedPI.kind ?? c.parsedPI.firstToken
 *  - Any other dotted path resolves from c.* with optional indexing (e.g., attrs.env, attrs.arr[0]).
 *
 * Grammar (informal)
 *    expr  := expr "&&" expr | expr "||" expr | "!" expr | "(" expr ")" | term
 *    term  := field ":" string                     // string equality (=== on String(field))
 *           | field "~" string                     // substring on String(field)
 *           | field "~" /regex/flags               // regex test against String(field)
 *           | path  "~" glob("**\/*.sql")           // glob match on String(path)
 *           | tag("x")                             // tags.includes("x")
 *           | flag("capture")                      // flags["capture"] === true
 *           | attr("env") == "prod"                // String(attrs["env"]) === "prod"
 *           | has(pi.kind)                         // existence check for the *value*
 *           | len(tags) > 0                        // length of array/string value
 *
 * Operators
 *  - Boolean: &&  ||  !
 *  - Comparisons: ==  !=  <  <=  >  >=
 *  - String equality sugar: ":"  (String(lhs) === rhs)
 *  - Substring: "~" with a string RHS (String(lhs).includes(rhs))
 *  - Regex test: "~" with a regex RHS (/.../flags.test(String(lhs)))
 *
 * Helpers
 *  - glob("pattern") within `path ~ glob("...")`; supports **, *, ?
 *  - tag("t")  → Array.isArray(tags) && tags.includes("t")
 *  - flag("k") → parsedPI.flags[k] === true
 *  - attr("k") → String(attrs[k])  (or use attr("k","v") for equality)
 *  - has(valueExpr) → valueExpr !== undefined && valueExpr !== null
 *  - len(valueExpr) → length of array/string, else 0
 *
 * Examples
 *  - SQL migrations that contain CREATE TABLE (glob + regex):
 *      lang:"sql" && path~glob("**\/migrations/*.sql") && text~/CREATE\s+TABLE/i
 *
 *  - Example cells that also have capture flag:
 *      tag("example") && flag("capture")
 *
 *  - Virtual PI, excluding drafts by filename:
 *      has(pi.kind) && pi.kind:"virtual" && !(filename~".draft.")
 *
 * API
 *  - compileCqlMini(query: string): (cells: CodeCell[]) => CodeCell[]
 *      Compiles once, then reuse the returned function to filter any CodeCell array.
 *      Throws on syntax errors; otherwise evaluates missing paths to undefined.
 *
 * Path resolution rules
 *  - Dotted paths and numeric indices are allowed (e.g., attrs.meta.owner, attrs.arr[1]).
 *  - Missing segments return undefined; use has(...) to test existence safely.
 *
 * Security notes
 *  - The compiler uses a hand-rolled tokenizer + Pratt parser and emits a predicate
 *    that’s executed via `new Function`. The DSL does not allow arbitrary JS and only
 *    emits known helpers and field accessors, but you should still treat the query
 *    string as untrusted input and avoid granting unnecessary capabilities to the
 *    environment where it runs.
 *
 * Performance notes
 *  - Compile once per distinct query and reuse the returned function. Predicate
 *    execution is a pure array filter and is allocation-light.
 */

import * as nb from "./notebook.ts";

// deno-lint-ignore no-explicit-any
type CodeCell = nb.CodeCell<any>;

// ---------- Small runtime helpers used by emitted predicates ----------
type AnyRec = Record<string, unknown>;
const asRec = (x: unknown): AnyRec => (x as AnyRec) ?? {};

function escapeReChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Minimal glob translator supporting:
 *  - `**` → `.*`
 *  - `*`  → `[^/]*`
 *  - `?`  → `[^/]`
 * Everything else is regex-escaped verbatim.
 */
function GLOB(pat: string): RegExp {
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeReChar(ch);
    }
  }
  re += "$";
  return new RegExp(re);
}

function toStr(x: unknown): string {
  return String(x ?? "");
}

function basename(p?: unknown): string {
  const s = String(p ?? "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

// Resolve dotted/ indexed paths with CodeCell-aware aliases.
// Supports: a.b.c and arr[0]; returns undefined if missing.
function getPath(c: CodeCell, path: string): unknown {
  // Aliases demanded by the DSL
  if (path === "lang") return (c as unknown as AnyRec)["language"];
  if (path === "text") return (c as unknown as AnyRec)["source"];
  if (path === "path") return asRec(c.provenance)["path"];
  if (path === "filename") {
    const pv = asRec(c.provenance);
    return (pv["filename"] as unknown) ?? basename(pv["path"]);
  }
  if (path === "tags") {
    // Prefer direct tags if present, else attrs.tags
    const direct = (c as unknown as AnyRec)["tags"];
    if (Array.isArray(direct)) return direct;
    const fromAttrs = asRec(c.attrs)["tags"];
    return Array.isArray(fromAttrs) ? fromAttrs : undefined;
  }
  if (path === "flags") {
    const pi = asRec((c as unknown as AnyRec)["parsedPI"]);
    return asRec(pi["flags"]);
  }
  if (path.startsWith("pi.")) {
    const rest = path.slice(3);
    const pi = asRec((c as unknown as AnyRec)["parsedPI"]);
    if (rest === "kind") {
      const k = pi["kind"];
      const first = pi["firstToken"];
      return (k ?? first) as unknown;
    }
    return rest ? asRec(pi)[rest] : pi;
  }

  // Generic dotted + indexed path from c.*
  let cur: unknown = c;
  const parts = path.split(".").flatMap((p) => {
    const segs: string[] = [];
    let m: RegExpExecArray | null;
    const rx = /([^[\]]+)|\[(\d+)\]/g;
    while ((m = rx.exec(p))) segs.push(m[1] ?? m[2]);
    return segs;
  });

  for (const key of parts) {
    if (cur == null) return undefined;
    if (/^\d+$/.test(key)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(key)];
    } else {
      const rec = asRec(cur);
      cur = rec[key];
    }
  }
  return cur;
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function LEN(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  return 0;
}

function tagHas(c: CodeCell, t: string): boolean {
  const tags = getPath(c, "tags");
  return Array.isArray(tags) ? tags.includes(t) : false;
}

function flagTrue(c: CodeCell, f: string): boolean {
  const pi = asRec((c as unknown as AnyRec)["parsedPI"]);
  const flags = asRec(pi["flags"]);
  return flags?.[f] === true;
}

function attrEq(c: CodeCell, k: string, val: unknown): boolean {
  const a = asRec(c.attrs);
  return String(a?.[k]) === String(val);
}

function attrStr(c: CodeCell, k: string): string {
  const a = asRec(c.attrs);
  return String(a?.[k]);
}

// ---------- Tokenizer ----------
type Tok =
  | { kind: "id"; v: string }
  | { kind: "num"; v: string }
  | { kind: "str"; v: string }
  | { kind: "re"; source: string; flags: string }
  | { kind: "op"; v: string } // && || ! == != <= >= < > : ~ ( ) ,
  | { kind: "eof" };

const OPS = new Set([
  "&&",
  "||",
  "!",
  "==",
  "!=",
  ">=",
  "<=",
  "<",
  ">",
  ":",
  "~",
  "(",
  ")",
  ",",
]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  const isWS = (c: string) => /\s/.test(c);
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9._]/.test(c);

  while (i < src.length) {
    const ch = src[i];

    if (isWS(ch)) {
      i++;
      continue;
    }

    // String: "..."
    if (ch === '"') {
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          s += src[i];
          i++;
          if (i < src.length) s += src[i++];
        } else s += src[i++];
      }
      if (src[i] !== '"') throw new Error("Unterminated string");
      i++;
      out.push({ kind: "str", v: s });
      continue;
    }

    // Regex: /.../flags
    if (ch === "/") {
      i++;
      let body = "";
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") {
          body += src[i];
          i++;
          if (i < src.length) body += src[i++];
        } else body += src[i++];
      }
      if (src[i] !== "/") throw new Error("Unterminated regex");
      i++; // consume trailing /
      let flags = "";
      while (i < src.length && /[a-z]/i.test(src[i])) flags += src[i++];

      out.push({ kind: "re", source: body, flags });
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      let n = ch;
      i++;
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      out.push({ kind: "num", v: n });
      continue;
    }

    // Ident
    if (isIdStart(ch)) {
      let id = ch;
      i++;
      while (i < src.length && isId(src[i])) id += src[i++];
      out.push({ kind: "id", v: id });
      continue;
    }

    // Operators/punct (max munch)
    const two = src.slice(i, i + 2);
    const one = src.slice(i, i + 1);
    if (OPS.has(two)) {
      out.push({ kind: "op", v: two });
      i += 2;
      continue;
    }
    if (OPS.has(one)) {
      out.push({ kind: "op", v: one });
      i += 1;
      continue;
    }

    throw new Error(`Unexpected character: '${ch}'`);
  }

  out.push({ kind: "eof" });
  return out;
}

// ---------- Pratt parser that EMITS JS predicate snippets ----------
class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private eat(): Tok {
    return this.toks[this.i++];
  }
  private want(kind: Tok["kind"], v?: string): Tok {
    const t = this.peek();
    if (t.kind !== kind || (v && (t as { v?: string }).v !== v)) {
      throw new Error(`Expected ${kind}${v ? " '" + v + "'" : ""}`);
    }
    return this.eat();
  }

  // precedence: ! > comparisons/substring > && > ||
  private lbp(op?: string): number {
    switch (op) {
      case "||":
        return 1;
      case "&&":
        return 2;
      case "==":
      case "!=":
      case ":":
      case "<":
      case "<=":
      case ">":
      case ">=":
      case "~":
        return 3;
      default:
        return 0;
    }
  }

  parse(): string {
    const expr = this.parseExpr(0);
    this.want("eof");
    return expr;
  }

  private parseExpr(rbp: number): string {
    let left = this.nud();
    while (true) {
      const t = this.peek();
      if (t.kind !== "op") break;
      const lbp = this.lbp(t.v);
      if (lbp <= rbp) break;
      const op = this.eat() as { kind: "op"; v: string };
      left = this.led(op.v, left, lbp);
    }
    return left;
  }

  private nud(): string {
    const t = this.eat();

    // unary NOT
    if (t.kind === "op" && t.v === "!") {
      const r = this.parseExpr(9);
      return `(!(${r}))`;
    }

    // group
    if (t.kind === "op" && t.v === "(") {
      const e = this.parseExpr(0);
      this.want("op", ")");
      return `(${e})`;
    }

    if (t.kind === "id") {
      // function-like helpers
      if (t.v === "tag") return this.parseCall("tag");
      if (t.v === "flag") return this.parseCall("flag");
      if (t.v === "attr") return this.parseCall("attr");
      if (t.v === "has") return this.parseCall("has");
      if (t.v === "len") return this.parseCall("len");
      if (t.v === "glob") {
        throw new Error('glob(...) only allowed as path~glob("pattern")');
      }

      // a bare identifier is a field path (e.g., lang, text, filename, pi.kind, attrs.foo)
      return this.emitField(t.v);
    }

    if (t.kind === "str") return JSON.stringify(t.v);
    if (t.kind === "num") return t.v;
    if (t.kind === "re") return `/${t.source}/${t.flags}`;

    throw new Error("Unexpected token in expression");
  }

  // inside class Parser
  private led(op: string, left: string, lbp: number): string {
    if (op === "&&" || op === "||") {
      const right = this.parseExpr(lbp);
      return `(${left} ${op} ${right})`;
    }

    if (
      op === ":" || op === "==" || op === "!=" || op === "<" || op === "<=" ||
      op === ">" || op === ">=" || op === "~"
    ) {
      const right = this.parseExpr(lbp);

      if (op === ":") return `(String(${left}) === ${right})`;

      if (op === "~") {
        // Regex RHS: e.g., text~/CREATE\s+TABLE/i
        if (right.startsWith("/")) {
          return `(${right}.test(toStr(${left})))`;
        }
        // Special-case path~glob("...") — RHS token rewritten to "glob:pattern"
        if (/^GET\(/.test(left) && right.startsWith('"glob:')) {
          const pat = JSON.parse(right).slice(5); // strip 'glob:'
          return `(GLOB(${JSON.stringify(pat)}).test(toStr(${left})))`;
        }
        // Default: substring
        return `(toStr(${left}).includes(${right}))`;
      }

      if (op === "==") return `(${left} === ${right})`;
      if (op === "!=") return `(${left} !== ${right})`;
      return `(${left} ${op} ${right})`;
    }

    throw new Error(`Unexpected operator ${op}`);
  }

  private parseCall(name: "tag" | "flag" | "attr" | "has" | "len"): string {
    this.want("op", "(");
    const a1 = this.nud(); // usually GET("...") or a literal
    let a2: string | undefined;

    const maybeComma = this.peek();
    if (maybeComma.kind === "op" && maybeComma.v === ",") {
      this.eat();
      a2 = this.nud();
    }

    this.want("op", ")");

    if (name === "tag") return `(tagHas(c, ${a1}))`;
    if (name === "flag") return `(flagTrue(c, ${a1}))`;

    if (name === "has") {
      // Existence of VALUE (not path): works for has(pi.kind) and has("pi.kind")
      return `(( ${a1} ) !== undefined && ( ${a1} ) !== null)`;
    }

    if (name === "len") {
      // Length of VALUE (array/string): len(tags), len(attr("x")), etc.
      return `(LEN(${a1}))`;
    }

    if (name === "attr") {
      // Support both forms:
      //   attr("k") == "v"  (parser will compare returned string)
      //   attr("k","v")     (direct equality check)
      if (a2) return `(attrEq(c, ${a1}, ${a2}))`;
      return `(attrStr(c, ${a1}))`;
    }
    // exhaustive: no default branch
    throw new Error("unreachable");
  }

  private emitField(id: string): string {
    // pi.kind, attrs.env, etc.
    if (id === "glob") {
      throw new Error('glob(...) only allowed with path~glob("pattern")');
    }
    return `GET(${JSON.stringify(id)})`;
  }
}

/**
 * Compile a CQL-mini predicate into a reusable `CodeCell[]` filter.
 *
 * @param query CQL-mini string (see module docs for grammar, operators, helpers).
 * @returns A function that filters a `CodeCell[]` using the compiled predicate.
 *
 * @example
 * import { compileCqlMini } from "./cql.ts";
 *
 * const q = 'lang:"sql" && path~glob("**\/migrations/*.sql") && text~/CREATE\\s+TABLE/i';
 * const filterMigrations = compileCqlMini(q);
 * const results = filterMigrations(cells);
 *
 * @example
 * // Flags and tags:
 * const q = 'tag("example") && flag("capture")';
 * const onlyCapturedExamples = compileCqlMini(q);
 *
 * @example
 * // Attributes and PI:
 * const q = 'attr("env")=="prod" && pi.kind:"virtual"';
 * const prodVirtual = compileCqlMini(q);
 */
export function compileCqlMini(
  query: string,
): (cells: CodeCell[]) => CodeCell[] {
  const toks = tokenize(
    // Allow the sugar path~glob("..."): rewrite the RHS token to distinguish
    query.replace(
      /(~)\s*glob\(\s*"([^"]+)"\s*\)/g,
      (_m, _tilde, pat) => `~ "glob:${pat}"`,
    ),
  );
  const parser = new Parser(toks);
  const jsExpr = parser.parse();

  // Declare the exact signature we’ll pass at callsite
  type PredFn = (
    c: CodeCell,
    GET: (field: string) => unknown,
    toStrFn: (x: unknown) => string,
    GLOBfn: (p: string) => RegExp,
    basenameFn: (p?: unknown) => string,
    getPathFn: (c: CodeCell, path: string) => unknown,
    hasValueFn: (v: unknown) => boolean,
    LENfn: (v: unknown) => number,
    tagHasFn: (c: CodeCell, t: string) => boolean,
    flagTrueFn: (c: CodeCell, f: string) => boolean,
    attrEqFn: (c: CodeCell, k: string, v: unknown) => boolean,
    attrStrFn: (c: CodeCell, k: string) => string,
  ) => boolean;

  const pred = new Function(
    "c",
    "GET",
    "toStr",
    "GLOB",
    "basename",
    "getPath",
    "hasValue",
    "LEN",
    "tagHas",
    "flagTrue",
    "attrEq",
    "attrStr",
    `return (${jsExpr});`,
  ) as PredFn;

  return (cells: CodeCell[]) =>
    cells.filter((c) =>
      pred(
        c,
        (field: string) => getPath(c, field),
        toStr,
        GLOB,
        basename,
        getPath,
        hasValue,
        LEN,
        tagHas,
        flagTrue,
        attrEq,
        attrStr,
      )
    );
}
