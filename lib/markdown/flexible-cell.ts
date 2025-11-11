// lib/markdown/flexible-cell.ts

/**
 * @module flexible-cell
 *
 * @summary
 * A tiny, dependency-light **remark** plugin that parses “flexible code cells”
 * from Markdown code fences. It extracts two things from a code fence:
 *
 * 1) **Processing Instructions (PI)** — flags/tokens that look like CLI args:
 *    - Long form: `--flag`, `--flag=value`, `--flag value`
 *    - Short form: `-f`, `-f=value`, `-f value`
 *    - **Bare tokens** (no leading dashes) are also recorded
 *    - Repeated flags merge their values into **arrays**
 *    - Values that look numeric (e.g. `9`) can be coerced to numbers
 *
 * 2) **ATTRS** — trailing object-literal in braces, parsed as **JSON5**:
 *    - Example: <code>```ts --env=prod { priority: 3, note: 'ok' }</code>
 *    - Saved as a plain object on the node under `data[storeKey].attrs`
 *
 * The output is stored on each **mdast** `code` node at:
 *
 *   `node.data[storeKey] = { lang, meta, pi, attrs }`
 *
 * with the default `storeKey` being `"flexibleCell"`.
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import flexibleCell from "./flexible-cell.ts";
 *
 * const md = [
 *   "```bash --env prod -L 9 tag tag { priority: 3, note: 'ok' }",
 *   "echo hi",
 *   "```",
 * ].join("\n");
 *
 * const tree = remark().use(flexibleCell, {
 *   // optional
 *   normalizeFlagKey: (k) => (k === "L" ? "level" : k),
 *   coerceNumbers: true,        // "9" -> 9
 *   onAttrsParseError: "ignore" // ignore invalid JSON5 instead of throwing
 * }).parse(md);
 *
 * // Walk to a code node and inspect:
 * const code = (tree.children.find(n => n.type === "code") as any);
 * const cell = code.data.flexibleCell;
 *
 * console.log(cell.lang);            // "bash"
 * console.log(cell.pi.pos);          // ["env","L","tag","tag","level","key"]
 * console.log(cell.pi.flags.env);    // "prod"
 * console.log(cell.pi.flags.level);  // 9  (coerced)
 * console.log(cell.attrs.priority);  // 3  (from JSON5)
 * ```
 *
 * @remarks
 * - This plugin is **idempotent**; running it more than once will reuse
 *   node data and not duplicate work.
 * - Designed to be used standalone or as a helper for selector engines.
 * - Does not mutate the code `value`; only attaches metadata on `node.data`.
 */

import type { Root, RootContent } from "npm:@types/mdast@^4";
import JSON5 from "npm:json5@^2";

/** The shape of PI (Processing Instructions) data extracted from a code cell. */
export interface FlexibleCellPi {
  /** Raw token stream split from `lang + meta` (includes flags and words). */
  args: string[];
  /**
   * Positional tokens (normalized), **excluding the leading language** token.
   * - Contains normalized flag keys for two-token flags (e.g. "`--key value`" -> `"key"`).
   * - Contains bare tokens (no leading dashes), normalized.
   */
  pos: string[];
  /**
   * Mapping of normalized flag key -> value.
   * - Single occurrences are boolean|string|number
   * - Repeated occurrences become arrays of those values
   */
  flags: Record<
    string,
    string | number | boolean | (string | number | boolean)[]
  >;
  /** Count of all tokens in `args`. */
  count: number;
  /** Count of tokens in `pos`. */
  posCount: number;
}

/** The metadata attached to a code node by this plugin. */
export interface FlexibleCellData {
  /** The language of the code fence (e.g. "ts", "bash"). */
  lang?: string;
  /** The raw `meta` string on the code fence (if any). */
  meta?: string;
  /** Parsed Processing Instructions (flags/tokens). */
  pi: FlexibleCellPi;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  attrs: Record<string, unknown>;
}

/** Configuration options for the plugin. */
export interface FlexibleCellOptions {
  /**
   * Where to store the result on `node.data`. Defaults to `"flexibleCell"`.
   * The plugin writes `node.data[storeKey] = FlexibleCellData`.
   */
  storeKey?: string;
  /**
   * Optional normalization for flag keys (e.g. convert short `"L"` -> `"level"`).
   * Applied to:
   * - `--key=value`
   * - `--key value`
   * - Short form `-k`, `-k=value`, `-k value`
   * - Bare tokens (so `"tag"` can be left as-is or normalized)
   */
  normalizeFlagKey?: (key: string) => string;
  /**
   * How to handle invalid JSON5 inside the `{ ... }` ATTRS object.
   * - `"ignore"` (default): swallow parse errors and produce `{}`.
   * - `"throw"`: rethrow the parsing error to the pipeline.
   * - `"store"`: store the raw string under `attrs.__raw` and keep `{}` otherwise.
   */
  onAttrsParseError?: "ignore" | "throw" | "store";
  /**
   * If true, numeric string values like `"9"` are coerced to numbers `9`
   * for flag values parsed from `--key value` / `-k value` (two-token form)
   * and from `--key=9` / `-k=9` key-value form.
   */
  coerceNumbers?: boolean;
}

/**
 * Flexible-cell remark plugin.
 *
 * @param options - See {@link FlexibleCellOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link FlexibleCellData}.
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import flexibleCell from "./flexible-cell.ts";
 *
 * const processor = remark().use(flexibleCell, {
 *   storeKey: "flexibleCell",
 *   normalizeFlagKey: (k) => k.toLowerCase(),
 *   onAttrsParseError: "ignore",
 *   coerceNumbers: true,
 * });
 *
 * const tree = processor.parse("```bash --env prod { ok: true }\necho\n```");
 * // Walk to a code node and read `node.data.flexibleCell`.
 * ```
 */
export default function flexibleCell(options: FlexibleCellOptions = {}) {
  const storeKey = options.storeKey ?? "flexibleCell";

  return function transformer(tree: Root) {
    const walk = (node: Root | RootContent): void => {
      if (node.type === "code") {
        // deno-lint-ignore no-explicit-any
        const anyNode = node as any;
        const data = (anyNode.data ??= {});
        if (!data[storeKey]) {
          const parsed = parseFlexibleCellFromCode(anyNode, options);
          if (parsed) data[storeKey] = parsed;
        }
      }
      // descend
      // deno-lint-ignore no-explicit-any
      const maybeChildren: any = node as any;
      const children = maybeChildren.children as RootContent[] | undefined;
      if (children && Array.isArray(children)) {
        for (const c of children) walk(c);
      }
    };

    walk(tree);
  };
}

/**
 * Parses a single mdast `code` node into {@link FlexibleCellData}.
 * Safe to call directly (the plugin uses this under the hood).
 *
 * @param node - An mdast `code` node.
 * @param options - See {@link FlexibleCellOptions}.
 * @returns Parsed {@link FlexibleCellData} or `null` if `node.type !== "code"`.
 *
 * @example
 * ```ts
 * import { parseFlexibleCellFromCode } from "./flexible-cell.ts";
 *
 * const cell = parseFlexibleCellFromCode(codeNode, { coerceNumbers: true });
 * if (cell) {
 *   console.log(cell.pi.flags, cell.attrs);
 * }
 * ```
 */
export function parseFlexibleCellFromCode(
  // deno-lint-ignore no-explicit-any
  node: any,
  options: FlexibleCellOptions = {},
): FlexibleCellData | null {
  if (!node || node.type !== "code") return null;

  const lang = (node.lang ?? "") as string;
  const meta = (node.meta ?? "") as string;

  const { pi, attrs } = parseInfoString(
    `${lang} ${meta}`.trim(),
    options,
  );

  // Attach language for convenience; keep `meta` in case callers want it.
  return {
    lang: lang || undefined,
    meta: meta || undefined,
    pi,
    attrs,
  };
}

/** Internal: parse `lang + meta` into PI (flags/tokens) and JSON5 ATTRS. */
function parseInfoString(text: string, options: FlexibleCellOptions) {
  const tokens = text.trim().length ? text.trim().split(/\s+/) : [];

  const flags: Record<
    string,
    string | number | boolean | (string | number | boolean)[]
  > = {};
  const pos: string[] = [];
  const args = [...tokens];

  let inAttrs = false;
  let attrsStr = "";

  const normalize = (k: string) =>
    options.normalizeFlagKey ? options.normalizeFlagKey(k) : k;

  const coerce = (v: string): string | number | boolean => {
    if (options.coerceNumbers && /^-?\d+(\.\d+)?$/.test(v)) {
      const asNum = Number(v);
      if (!Number.isNaN(asNum)) return asNum;
    }
    return v;
  };

  const pushFlag = (key: string, val: string | number | boolean) => {
    const k = normalize(key.replace(/^(--?)/, ""));
    if (k in flags) {
      const prev = flags[k];
      if (Array.isArray(prev)) prev.push(val);
      else flags[k] = [prev, val];
    } else {
      flags[k] = val;
    }
  };

  // First token (if present) is typically the language; we don't put it in `pos`.
  let skippedLang = false;

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];

    if (!inAttrs && token.startsWith("{")) {
      inAttrs = true;
      attrsStr = tokens.slice(i).join(" ");
      break;
    }

    const raw = token;

    // Skip the *first* token (language) for `pos`, but still allow it to be reused
    // for flags if the author did something unusual like leading dashes on the lang.
    if (!skippedLang) {
      skippedLang = true;
      // pass-through: do not continue; we still want to process "lang" in case it has dashes.
      // But we don't push it into `pos`.
      // So we do nothing here, and let the rest of the loop handle dash-normalization.
      // To keep behavior intuitive, we only treat this first token as *potential* flag
      // if it actually starts with "-" (edge case).
      if (!raw.startsWith("-")) continue;
    }

    // normalize leading dashes
    if (token.startsWith("--")) token = token.slice(2);
    else if (token.startsWith("-")) token = token.slice(1);

    // key=value
    const eq = token.indexOf("=");
    if (eq > 0) {
      const k = token.slice(0, eq);
      const vRaw = token.slice(eq + 1);
      const v = vRaw.length ? coerce(vRaw) : true;
      pushFlag(k, v);
      pos.push(normalize(k));
      continue;
    }

    // "--key value" two-token
    const next = tokens[i + 1];
    if (
      raw.startsWith("-") && next && !next.startsWith("-") &&
      !next.startsWith("{")
    ) {
      i++;
      pushFlag(token, coerce(next));
      pos.push(normalize(token));
      continue;
    }

    // bare token
    pushFlag(token, true);
    pos.push(normalize(token));
  }

  const attrs: Record<string, unknown> = {};
  if (inAttrs) {
    // Slice out the exact "{ ... }" part
    const raw = attrsStr.replace(/^[^{]*/, "").trim();
    try {
      const parsed = JSON5.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(attrs, parsed as Record<string, unknown>);
      }
    } catch (err) {
      if (options.onAttrsParseError === "throw") throw err;
      if (options.onAttrsParseError === "store") {
        attrs.__raw = raw;
      }
      // otherwise ignore
    }
  }

  return {
    pi: {
      args,
      pos,
      flags,
      count: args.length,
      posCount: pos.length,
    },
    attrs,
  };
}
