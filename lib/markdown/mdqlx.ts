// lib/markdown/mdqlx.ts
// Executor for MDQL selectors over an mdast tree (Root/RootContent).
// - Works with the AST produced by parseMDQL() from ./mdql.ts
// - Supports frontmatter querying via [frontmatter.*] attribute paths
// - Supports :contains("text") (case-insensitive), :attrs(...), :pi(...), and :has(<selector-list>)
// - PI supports long/short flags with merging: --flag, --flag=value, --flag value,
//   repeated flags accumulate into arrays; single '-' prefixes are normalized too.

import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Literal, Parent, Root, RootContent } from "npm:@types/mdast@^4";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { remark } from "npm:remark@^15";
import type {
  AttributeSelector,
  Combinator,
  CompoundSelector,
  PseudoFunc,
  Selector,
  SelectorList,
  SimpleSelector,
} from "./mdql.ts";

import flexibleCell, {
  type FlexibleCellData,
  parseFlexibleCellFromCode,
} from "./flexible-cell.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Provenance = string;

export interface MdastSource<T extends string = Provenance> {
  mdast: (provenance: T) => Promise<Root>;
}

export interface Match<T extends string = Provenance> {
  provenance: T;
  root: Root;
  node: RootContent;
  indexPath: number[];
}

export interface MdqlExecuteOptions<T extends string = Provenance> {
  projectSection?: (heading: RootContent, root: Root) => RootContent[];
  normalizeFlagKey?: (key: string) => string;
  parseAttrs?: (rawObjectLiteral: string) => Record<string, unknown>;
  defaultRootProvider?: (source: MdastSource<T>) => Promise<[T, Root]>;
}

/** Entrypoint: compiles parsed MDQL and returns executor */
export function mdqlSelector<T extends string = Provenance>(
  ast: SelectorList,
  opts: MdqlExecuteOptions<T> = {},
) {
  const compiled = compileSelectorList<T>(ast, opts);
  const wantedFiles = extractFileScopes(ast);

  return {
    async *select(sources: Iterable<MdastSource<T>>): AsyncGenerator<Match<T>> {
      const seen = new Set<string>();
      for (const source of sources) {
        if (wantedFiles.length) {
          for (const prov of wantedFiles as unknown as T[]) {
            const key = `p:${String(prov)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const root = await source.mdast(prov);
            yield* runOnRoot<T>(compiled, root, prov);
          }
        } else {
          const [prov, root] = opts.defaultRootProvider
            ? await opts.defaultRootProvider(source)
            : ["*" as unknown as T, await source.mdast("*" as unknown as T)];
          yield* runOnRoot<T>(compiled, root, prov);
        }
      }
    },
  };
}

/** Compile selector list into (root) => RootContent[] */
function compileSelectorList<T extends string>(
  ast: SelectorList,
  opts: MdqlExecuteOptions<T>,
) {
  const compiledPerItem = ast.items.map((sel) => compileSelector<T>(sel, opts));
  return (root: Root) => {
    const out: RootContent[] = [];
    for (const fn of compiledPerItem) out.push(...fn(root));
    return out;
  };
}

/** Compile a single selector into (root) => RootContent[] */
function compileSelector<T extends string>(
  sel: Selector,
  opts: MdqlExecuteOptions<T>,
) {
  const testHead = compileCompound<T>(sel.core.head, opts);
  const tailTests = sel.core.tails.map((t) => ({
    comb: t.combinator,
    test: compileCompound<T>(t.right, opts),
  }));

  const globalEval = (root: Root): Set<RootContent> => {
    const seeds = collect(root).filter((n) => testHead(n, root));
    let frontier = seeds;
    for (const { comb, test } of tailTests) {
      const next: RootContent[] = [];
      for (const n of frontier) {
        for (const m of neighbors(n, root, comb)) {
          if (test(m, root)) next.push(m);
        }
      }
      frontier = next;
    }
    if (!sel.pseudoElement) return new Set(frontier);
    if (sel.pseudoElement === "section") {
      const expanded = expandSections<T>(frontier, root, opts);
      return new Set(expanded);
    }
    return new Set(frontier);
  };

  const exec = (root: Root) => {
    const seeds = collect(root).filter((n) => testHead(n, root));
    let frontier = seeds;
    for (const { comb, test } of tailTests) {
      const next: RootContent[] = [];
      for (const n of frontier) {
        for (const m of neighbors(n, root, comb)) {
          if (test(m, root)) next.push(m);
        }
      }
      frontier = next;
    }

    if (!sel.pseudoElement) return frontier;
    switch (sel.pseudoElement) {
      case "section":
        return expandSections<T>(frontier, root, opts);
      case "text":
      case "content":
      case "slug":
      default:
        return frontier;
    }
  };

  (exec as unknown as { __glob?: (root: Root) => Set<RootContent> }).__glob =
    globalEval;

  return exec;
}

/** Compile a compound (all simple parts must match) */
function compileCompound<T extends string>(
  comp: CompoundSelector,
  opts: MdqlExecuteOptions<T>,
) {
  const parts = comp.parts.map((p) => compileSimple<T>(p, opts));
  return (node: RootContent, root: Root) => parts.every((fn) => fn(node, root));
}

/** Compile a simple selector */
function compileSimple<T extends string>(
  ss: SimpleSelector,
  opts: MdqlExecuteOptions<T>,
) {
  switch (ss.kind) {
    case "Universal":
      return () => true;

    case "Type":
      return (n: RootContent) => {
        // Allow HTML-like shorthands:
        //   h1..h6  => mdast "heading" with matching depth
        //   p       => mdast "paragraph"
        // (Falls back to exact mdast type match otherwise)
        const name = String(ss.name).toLowerCase();
        const h = name.match(/^h([1-6])$/);
        if (h) {
          return n.type === "heading" &&
            ((n as unknown as { depth?: number }).depth ?? 0) === Number(h[1]);
        }
        if (name === "p") return n.type === "paragraph";
        return n.type === ss.name;
      };

    case "Attr":
      return compileAttr<T>(ss, opts);

    case "PseudoFunc":
      return compilePseudoFunc<T>(ss, opts);

    default:
      return () => true;
  }
}

/** Attribute selector implementation with frontmatter + PI/ATTR paths */
function compileAttr<T extends string>(
  a: AttributeSelector,
  opts: MdqlExecuteOptions<T>,
) {
  return (node: RootContent, root: Root) => {
    const op = (a as { op?: string }).op ??
      (a as { operator?: string }).operator;
    const rhs = (a as { value?: unknown }).value;
    const val = readAttr(a.name, node, root, opts);

    if (op == null) return truthy(val);

    switch (op) {
      case "=":
        return eq(val, rhs);
      case "!=":
        return !eq(val, rhs);
      case "^=":
        return typeof val === "string" && starts(val, String(rhs));
      case "$=":
        return typeof val === "string" && ends(val, String(rhs));
      case "*=":
        return typeof val === "string" && includes(val, String(rhs));
      case "~=":
        return containsItem(val, rhs);
      case ">=":
        return Number(val) >= Number(rhs);
      case "<=":
        return Number(val) <= Number(rhs);
      default:
        return false;
    }
  };
}

/** Pseudo functions: contains, attrs, pi, has */
function compilePseudoFunc<T extends string>(
  pf: PseudoFunc,
  opts: MdqlExecuteOptions<T>,
) {
  return (node: RootContent, root: Root) => {
    const name = String(pf.name);

    // :contains("text") — case-insensitive
    if (name === "contains") {
      const arg0 = pf.args[0];
      const needleRaw = arg0 == null
        ? ""
        : typeof arg0 === "string"
        ? arg0
        : extractBarewordFromSelectorArg(arg0) ?? String(arg0);
      const needle = needleRaw.toLowerCase();
      const hay = mdToString(node).toLowerCase();
      return hay.includes(needle);
    }

    // PI + ATTRS via flexible-cell
    const virt = getVirtualProps(node, root, opts);

    // :attrs('key')  -> key present in parsed attrs object
    if (name === "attr" || name === "attrs") {
      if (!virt) return false;
      if (!pf.args.length) return truthy(virt.attrs);
      const arg0 = pf.args[0];
      const key = arg0 == null
        ? ""
        : typeof arg0 === "string"
        ? arg0
        : extractBarewordFromSelectorArg(arg0) ?? String(arg0);
      return Object.prototype.hasOwnProperty.call(virt.attrs, key);
    }

    // :pi(flag) or :pi(x) -> bare tokens or keys from key=value; repeated flags supported
    if (name === "pi" || name === "argv") {
      if (!virt) return false;
      if (!pf.args.length) return truthy(virt.pi);
      const arg0 = pf.args[0];
      const token = arg0 == null
        ? ""
        : typeof arg0 === "string"
        ? normalizeFlagKey(arg0, opts)
        : normalizeFlagKey(
          extractBarewordFromSelectorArg(arg0) ?? String(arg0),
          opts,
        );
      if (virt.pi.pos.includes(token)) return true;
      return Object.prototype.hasOwnProperty.call(virt.pi.flags, token);
    }

    // :has(<selector-list>)
    if (name === "has") {
      if (!pf.args.length) return false;
      const arg0 = pf.args[0];
      if (
        typeof arg0 !== "object" || !arg0 ||
        (arg0 as { kind?: string }).kind !== "SelectorList"
      ) {
        return false;
      }
      const inner = compileSelectorList<T>(arg0 as SelectorList, opts);
      const matchedSet = new Set(inner(root));
      for (const d of collectFrom(node)) {
        if (matchedSet.has(d)) return true;
      }
      return false;
    }

    return false;
  };
}

/** Extract a bareword if the pseudo arg was parsed as a SelectorList like `flag` */
function extractBarewordFromSelectorArg(arg: unknown): string | null {
  const sl = arg as Partial<SelectorList> & { items?: Selector[] };
  if (
    !sl || sl.kind !== "SelectorList" || !Array.isArray(sl.items) ||
    sl.items.length !== 1
  ) {
    return null;
  }
  const sel = sl.items[0];
  const head = sel.core.head;
  if (!head.parts || head.parts.length !== 1) return null;
  const only = head.parts[0] as SimpleSelector;
  if (only.kind === "Type") return String(only.name);
  if (
    (only as { kind?: string }).kind === "Id" ||
    (only as { kind?: string }).kind === "Class"
  ) {
    return String(
      (only as unknown as { value?: string; name?: string }).value ??
        (only as unknown as { value?: string; name?: string }).name ?? "",
    );
  }
  return null;
}

/** Traverse whole tree (excluding root) */
function collect(root: Root): RootContent[] {
  const out: RootContent[] = [];
  const visit = (n: Root | RootContent): void => {
    if (n.type !== "root") out.push(n as RootContent);
    if (isParent(n)) { for (const c of n.children as RootContent[]) visit(c); }
  };
  visit(root);
  return out;
}

/** Collect descendants of a node (excluding the node) */
function collectFrom(node: RootContent): RootContent[] {
  const out: RootContent[] = [];
  const visit = (n: RootContent): void => {
    if (n !== node) out.push(n);
    if (isParent(n)) { for (const c of n.children as RootContent[]) visit(c); }
  };
  visit(node);
  return out;
}

/** Neighbor sets based on combinator */
function neighbors(
  node: RootContent,
  root: Root,
  comb: Combinator,
): RootContent[] {
  switch (comb) {
    case "descendant":
      return collectFrom(node);
    case "child":
      return isParent(node) ? ((node.children ?? []) as RootContent[]) : [];
    case "adjacent": {
      const p = parentOf(node, root);
      if (!p || !p.children) return [];
      const i = positionInParent(node, root);
      const arr = p.children as RootContent[];
      return i >= 0 && i + 1 < arr.length ? [arr[i + 1]] : [];
    }
    case "sibling": {
      const p = parentOf(node, root);
      if (!p || !p.children) return [];
      const i = positionInParent(node, root);
      const arr = p.children as RootContent[];
      return i >= 0 ? arr.slice(i + 1) : [];
    }
  }
}

/** Parent helpers */
function parentOf(target: RootContent, root: Root): Parent | null {
  let found: Parent | null = null;
  const walk = (node: Root | RootContent): void => {
    if (!isParent(node)) return;
    for (const c of node.children as RootContent[]) {
      if (c === target) {
        found = node as Parent;
        return;
      }
      if (found) return;
      walk(c);
      if (found) return;
    }
  };
  walk(root);
  return found;
}
function positionInParent(target: RootContent, root: Root): number {
  const p = parentOf(target, root);
  if (!p || !p.children) return -1;
  return (p.children as RootContent[]).indexOf(target);
}

function isParent(n: Root | RootContent): n is Extract<RootContent, Parent> {
  return !!(n && typeof (n as Any).children === "object" &&
    Array.isArray((n as Any).children));
}

/** ::section default projection */
function expandSections<T extends string>(
  nodes: RootContent[],
  root: Root,
  opts: MdqlExecuteOptions<T>,
): RootContent[] {
  const project = opts.projectSection ?? defaultProjectSection;
  const out: RootContent[] = [];
  for (const n of nodes) {
    if (n.type === "heading") out.push(...project(n, root));
  }
  return out;
}
function defaultProjectSection(
  heading: RootContent,
  root: Root,
): RootContent[] {
  if (heading.type !== "heading") return [];
  const parent = parentOf(heading, root);
  if (!parent || !parent.children) return [];
  const arr = parent.children as RootContent[];
  const start = positionInParent(heading, root);
  const level = (heading as unknown as { depth?: number }).depth ?? 0;
  const chunk: RootContent[] = [];
  for (let i = start; i < arr.length; i++) {
    const m = arr[i];
    if (
      i > start && m.type === "heading" &&
      ((m as unknown as { depth?: number }).depth ?? 0) <= level
    ) break;
    chunk.push(m);
  }
  return chunk;
}

/** Read attribute (with frontmatter + PI/ATTRS + helpful aliases) */
function readAttr<T extends string>(
  name: string,
  node: RootContent,
  root: Root,
  opts: MdqlExecuteOptions<T>,
): unknown {
  if (name === "type") return node.type;
  if (name === "value") return (node as unknown as Literal).value;
  if (name === "lang") return (node as unknown as { lang?: string }).lang;
  if (name === "href" || name === "url") {
    return (node as unknown as { url?: string }).url;
  }
  if (name === "depth") return (node as unknown as { depth?: number }).depth;
  if (name === "text") return mdToString(node);

  // frontmatter.*
  if (
    name.startsWith("frontmatter.") || name.startsWith("yaml.") ||
    name.startsWith("toml.")
  ) {
    const fm = getFrontmatter(root);
    return getPath(fm, name.split(".").slice(1));
  }

  // pi.* / attrs.* (projected from flexible-cell)
  if (name.startsWith("pi.") || name.startsWith("attrs.")) {
    const v = getVirtualProps(node, root, opts);
    if (!v) return undefined;

    if (name.startsWith("pi.")) {
      const parts = name.split(".").slice(1); // after "pi."
      if (parts.length === 0) return v.pi;
      const [head, ...rest] = parts;

      if (
        head === "pos" || head === "args" || head === "count" ||
        head === "posCount"
      ) {
        return rest.length
          ? getPath(v.pi as unknown as Record<string, unknown>, [head, ...rest])
          : (v.pi as unknown as Record<string, unknown>)[head];
      }
      if (head === "flags") {
        return rest.length
          ? getPath(v.pi.flags as Record<string, unknown>, rest)
          : v.pi.flags;
      }
      // Default shortcut: "pi.<key>" === "pi.flags.<key>"
      return rest.length
        ? getPath(v.pi.flags as Record<string, unknown>, [head, ...rest])
        : (v.pi.flags as Record<string, unknown>)[head];
    }

    if (name.startsWith("attrs.")) {
      return getPath(v.attrs, name.split(".").slice(1));
    }
  }

  return (node as unknown as Record<string, unknown>)[name];
}

/** Frontmatter extraction (robust) */
function getFrontmatter(root: Root): Record<string, unknown> {
  const CACHE = "__fm_cache__";
  const anyRoot = root as unknown as {
    [k: string]: Record<string, unknown> | undefined;
  };
  if (anyRoot[CACHE]) return anyRoot[CACHE]!;
  const fm: Record<string, unknown> = {};

  // Direct scan of YAML nodes
  for (const n of (root.children ?? []) as RootContent[]) {
    if (
      n.type === "yaml" && typeof (n as { value?: unknown }).value === "string"
    ) {
      try {
        const y = YAMLparse((n as { value: string }).value);
        if (y && typeof y === "object") {
          Object.assign(fm, y as Record<string, unknown>);
        }
        // deno-lint-ignore no-empty
      } catch {}
    }
  }

  // Fallback: run a remark pipeline to ensure frontmatter nodes are discoverable.
  if (Object.keys(fm).length === 0) {
    const pipeline = remark()
      .use(remarkFrontmatter, ["yaml", "toml"])
      .use(remarkGfm)
      // ✅ also load flexible-cell here (no-op for YAML, keeps invariant with main parsing)
      .use(flexibleCell, { storeKey: "flexibleCell" })
      .use(remarkStringify);

    const tree = pipeline.parse(pipeline.stringify(root)) as Root;
    for (const n of tree.children) {
      if (
        n.type === "yaml" &&
        typeof (n as { value?: unknown }).value === "string"
      ) {
        try {
          const y = YAMLparse((n as { value: string }).value);
          if (y && typeof y === "object") {
            Object.assign(fm, y as Record<string, unknown>);
          }
          // deno-lint-ignore no-empty
        } catch {}
      }
    }
  }

  anyRoot[CACHE] = fm;
  return fm;
}

/** Virtual PI/ATTRS adapter using flexible-cell (no duplicate parsing logic here) */
type Virt = {
  pi: {
    args: string[];
    pos: string[];
    // flexible-cell can coerce to boolean|string|number|(…[])
    flags: Record<string, unknown>;
    count: number;
    posCount: number;
  };
  attrs: Record<string, unknown>;
};

function normalizeFlagKey(k: string, opts: MdqlExecuteOptions): string {
  const norm = opts.normalizeFlagKey?.(k);
  return (norm ?? k);
}

/** Retrieve virtual props for a code fence via flexible-cell.
 *  - If node already has data.flexibleCell (from an upstream remark run), reuse it.
 *  - Otherwise parse on-the-fly from the node using parseFlexibleCellFromCode().
 */
function getVirtualProps<T extends string>(
  node: RootContent,
  _root: Root,
  opts: MdqlExecuteOptions<T>,
): Virt | null {
  if (node.type !== "code") return null;

  // Reuse if plugin already ran upstream
  // deno-lint-ignore no-explicit-any
  const data = (node as any).data as
    | { flexibleCell?: FlexibleCellData }
    | undefined;
  const stored = data?.flexibleCell;
  if (stored) {
    return {
      pi: {
        args: stored.pi.args,
        pos: stored.pi.pos,
        flags: stored.pi.flags as Record<string, unknown>,
        count: stored.pi.count,
        posCount: stored.pi.posCount,
      },
      attrs: stored.attrs,
    };
  }

  // Parse on-demand (no duplication—delegates to helper from flexible-cell.ts)
  const parsed = parseFlexibleCellFromCode(node, {
    normalizeFlagKey: opts.normalizeFlagKey,
    storeKey: "flexibleCell",
  });

  if (!parsed) return null;

  // Attach for idempotence so subsequent calls reuse it
  // deno-lint-ignore no-explicit-any
  ((node as any).data ??= {}).flexibleCell = parsed;

  return {
    pi: {
      args: parsed.pi.args,
      pos: parsed.pi.pos,
      flags: parsed.pi.flags as Record<string, unknown>,
      count: parsed.pi.count,
      posCount: parsed.pi.posCount,
    },
    attrs: parsed.attrs,
  };
}

/** Utils */
function getPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
function eq(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v === 0 ? true : !!v;
}
function containsItem(h: unknown, n: unknown): boolean {
  const needle = String(n ?? "");
  if (Array.isArray(h)) return h.map(String).includes(needle);
  const s = String(h ?? "");
  return s.split(/\s+/).includes(needle);
}
function starts(h: string, n: string): boolean {
  return h.startsWith(n);
}
function ends(h: string, n: string): boolean {
  return h.endsWith(n);
}
function includes(h: string, n: string): boolean {
  return h.includes(n);
}

/** Extract literal file: scopes from head parts */
function extractFileScopes(ast: SelectorList): string[] {
  const out: string[] = [];
  for (const sel of ast.items) {
    for (const part of sel.core.head.parts) {
      if (
        (part as AttributeSelector).kind === "Attr" &&
        (part as AttributeSelector).name === "file" &&
        (part as AttributeSelector).value != null
      ) {
        out.push(String((part as AttributeSelector).value));
      }
    }
  }
  return out;
}

/** Execute compiled selector against a root and yield matches with paths */
async function* runOnRoot<T extends string>(
  compiled: (root: Root) => RootContent[],
  root: Root,
  provenance: T,
): AsyncGenerator<Match<T>> {
  const idxMap = new Map<RootContent, number[]>();
  const build = (node: Root | RootContent, path: number[]): void => {
    if (node.type !== "root") idxMap.set(node as RootContent, path);
    if (isParent(node)) {
      (node.children as RootContent[]).forEach((c, i) =>
        build(c, path.concat(i))
      );
    }
  };
  build(root, []);
  for (const node of compiled(root)) {
    yield { provenance, root, node, indexPath: idxMap.get(node) ?? [] };
  }
}
