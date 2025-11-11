/**
 * @module MDQL
 * @file mdql.ts
 *
 * @overview
 * Markdown Query Language (**MDQL**) is a CSS-selector-like syntax for querying
 * Markdown Abstract Syntax Trees (MDAST) produced by **remark** or compatible
 * parsers. It allows developers to write familiar selector expressions such as:
 *
 * ```text
 * heading[level=2] > code[lang="sql"]:fence()
 * h2:contains('API')::section code:fence('sql')
 * heading:has(+ code[lang='ts'])
 * code[pi.count>=2][attrs.schema='public']::pi
 * ```
 *
 * and receive a type-safe **AST** representation that can later be compiled into
 * executable functions to traverse and filter an actual MDAST tree.
 *
 * ---
 *
 * ### Design
 *
 * The parser converts an MDQL query string into an **MDQL AST**, a lightweight
 * tree of TypeScript algebraic types and discriminated unions representing:
 *
 * - **Simple selectors** (type, id, class, attribute, pseudo-classes)
 * - **Combinators** (`>`, `+`, `~`, descendant)
 * - **Compound and complex selectors**
 * - **Pseudo-elements** (`::section`, `::text`, etc.)
 *
 * It is intentionally modeled after the CSS Selectors Level 4 grammar, with
 * Markdown-specific extensions for attributes (e.g., `[depth=2]`,
 * `[lang^='p']`), pseudo-functions (`:contains('text')`, `:fence('sql')`,
 * `:has(...)` with relative lists), and Markdown section access (`::section`).
 *
 * ---
 *
 * ### Usage
 *
 * ```ts
 * import { parseMDQL } from "./mdql.ts";
 *
 * const result = parseMDQL("code:fence('sql')[pi.count>=2][attrs.schema='public']::pi");
 * if (result.ok) {
 *   const sel = result.value.items[0];
 *   console.log(sel.pseudoElement); // "pi"
 * }
 * ```
 *
 * The accompanying **`mdql_test.ts`** file contains a comprehensive suite of
 * Deno tests demonstrating practical usage, complex selectors, pseudo-functions,
 * relative selectors in `:has()`, attribute operators, and error handling.
 *
 * @remarks
 * This file is parser-only; code that actually evaluates or matches selectors
 * against a real MDAST tree is implemented separately in `mdql-mdast.ts`.
 */

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type Result<Ok, Err> =
  | { ok: true; value: Ok }
  | { ok: false; error: Err };

export interface SourceLoc {
  readonly index: number; // absolute offset
  readonly line: number;
  readonly col: number;
}
export type Located<T> = T & { loc?: SourceLoc };

// Narrow mdast types (kept open)
export type MdastType =
  | "root"
  | "paragraph"
  | "heading"
  | "thematicBreak"
  | "blockquote"
  | "list"
  | "listItem"
  | "table"
  | "tableRow"
  | "tableCell"
  | "inlineCode"
  | "code"
  | "html"
  | "emphasis"
  | "strong"
  | "delete"
  | "link"
  | "image"
  | "break"
  | "text"
  | "yaml"
  | "toml"
  | string;

export type AttrOp = "=" | "~=" | "^=" | "$=" | "*=" | "!=" | ">=" | "<=";
export type MDQLScalar = string | number | boolean;
export interface NumericRange {
  kind: "range";
  from: number;
  to: number;
}
export type MDQLValue = MDQLScalar | NumericRange;

export type AttrName =
  | "type"
  | "value"
  | "lang"
  | "meta"
  | "depth"
  | "ordered"
  | "spread"
  | "checked"
  | "file"
  | "dir"
  | "ext"
  | "id"
  | "text"
  | "startLine"
  | "endLine"
  | "startCol"
  | "endCol"
  | `yaml.${string}`
  | `toml.${string}`
  | `frontmatter.${string}`
  // New dotted-name namespaces for code fences with PI & ATTRS
  | `pi.${string}` // e.g., pi.count, pi.pos0, pi.flags.F, pi.args
  | `attrs.${string}` // e.g., attrs.schema, attrs.db.host, attrs.tags
  | string;

// ── AST nodes ───────────────────────────────────────────────────────────────

export type SimpleSelector =
  | Located<TypeSelector>
  | Located<UniversalSelector>
  | Located<IdSelector>
  | Located<ClassSelector>
  | Located<AttributeSelector>
  | Located<PseudoBare>
  | Located<PseudoFunc>;

export interface TypeSelector {
  kind: "Type";
  name: MdastType;
}
export interface UniversalSelector {
  kind: "Universal";
}
export interface IdSelector {
  kind: "Id";
  value: string;
}
export interface ClassSelector {
  kind: "Class";
  name: string;
}
export interface AttributeSelector {
  kind: "Attr";
  name: AttrName;
  op?: AttrOp;
  value?: MDQLValue;
}

export interface PseudoBare {
  kind: "PseudoBare";
  name:
    | "empty"
    | "leaf"
    | "first-child"
    | "last-child"
    | "only-child"
    | "task"
    | "external"
    | "section";
}
export interface PseudoFunc {
  kind: "PseudoFunc";
  name:
    | "contains"
    | "matches"
    | "line"
    | "lines"
    | "file"
    | "in-dir"
    | "ext"
    | "frontmatter"
    | "fence"
    | "has"
    | "not"
    | "is"
    | "where"
    | "nth-child"
    | "nth-of-type"
    // New pseudos for PI/ATTRS sugar (parser-only; evaluation later)
    | "pi" // :pi('--flag') or :pi('--env','prod')   (evaluates to checks over pi.*)
    | "argv" // :argv(0,'deploy') or :argv('deploy')   (maps to pi.pos0 / pi.args)
    | "argc" // :argc(3) or :argc(2..5)                (maps to pi.count comparisons)
    | "attr"; // :attr('schema','public')               (maps to attrs.schema='public')
  args: readonly (MDQLValue | SelectorList)[];
}

export type Combinator = "descendant" | "child" | "adjacent" | "sibling";

export interface CompoundSelector {
  kind: "Compound";
  parts: NonEmptyArray<SimpleSelector>;
}
export interface ComplexSelector {
  kind: "Complex";
  head: CompoundSelector;
  tails: readonly { combinator: Combinator; right: CompoundSelector }[];
}
export type PseudoElementName =
  | "text"
  | "content"
  | "section"
  | "slug"
  // New pseudo-elements for extracting sub-parts (parser-only)
  | "pi"
  | "attrs"
  | "argv";

export interface Selector {
  kind: "Selector";
  core: ComplexSelector;
  pseudoElement?: PseudoElementName;
}
export interface SelectorList {
  kind: "SelectorList";
  items: NonEmptyArray<Selector>;
}

export interface ParseError {
  message: string;
  loc?: SourceLoc;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type TokKind =
  | "ident"
  | "hash"
  | "dot"
  | "star"
  | "lbrack"
  | "rbrack"
  | "colon"
  | "dcolon"
  | "lparen"
  | "rparen"
  | "comma"
  | "gt"
  | "plus"
  | "tilde"
  | "string"
  | "number"
  | "op"
  | "range"
  | "ws"
  | "eof";

interface Token {
  kind: TokKind;
  value?: string;
  loc: SourceLoc;
}

export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, col = 1;
  const loc = (): SourceLoc => ({ index: i, line, col });
  const peek = () => input[i] ?? "";
  const take = () => {
    const ch = input[i++] ?? "";
    if (ch === "\n") {
      line++;
      col = 1;
    } else col++;
    return ch;
  };
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_\-]/.test(c);

  while (i < input.length) {
    const c = peek();

    // whitespace
    if (/\s/.test(c)) {
      const start = loc();
      while (/\s/.test(peek())) take();
      out.push({ kind: "ws", loc: start });
      continue;
    }

    // two-char attribute operators: ^=, $=, ~=, !=, >=, <=, *=
    if (
      (c === "^" || c === "$" || c === "~" || c === "!" || c === ">" ||
        c === "<" || c === "*") && input[i + 1] === "="
    ) {
      const start = loc();
      const first = take(); // ^ $ ~ ! > < *
      take(); // =
      out.push({ kind: "op", value: first + "=", loc: start });
      continue;
    }

    // single-char tokens / combinators
    if (c === "#") {
      out.push({ kind: "hash", loc: loc() });
      take();
      continue;
    }
    if (c === ".") {
      out.push({ kind: "dot", loc: loc() });
      take();
      continue;
    }
    if (c === "*") {
      out.push({ kind: "star", loc: loc() });
      take();
      continue;
    }
    if (c === "[") {
      out.push({ kind: "lbrack", loc: loc() });
      take();
      continue;
    }
    if (c === "]") {
      out.push({ kind: "rbrack", loc: loc() });
      take();
      continue;
    }
    if (c === ":") {
      const start = loc();
      take();
      if (peek() === "::") {
        // handled by seeing a second ':'
      }
      if (peek() === ":") {
        take();
        out.push({ kind: "dcolon", loc: start });
      } else out.push({ kind: "colon", loc: start });
      continue;
    }
    if (c === "(") {
      out.push({ kind: "lparen", loc: loc() });
      take();
      continue;
    }
    if (c === ")") {
      out.push({ kind: "rparen", loc: loc() });
      take();
      continue;
    }
    if (c === ",") {
      out.push({ kind: "comma", loc: loc() });
      take();
      continue;
    }
    if (c === ">") {
      out.push({ kind: "gt", loc: loc() });
      take();
      continue;
    }
    if (c === "+") {
      out.push({ kind: "plus", loc: loc() });
      take();
      continue;
    }
    if (c === "~") {
      out.push({ kind: "tilde", loc: loc() });
      take();
      continue;
    }

    // strings
    if (c === '"' || c === "'") {
      const quote = take();
      const start = loc();
      let s = "";
      while (i < input.length && peek() !== quote) s += take();
      if (peek() === quote) take();
      out.push({ kind: "string", value: s, loc: start });
      continue;
    }

    // numbers / ranges
    if (/[0-9]/.test(c)) {
      const start = loc();
      let s = "";
      while (/[0-9]/.test(peek())) s += take();
      // ✅ correct two-dot detection
      if (peek() === "." && input[i + 1] === ".") {
        take(); // '.'
        take(); // '.'
        let t = "";
        while (/[0-9]/.test(peek())) t += take();
        out.push({ kind: "range", value: `${s}..${t}`, loc: start });
      } else {
        out.push({ kind: "number", value: s, loc: start });
      }
      continue;
    }

    // identifiers / fallback '=' op
    if (isIdentStart(c)) {
      const start = loc();
      let s = take();
      while (isIdent(peek())) s += take();
      if (s === "=") {
        out.push({ kind: "op", value: s, loc: start });
      } else {
        out.push({ kind: "ident", value: s, loc: start });
      }
      continue;
    }
    if (c === "=") {
      out.push({ kind: "op", value: "=", loc: loc() });
      take();
      continue;
    }

    throw new Error(`Unexpected character '${c}' at ${line}:${col}`);
  }
  out.push({ kind: "eof", loc: { index: i, line, col } });
  return out;
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseMDQL(input: string): Result<SelectorList, ParseError[]> {
  const toks = tokenize(input);
  let k = 0;
  const cur = () => toks[Math.min(k, toks.length - 1)];
  const nxt = () => toks[++k];

  const errors: ParseError[] = [];

  function consume(kind?: TokKind): Token {
    const t = cur();
    if (kind && t.kind !== kind) {
      errors.push({ message: `Expected ${kind} got ${t.kind}`, loc: t.loc });
    }
    k++;
    return t;
  }
  function _opt(kind: TokKind): Token | undefined {
    if (cur().kind === kind) {
      const t = cur();
      nxt();
      return t;
    }
  }
  function skipWS() {
    while (cur().kind === "ws") nxt();
  }
  function withLoc<T>(node: T, t: Token): Located<T> {
    // deno-lint-ignore no-explicit-any
    return Object.assign(node as any, { loc: t.loc });
  }

  // Helper to know what starts a simple selector
  const beginsSimple = (kkind: TokKind): boolean =>
    kkind === "ident" || kkind === "star" || kkind === "hash" ||
    kkind === "dot" || kkind === "lbrack" || kkind === "colon";

  // SelectorList with optional relative mode (for :has(...) etc.)
  function parseSelectorList(allowRelative = false): SelectorList {
    const head = allowRelative && startsRelative()
      ? parseRelativeSelector()
      : parseSelector();
    skipWS();
    const rest: Selector[] = [];
    while (cur().kind === "comma") {
      nxt();
      skipWS();
      const item = allowRelative && startsRelative()
        ? parseRelativeSelector()
        : parseSelector();
      rest.push(item);
      skipWS();
    }
    const items: NonEmptyArray<Selector> = [head, ...rest];
    return { kind: "SelectorList", items };
  }

  // Does the upcoming tokens look like a relative selector?
  function startsRelative(): boolean {
    // Case 1: descendant via leading whitespace
    if (cur().kind === "ws") {
      const saved = k;
      skipWS();
      const kkind = cur().kind;
      // ✅ allow either a simple selector OR a combinator after leading ws
      const ok = beginsSimple(kkind) || kkind === "gt" || kkind === "plus" ||
        kkind === "tilde";
      k = saved;
      return ok;
    }

    // Case 2: explicit combinator ('>', '+', '~') optionally followed by whitespace, then a simple selector
    if (
      cur().kind === "gt" || cur().kind === "plus" || cur().kind === "tilde"
    ) {
      const saved = k;
      nxt();
      skipWS();
      const ok = beginsSimple(cur().kind);
      k = saved;
      return ok;
    }

    return false;
  }

  function parseRelativeSelector(): Selector {
    // Implicit Universal head
    const head: CompoundSelector = {
      kind: "Compound",
      parts: [{ kind: "Universal" }] as NonEmptyArray<SimpleSelector>,
    };

    // Determine first combinator: explicit (+, >, ~) or descendant (ws)
    let comb: Combinator | undefined;

    if (cur().kind === "ws") {
      // previously: skipWS(); comb = "descendant";
      skipWS();
      // ✅ If a combinator immediately follows the leading whitespace, use it.
      if (
        cur().kind === "gt" || cur().kind === "plus" || cur().kind === "tilde"
      ) {
        if (cur().kind === "gt") comb = "child";
        else if (cur().kind === "plus") comb = "adjacent";
        else comb = "sibling";
        nxt(); // consume the combinator token
      } else {
        comb = "descendant";
      }
    } else if (cur().kind === "gt") {
      nxt();
      comb = "child";
    } else if (cur().kind === "plus") {
      nxt();
      comb = "adjacent";
    } else if (cur().kind === "tilde") {
      nxt();
      comb = "sibling";
    }

    // consume any whitespace between the combinator and the right side
    skipWS();

    // Right-hand compound must follow
    const right = parseCompound();
    const tails = [{ combinator: (comb ?? "descendant") as Combinator, right }];

    // Allow more tails after that
    const more = parseTails();
    const allTails = [...tails, ...more] as const;

    return {
      kind: "Selector",
      core: { kind: "Complex", head, tails: allTails },
    };
  }

  function parseSelector(): Selector {
    let core = parseComplex();

    // do NOT skip here; we need to see ws to infer descendant after a pseudo-element
    let pseudoElement: PseudoElementName | undefined;
    if (cur().kind === "dcolon") {
      nxt();
      const name = consume("ident").value as PseudoElementName;
      pseudoElement = name;
      const extra = parseTails();
      if (extra.length) {
        core = { ...core, tails: [...core.tails, ...extra] };
      }
    }

    return { kind: "Selector", core, pseudoElement };
  }

  function parseComplex(): ComplexSelector {
    const head = parseCompound();
    const tails = parseTails();
    return { kind: "Complex", head, tails };
  }

  // parse combinator tails (used in complex and after ::pseudo-element)
  function parseTails(): { combinator: Combinator; right: CompoundSelector }[] {
    const tails: { combinator: Combinator; right: CompoundSelector }[] = [];
    for (;;) {
      let comb: Combinator | undefined;

      if (cur().kind === "gt") {
        comb = "child";
        nxt();
      } else if (cur().kind === "plus") {
        comb = "adjacent";
        nxt();
      } else if (cur().kind === "tilde") {
        comb = "sibling";
        nxt();
      } else if (cur().kind === "ws") {
        // ws ⇒ descendant IF next token begins a simple selector
        skipWS();
        const kkind = cur().kind;
        if (beginsSimple(kkind)) {
          comb = "descendant";
        } else {
          continue; // ignore stray spacing
        }
      } else break;

      skipWS();
      const right = parseCompound();
      skipWS();
      tails.push({ combinator: comb!, right });
    }
    return tails;
  }

  function parseOneSimple(): SimpleSelector | undefined {
    const t = cur();
    if (t.kind === "ident") {
      nxt();
      return withLoc({ kind: "Type", name: t.value as MdastType }, t);
    }
    if (t.kind === "star") {
      nxt();
      return withLoc({ kind: "Universal" }, t);
    }
    if (t.kind === "hash") {
      const h = t;
      nxt();
      const id = consume("ident");
      return withLoc({ kind: "Id", value: id.value! }, h);
    }
    if (t.kind === "dot") {
      const d = t;
      nxt();
      const c = consume("ident");
      return withLoc({ kind: "Class", name: c.value! }, d);
    }
    if (t.kind === "lbrack") return parseAttr();
    if (t.kind === "colon") return parsePseudo();
    return undefined;
  }

  function parseCompound(): CompoundSelector {
    const first = parseOneSimple();
    if (!first) {
      errors.push({
        message:
          "Expected a simple selector (type, *, #id, .class, [attr], :pseudo)",
        loc: cur().loc,
      });
      const fake: Located<UniversalSelector> = {
        kind: "Universal",
        loc: cur().loc,
      };
      return { kind: "Compound", parts: [fake] };
    }
    const rest: SimpleSelector[] = [];
    for (;;) {
      const s = parseOneSimple();
      if (!s) break;
      rest.push(s);
    }
    const parts: NonEmptyArray<SimpleSelector> = [first, ...rest];
    return { kind: "Compound", parts };
  }

  // Parse a dotted attribute name: ident ( "." ident )*
  function parseDottedAttrName(): string {
    const first = consume("ident").value!;
    let name = first;
    while (cur().kind === "dot") {
      nxt(); // consume '.'
      const nextIdent = consume("ident").value!;
      name += "." + nextIdent;
    }
    return name;
  }

  function parseAttr(): Located<AttributeSelector> {
    const l = consume("lbrack");
    skipWS();
    // support dotted names like pi.count, attrs.db.host, yaml.meta.version
    const name = parseDottedAttrName() as AttrName;
    skipWS();
    let op: AttrOp | undefined;
    let value: MDQLValue | undefined;
    if (cur().kind === "op") {
      op = cur().value as AttrOp;
      nxt();
      skipWS();
      if (cur().kind === "string") {
        value = cur().value!;
        nxt();
      } else if (cur().kind === "number") {
        value = Number(cur().value);
        nxt();
      } else if (cur().kind === "ident") {
        const v = cur().value!;
        if (v === "true" || v === "false") value = v === "true";
        else value = v;
        nxt();
      } else if (cur().kind === "range") {
        const [a, b] = (cur().value!).split("..");
        value = { kind: "range", from: Number(a), to: Number(b) };
        nxt();
      } else {
        errors.push({ message: "Invalid attribute value", loc: cur().loc });
      }
      skipWS();
    }
    consume("rbrack");
    return withLoc({ kind: "Attr", name, op, value }, l);
  }

  function parsePseudo(): Located<PseudoBare | PseudoFunc> {
    const c = consume("colon");
    const nameTok = consume("ident");
    const name = nameTok.value!;
    if (cur().kind === "lparen") {
      nxt();
      const args: (MDQLValue | SelectorList)[] = [];

      if (cur().kind !== "rparen") {
        for (;;) {
          // ✅ accept primitives … or a selector list (relative allowed for :has)
          if (cur().kind === "string") {
            args.push(cur().value!);
            nxt();
          } else if (cur().kind === "number") {
            args.push(Number(cur().value));
            nxt();
          } else if (cur().kind === "range") {
            const [a, b] = (cur().value!).split("..");
            args.push({ kind: "range", from: Number(a), to: Number(b) });
            nxt();
          } else {
            const allowRelative = name === "has";
            args.push(parseSelectorList(allowRelative));
          }
          // ✅ comma-separated argument list
          if (cur().kind === "comma") {
            nxt();
            skipWS();
            continue;
          }
          break;
        }
      }

      consume("rparen");
      // deno-lint-ignore no-explicit-any
      return withLoc({ kind: "PseudoFunc", name: name as any, args }, c);
    }
    // deno-lint-ignore no-explicit-any
    return withLoc({ kind: "PseudoBare", name: name as any }, c);
  }

  // Top-level: build NonEmptyArray via head + rest
  const head = parseSelector();
  skipWS();
  const rest: Selector[] = [];
  while (cur().kind === "comma") {
    nxt();
    skipWS();
    rest.push(parseSelector());
    skipWS();
  }
  if (errors.length) return { ok: false, error: errors };
  const items: NonEmptyArray<Selector> = [head, ...rest];
  return { ok: true, value: { kind: "SelectorList", items } };
}
