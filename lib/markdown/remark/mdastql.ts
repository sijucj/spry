// lib/markdown/mdastql.ts

/**
 * @module mdastql
 *
 * @summary
 * A tiny, dependency-free query language for **mdast** trees.
 *
 * It provides a CSS-like selector syntax specialized for Markdown:
 *
 *   - Type selectors:           `heading`, `paragraph`, `code`, `*`
 *   - Heading aliases:          `h1`..`h6` → via rewrite hook (default rewriter)
 *   - Attribute filters:        `[depth=2]`, `[lang=sql]`,
 *                               `[data.frontmatter.id ~/ ^task-/]`
 *   - Combinators:
 *       - Descendant:           `A B`
 *       - Direct child:         `A > B`
 *       - Adjacent sibling:     `A + B`
 *
 * The engine runs purely on mdast:
 *
 *   mdast Root  +  query string  →  RootContent[]
 */

import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";

/** All mdast node.type values we care about. */
export type MdastNodeType = RootContent["type"];

/** Heading depth from mdast types (usually 1..6). */
export type HeadingDepth = Heading["depth"];

/**
 * Combinators supported by the query language.
 *
 * - "descendant": A B
 * - "child":      A > B
 * - "adjacent":   A + B
 */
export type MdastQlCombinator = "descendant" | "child" | "adjacent";

/**
 * Internal representation of attribute operators.
 *
 * - "eq":       =
 * - "ne":       !=
 * - "contains": ~=
 * - "gt":       >
 * - "lt":       <
 * - "regex":    ~/.../
 */
export type MdastQlAttrOperator =
  | "eq"
  | "ne"
  | "contains"
  | "gt"
  | "lt"
  | "regex";

/** Literal value supported in attribute filters. */
export type MdastQlLiteral = string | number | boolean;

/**
 * A single attribute filter like:
 *
 *   [data.frontmatter.id ~/ ^task-/]
 *   [lang=sql]
 */
export interface MdastQlAttributeFilter {
  readonly kind: "attribute";
  readonly path: readonly string[]; // e.g. ["data", "frontmatter", "id"]
  readonly op: MdastQlAttrOperator;
  readonly value: MdastQlLiteral;
  readonly regex?: RegExp;
}

/**
 * Selector "type" in the AST.
 *
 * - mdast node.type values (e.g. "heading", "paragraph", "code")
 * - "*" for wildcard
 * - or arbitrary user-defined identifiers (for aliasing via rewrite hooks)
 */
export type MdastQlSelectorType = MdastNodeType | "*" | string;

/**
 * A "simple selector" is:
 *
 *   typeOrAlias [attr] [attr] ...
 *
 * Examples:
 *   heading[depth=2]
 *   code[lang=sql][data.ec.attrs.CELL="TEST"]
 *   *[data.tag=important]
 *   h2[data.foo=true]       // h2 handled by a rewrite hook
 */
export interface MdastQlSimpleSelector {
  readonly kind: "simple";
  readonly type?: MdastQlSelectorType;
  readonly attrs: readonly MdastQlAttributeFilter[];
}

/**
 * A compiled selector:
 *
 *   selectors:  [S0, S1, S2, ...]
 *   combinators:[   C0, C1, ...]  (length = selectors.length - 1)
 *
 * Interpreted left-to-right:
 *
 *   S0 C0 S1 C1 S2 ...
 */
export interface MdastQlCompiledSelector {
  readonly selectors: readonly MdastQlSimpleSelector[];
  readonly combinators: readonly MdastQlCombinator[];
}

/**
 * Internal state: parent & index for each node.
 */
interface ParentInfo {
  readonly parent: Root | RootContent | null;
  readonly index: number; // index in parent's children[]
}

/**
 * Public query result type: a flat list of RootContent nodes.
 */
export interface MdastQlResult {
  readonly nodes: readonly RootContent[];
}

/**
 * Rewrite function type. This is called after parsing and before evaluation.
 *
 * It allows you to:
 *   - implement aliases like h1..h6,
 *   - add domain-specific macros,
 *   - normalize selectors.
 */
export type MdastQlRewriteFn = (
  compiled: MdastQlCompiledSelector,
) => MdastQlCompiledSelector;

/**
 * Options for the main mdastql() entry point.
 */
export interface MdastQlOptions {
  /**
   * Optional AST-rewrite hook applied after parsing and after the built-in
   * default rewrite (which handles h1..h6).
   *
   * If provided, it receives the result of defaultMdastQlRewrite() and may
   * further transform it.
   */
  readonly rewrite?: MdastQlRewriteFn;
}

/**
 * Main entry point: query an mdast Root with a CSS-like selector.
 *
 * @example
 * const result = mdastql(root, "h2 code[lang=sql]");
 * console.log(result.nodes.length);
 */
export function mdastql(
  root: Root,
  query: string,
  options?: MdastQlOptions,
): MdastQlResult {
  const parsed = parseMdastQl(query);
  const base = defaultMdastQlRewrite(parsed);
  const compiled = typeof options?.rewrite === "function"
    ? options.rewrite(base)
    : base;

  const parentMap = buildParentIndex(root);
  const nodes = evaluateSelector(root, compiled, parentMap);
  return { nodes };
}

/**
 * Build a WeakMap of node → { parent, index } for all RootContent nodes.
 */
function buildParentIndex(root: Root): WeakMap<Root | RootContent, ParentInfo> {
  const map = new WeakMap<Root | RootContent, ParentInfo>();

  function visit(parent: Root | RootContent | null, children: RootContent[]) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      map.set(child, { parent, index: i });
      // Recurse if this node has children
      const anyChild = child as RootContent & { children?: RootContent[] };
      if (Array.isArray(anyChild.children)) {
        visit(child, anyChild.children);
      }
    }
  }

  visit(root, root.children);
  return map;
}

/**
 * Parse a selector string into a compiled representation.
 *
 * NOTE: the parser does **not** expand aliases (like h1..h6).
 *       Aliasing is handled in a separate rewrite phase.
 *
 * Throws Error on invalid syntax.
 */
export function parseMdastQl(query: string): MdastQlCompiledSelector {
  const src = query.trim();
  if (src.length === 0) {
    throw new Error("mdastql: query must not be empty");
  }

  const selectors: MdastQlSimpleSelector[] = [];
  const combinators: MdastQlCombinator[] = [];

  let i = 0;
  const len = src.length;
  let pendingCombinator: MdastQlCombinator = "descendant";

  const skipWhitespace = () => {
    while (i < len && /\s/.test(src[i]!)) i++;
  };

  const readIdentifier = (): string => {
    const start = i;
    if (!/[A-Za-z_*]/.test(src[i]!)) {
      throw new Error(`mdastql: expected identifier at offset ${i}`);
    }
    i++;
    while (i < len && /[\w-]/.test(src[i]!)) i++;
    return src.slice(start, i);
  };

  const readString = (): string => {
    const quote = src[i]!;
    if (quote !== '"' && quote !== "'") {
      throw new Error(`mdastql: expected string at offset ${i}`);
    }
    i++; // skip quote
    let result = "";
    while (i < len && src[i] !== quote) {
      const ch = src[i]!;
      if (ch === "\\") {
        // simple escape
        const next = src[i + 1];
        if (next == null) break;
        result += next;
        i += 2;
        continue;
      }
      result += ch;
      i++;
    }
    if (src[i] !== quote) {
      throw new Error(`mdastql: unterminated string at offset ${i}`);
    }
    i++; // skip closing
    return result;
  };

  const readNumberOrIdent = (): MdastQlLiteral => {
    // Try number
    if (/[+-]?\d/.test(src[i]!)) {
      let j = i;
      if (src[j] === "+" || src[j] === "-") j++;
      while (j < len && /\d/.test(src[j]!)) j++;
      if (src[j] === ".") {
        j++;
        while (j < len && /\d/.test(src[j]!)) j++;
      }
      const raw = src.slice(i, j);
      const num = Number(raw);
      if (!Number.isNaN(num)) {
        i = j;
        return num;
      }
    }

    // Fallback: identifier as string or boolean
    const ident = readIdentifier();
    if (ident === "true") return true;
    if (ident === "false") return false;
    return ident;
  };

  const readRegex = (): RegExp => {
    // We have already consumed "~" and are sitting on "/"
    if (src[i] !== "/") {
      throw new Error(`mdastql: expected '/' to start regex at offset ${i}`);
    }
    i++; // skip '/'
    let pattern = "";
    while (i < len && src[i] !== "/") {
      const ch = src[i]!;
      if (ch === "\\") {
        const next = src[i + 1];
        if (next == null) break;
        pattern += ch + next;
        i += 2;
        continue;
      }
      pattern += ch;
      i++;
    }
    if (src[i] !== "/") {
      throw new Error(`mdastql: unterminated regex at offset ${i}`);
    }
    i++; // skip closing '/'
    // No flags for v1
    return new RegExp(pattern);
  };

  const readAttributeFilter = (): MdastQlAttributeFilter => {
    // at '[', already checked by caller
    i++; // skip '['
    skipWhitespace();

    // path
    const pathParts: string[] = [];
    pathParts.push(readIdentifier());
    skipWhitespace();
    while (src[i] === ".") {
      i++; // skip '.'
      skipWhitespace();
      pathParts.push(readIdentifier());
      skipWhitespace();
    }

    // operator
    let op: MdastQlAttrOperator;
    if (src[i] === "=") {
      op = "eq";
      i++;
    } else if (src[i] === "!" && src[i + 1] === "=") {
      op = "ne";
      i += 2;
    } else if (src[i] === "~" && src[i + 1] === "=") {
      op = "contains";
      i += 2;
    } else if (src[i] === ">") {
      op = "gt";
      i++;
    } else if (src[i] === "<") {
      op = "lt";
      i++;
    } else if (src[i] === "~" && src[i + 1] === "/") {
      // regex operator
      op = "regex";
      i++; // position at '/'
    } else {
      throw new Error(`mdastql: invalid operator at offset ${i}`);
    }

    skipWhitespace();

    let value: MdastQlLiteral;
    let regex: RegExp | undefined;

    if (op === "regex") {
      regex = readRegex();
      value = regex.source;
    } else {
      if (src[i] === '"' || src[i] === "'") {
        value = readString();
      } else {
        value = readNumberOrIdent();
      }
    }

    skipWhitespace();
    if (src[i] !== "]") {
      throw new Error(
        `mdastql: expected ']' to end attribute filter at offset ${i}`,
      );
    }
    i++; // skip ']'

    return {
      kind: "attribute",
      path: pathParts,
      op,
      value,
      regex,
    };
  };

  const readSimpleSelector = (): MdastQlSimpleSelector => {
    skipWhitespace();
    if (i >= len) {
      throw new Error(
        "mdastql: unexpected end of query while reading selector",
      );
    }

    let typeOrAlias: MdastQlSelectorType | undefined;
    const ch = src[i]!;

    if (ch === "*") {
      typeOrAlias = "*";
      i++;
    } else if (ch === "[") {
      // No type, only attributes
      typeOrAlias = undefined;
    } else {
      const ident = readIdentifier();
      typeOrAlias = ident;
    }

    const attrs: MdastQlAttributeFilter[] = [];
    while (true) {
      skipWhitespace();
      if (src[i] !== "[") break;
      attrs.push(readAttributeFilter());
    }

    return {
      kind: "simple",
      type: typeOrAlias,
      attrs,
    };
  };

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;

    const simple = readSimpleSelector();

    // attach combinator from previous step
    if (selectors.length > 0) {
      combinators.push(pendingCombinator);
    }
    selectors.push(simple);

    skipWhitespace();
    if (i >= len) break;

    const c = src[i]!;
    if (c === ">") {
      pendingCombinator = "child";
      i++;
    } else if (c === "+") {
      pendingCombinator = "adjacent";
      i++;
    } else {
      // default combinator is descendant
      pendingCombinator = "descendant";
    }
  }

  if (selectors.length === 0) {
    throw new Error("mdastql: could not parse any selectors from query");
  }
  if (combinators.length !== selectors.length - 1) {
    throw new Error("mdastql: internal error, combinator/selector mismatch");
  }

  return { selectors, combinators };
}

/**
 * Built-in rewrite: handle h1..h6 as aliases for
 *
 *   heading[depth=N]
 *
 * where N is the heading level.
 *
 * Users can further transform this AST via the mdastql() options.rewrite hook.
 */
export const defaultMdastQlRewrite: MdastQlRewriteFn = (
  compiled: MdastQlCompiledSelector,
): MdastQlCompiledSelector => {
  const rewrittenSelectors = compiled.selectors.map((sel) => {
    if (!sel.type || sel.type === "*" || typeof sel.type !== "string") {
      return sel;
    }

    const aliasMatch = /^h([1-9]\d*)$/.exec(sel.type);
    if (!aliasMatch) {
      return sel;
    }

    const depthNum = Number(aliasMatch[1]);
    if (!Number.isFinite(depthNum) || depthNum < 1) {
      // Ignore invalid alias; leave selector as-is.
      return sel;
    }

    // Cast to HeadingDepth: mdast usually allows 1..6; we rely on runtime values.
    const depth = depthNum as HeadingDepth;

    const depthFilter: MdastQlAttributeFilter = {
      kind: "attribute",
      path: ["depth"],
      op: "eq",
      value: depth,
    };

    return {
      ...sel,
      type: "heading",
      attrs: [depthFilter, ...sel.attrs],
    };
  });

  return {
    selectors: rewrittenSelectors,
    combinators: compiled.combinators,
  };
};

/**
 * Evaluate a compiled selector on a given mdast Root.
 */
function evaluateSelector(
  root: Root,
  compiled: MdastQlCompiledSelector,
  parentMap: WeakMap<Root | RootContent, ParentInfo>,
): RootContent[] {
  const { selectors, combinators } = compiled;

  // Step 1: initial set = all nodes matching first simple selector
  const initialMatches: RootContent[] = [];
  walkRoot(root, (node) => {
    if (matchSimpleSelector(node, selectors[0]!)) {
      initialMatches.push(node);
    }
  });

  if (selectors.length === 1) {
    return initialMatches;
  }

  // Step 2: apply combinators left-to-right
  let current = initialMatches;

  for (let i = 0; i < combinators.length; i++) {
    const combinator = combinators[i]!;
    const nextSelector = selectors[i + 1]!;
    const nextSet: RootContent[] = [];
    const seen = new Set<RootContent>();

    for (const from of current) {
      let related: RootContent[];

      if (combinator === "descendant") {
        related = findDescendants(root, from, parentMap, nextSelector);
      } else if (combinator === "child") {
        related = findChildren(root, from, parentMap, nextSelector);
      } else {
        related = findAdjacent(root, from, parentMap, nextSelector);
      }

      for (const node of related) {
        if (!seen.has(node)) {
          seen.add(node);
          nextSet.push(node);
        }
      }
    }

    current = nextSet;
    if (current.length === 0) break;
  }

  return current;
}

/**
 * Walk all RootContent nodes in document order (BFS over children[]).
 */
function walkRoot(root: Root, visit: (node: RootContent) => void): void {
  const queue: RootContent[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift()!;
    visit(node);
    const anyNode = node as RootContent & { children?: RootContent[] };
    if (Array.isArray(anyNode.children)) {
      for (const child of anyNode.children) {
        queue.push(child);
      }
    }
  }
}

/**
 * Evaluate whether a node matches a simple selector.
 */
function matchSimpleSelector(
  node: RootContent,
  selector: MdastQlSimpleSelector,
): boolean {
  if (selector.type && selector.type !== "*" && node.type !== selector.type) {
    return false;
  }
  for (const attr of selector.attrs) {
    if (!matchAttributeFilter(node, attr)) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a dotted path against a node (including `data.*`).
 */
function getPathValue(node: RootContent, path: readonly string[]): unknown {
  // deno-lint-ignore no-explicit-any
  let current: any = node;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Compare a node against a single attribute filter.
 */
function matchAttributeFilter(
  node: RootContent,
  attr: MdastQlAttributeFilter,
): boolean {
  const { path, op, value, regex } = attr;
  const actual = getPathValue(node, path);

  if (actual == null) {
    // Undefined / null: considered non-matching for all operators in v1.
    return false;
  }

  switch (op) {
    case "eq":
      return actual === value;
    case "ne":
      return actual !== value;
    case "contains":
      return typeof actual === "string" &&
        String(actual).includes(String(value));
    case "gt":
      return typeof actual === "number" && actual > Number(value);
    case "lt":
      return typeof actual === "number" && actual < Number(value);
    case "regex":
      return typeof actual === "string" && !!regex && regex.test(actual);
    default:
      return false;
  }
}

/**
 * Find descendant nodes of `from` that match `selector`.
 *
 * If `from` is a heading, use "section" semantics:
 *   - Nodes in the same parent.children[]
 *   - Between this heading and the next heading with depth <= this.depth
 *   - Including nested descendants inside that range.
 *
 * If `from` is not a heading, use ordinary subtree descent (children[]).
 */
function findDescendants(
  _root: Root,
  from: RootContent,
  parentMap: WeakMap<Root | RootContent, ParentInfo>,
  selector: MdastQlSimpleSelector,
): RootContent[] {
  const matches: RootContent[] = [];

  if (from.type === "heading") {
    const heading = from as Heading;
    const parentInfo = parentMap.get(from);
    if (!parentInfo || !parentInfo.parent) {
      return matches;
    }

    const parentAny = parentInfo.parent as RootContent & {
      children?: RootContent[];
    };
    const siblings = (Array.isArray(parentAny.children)
      ? parentAny.children
      : []) as RootContent[];

    const start = parentInfo.index + 1;
    let end = siblings.length;
    for (let i = start; i < siblings.length; i++) {
      const sib = siblings[i]!;
      if (sib.type === "heading") {
        const sibDepth = (sib as Heading).depth;
        if (sibDepth <= heading.depth) {
          end = i;
          break;
        }
      }
    }

    for (let i = start; i < end; i++) {
      const sib = siblings[i]!;
      // consider sib and its subtree
      const stack: RootContent[] = [sib];
      while (stack.length > 0) {
        const node = stack.shift()!;
        if (matchSimpleSelector(node, selector)) {
          matches.push(node);
        }
        const anyNode = node as RootContent & { children?: RootContent[] };
        if (Array.isArray(anyNode.children)) {
          for (const child of anyNode.children) {
            stack.push(child);
          }
        }
      }
    }
  } else {
    // Non-heading: normal subtree
    const anyNode = from as RootContent & { children?: RootContent[] };
    const children = Array.isArray(anyNode.children)
      ? (anyNode.children as RootContent[])
      : [];
    const stack: RootContent[] = [...children];

    while (stack.length > 0) {
      const node = stack.shift()!;
      if (matchSimpleSelector(node, selector)) {
        matches.push(node);
      }
      const nodeAny = node as RootContent & { children?: RootContent[] };
      if (Array.isArray(nodeAny.children)) {
        for (const child of nodeAny.children) {
          stack.push(child);
        }
      }
    }
  }

  return matches;
}

/**
 * Find "child" nodes of `from` that match `selector`.
 *
 * If `from` is a heading:
 *   - Only direct sibling blocks between this heading and the first
 *     deeper subheading are considered.
 *   - That is: siblings from this heading to the next heading of
 *     depth <= this.depth form the "section", but only those *before*
 *     the first heading with depth > this.depth are treated as children.
 *
 * If `from` is not a heading:
 *   - Direct children (one level) via node.children[].
 */
function findChildren(
  _root: Root,
  from: RootContent,
  parentMap: WeakMap<Root | RootContent, ParentInfo>,
  selector: MdastQlSimpleSelector,
): RootContent[] {
  const matches: RootContent[] = [];

  if (from.type === "heading") {
    const heading = from as Heading;
    const parentInfo = parentMap.get(from);
    if (!parentInfo || !parentInfo.parent) return matches;

    const parentAny = parentInfo.parent as RootContent & {
      children?: RootContent[];
    };
    const siblings = (Array.isArray(parentAny.children)
      ? parentAny.children
      : []) as RootContent[];

    const start = parentInfo.index + 1;

    // First find the end of this heading's *section*:
    // up to (but not including) the next heading of depth <= this.depth.
    let sectionEnd = siblings.length;
    for (let i = start; i < siblings.length; i++) {
      const sib = siblings[i]!;
      if (sib.type === "heading") {
        const sibDepth = (sib as Heading).depth;
        if (sibDepth <= heading.depth) {
          sectionEnd = i;
          break;
        }
      }
    }

    // Now, within that section, find the first *deeper* heading.
    // Direct "children" are everything between `start` and that point.
    let childEnd = sectionEnd;
    for (let i = start; i < sectionEnd; i++) {
      const sib = siblings[i]!;
      if (sib.type === "heading" && (sib as Heading).depth > heading.depth) {
        childEnd = i;
        break;
      }
    }

    for (let i = start; i < childEnd; i++) {
      const sib = siblings[i]!;
      if (matchSimpleSelector(sib, selector)) {
        matches.push(sib);
      }
    }
  } else {
    const anyNode = from as RootContent & { children?: RootContent[] };
    const children = Array.isArray(anyNode.children)
      ? (anyNode.children as RootContent[])
      : [];
    for (const child of children) {
      if (matchSimpleSelector(child, selector)) {
        matches.push(child);
      }
    }
  }

  return matches;
}

/**
 * Find adjacent sibling nodes of `from` that match `selector`.
 *
 * Works uniformly for headings and non-headings.
 */
function findAdjacent(
  _root: Root,
  from: RootContent,
  parentMap: WeakMap<Root | RootContent, ParentInfo>,
  selector: MdastQlSimpleSelector,
): RootContent[] {
  const parentInfo = parentMap.get(from);
  if (!parentInfo || !parentInfo.parent) return [];

  const parentAny = parentInfo.parent as RootContent & {
    children?: RootContent[];
  };
  const siblings =
    (Array.isArray(parentAny.children)
      ? parentAny.children
      : []) as RootContent[];

  const next = siblings[parentInfo.index + 1];
  if (!next) return [];
  return matchSimpleSelector(next, selector) ? [next] : [];
}
