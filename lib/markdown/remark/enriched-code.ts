/**
 * EnrichedCode is a structured enrichment type for remark `code` nodes.
 * It parses fenced code blocks for Processing Instructions (PI) and
 * JSON5/YAML attribute objects, and attaches precise metadata that
 * typically makes the `code` cell executable or instructional for
 * further code generation or code execution.
 *
 * Concretely, it extracts:
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
 * with the default `storeKey` being `"enrichedCode"`.
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import enrichedCode from "./enriched-code.ts";
 *
 * const md = [
 *   "```bash --env prod -L 9 tag tag { priority: 3, note: 'ok' }",
 *   "echo hi",
 *   "```",
 * ].join("\n");
 *
 * const tree = remark().use(enrichedCode, {
 *   // optional
 *   normalizeFlagKey: (k) => (k === "L" ? "level" : k),
 *   coerceNumbers: true,        // "9" -> 9
 *   onAttrsParseError: "ignore" // ignore invalid JSON5 instead of throwing
 * }).parse(md);
 *
 * // Walk to a code node and inspect:
 * const code = (tree.children.find(n => n.type === "code") as any);
 * const cell = code.data.enrichedCode;
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
 * - Designed to be used standalone or as a helper for selector engines
 *   and Markdown-driven execution/orchestration engines.
 * - Does not mutate the code `value`; only attaches metadata on `node.data`.
 */

import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Code, Root, RootContent } from "npm:@types/mdast@^4";
import JSON5 from "npm:json5@^2";
import { getLanguageByIdOrAlias, LanguageSpec } from "../../universal/code.ts";

/** The shape of PI (Processing Instructions) data extracted from an EnrichedCode cell. */
export interface EnrichedCodePI {
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

/** The structured enrichment attached to a code node by this plugin. */
export interface EnrichedCode {
  /** The language of the code fence (e.g. "ts", "bash"). */
  readonly lang?: string;
  /** The specification of the language code fence. */
  readonly langSpec?: LanguageSpec;
  /** The raw `meta` string on the code fence (if any). */
  readonly meta?: string;
  /** Parsed Processing Instructions (flags/tokens). */
  readonly pi: EnrichedCodePI;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  readonly attrs: Record<string, unknown>;
}

export const ENRICHED_CODE_STORE_KEY = "enrichedCode" as const;

/**
 * Type guard: returns true if a `RootContent` node is a `code` node
 * that already carries EnrichedCodeData at the default store key.
 */
export function isEnrichedCode(
  node: RootContent,
): node is Code & { data: { [ENRICHED_CODE_STORE_KEY]: EnrichedCode } } {
  if (
    node.type === "code" && node.data &&
    ENRICHED_CODE_STORE_KEY in node.data
  ) {
    return true;
  }
  return false;
}

/** Configuration options for the EnrichedCode plugin. */
export interface EnrichedCodeOptions {
  /**
   * Where to store the result on `node.data`. Defaults to `"enrichedCode"`.
   * The plugin writes `node.data[storeKey] = EnrichedCodeData`.
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
  /**
   * If defined, this callback is called whenever code cells are enriched
   */
  collect?: (node: Code, ec: EnrichedCode) => void;
}

/**
 * EnrichedCode remark plugin.
 *
 * @param options - See {@link EnrichedCodeOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link EnrichedCode}.
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import enrichedCode from "./enriched-code.ts";
 *
 * const processor = remark().use(enrichedCode, {
 *   storeKey: "enrichedCode",
 *   normalizeFlagKey: (k) => k.toLowerCase(),
 *   onAttrsParseError: "ignore",
 *   coerceNumbers: true,
 * });
 *
 * const tree = processor.parse("```bash --env prod { ok: true }\necho\n```");
 * // Walk to a code node and read `node.data.enrichedCode`.
 * ```
 */
export default function enrichedCode(options: EnrichedCodeOptions = {}) {
  const { storeKey = ENRICHED_CODE_STORE_KEY, collect } = options;

  return function transformer(tree: Root) {
    const walk = (node: Root | RootContent): void => {
      if (node.type === "code") {
        // deno-lint-ignore no-explicit-any
        const anyNode = node as any;
        const data = (anyNode.data ??= {});
        if (!data[storeKey]) {
          const parsed = parseEnrichedCodeFromCode(anyNode, options);
          if (parsed) data[storeKey] = parsed;
        }
        collect?.(node, data[storeKey]);
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
 * Parses a single mdast `code` node into {@link EnrichedCode}.
 * Safe to call directly (the plugin uses this under the hood).
 *
 * @param node - An mdast `code` node.
 * @param options - See {@link EnrichedCodeOptions}.
 * @returns Parsed {@link EnrichedCode} or `null` if `node.type !== "code"`.
 *
 * @example
 * ```ts
 * import { parseEnrichedCodeFromCode } from "./enriched-code.ts";
 *
 * const cell = parseEnrichedCodeFromCode(codeNode, { coerceNumbers: true });
 * if (cell) {
 *   console.log(cell.pi.flags, cell.attrs);
 * }
 * ```
 */
export function parseEnrichedCodeFromCode(
  // deno-lint-ignore no-explicit-any
  node: any,
  options: EnrichedCodeOptions = {},
): EnrichedCode | null {
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
    langSpec: getLanguageByIdOrAlias(lang),
    meta: meta || undefined,
    pi,
    attrs,
  };
}

/** Internal: parse `lang + meta` into PI (flags/tokens) and JSON5 ATTRS. */
function parseInfoString(text: string, options: EnrichedCodeOptions) {
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
        // deno-lint-ignore no-explicit-any
        (attrs as any).__raw = raw;
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

/**
 * Convenience helper: parse a node (typically a META/enriched code cell)
 * into a JSON/YAML/JSON5 object.
 *
 * - For `code` nodes, this only triggers if the lang is one of:
 *   - `yaml`, `yml`, `json`, `json5`
 *   and, if provided, `opts.isMatch` returns true given the EnrichedCodeData.
 *
 * - For `inlineCode` nodes, this treats the value as JSON5 and parses it.
 */
export function nodeAsJSON<Shape>(
  node: RootContent,
  opts?: {
    readonly isMatch?: (node: Code, data: EnrichedCode) => boolean;
    readonly onError?: (
      err: unknown,
      node: Code,
      data: EnrichedCode,
    ) => Shape;
  },
): Shape | null {
  switch (node.type) {
    case "code":
      if (isEnrichedCode(node)) {
        const lang = (node.lang ?? "").toLowerCase();
        const isMetaLang = lang === "yaml" || lang === "yml" ||
          lang === "json" || lang === "json5";
        if (
          isMetaLang && (opts?.isMatch == undefined ||
            opts.isMatch(node, node.data[ENRICHED_CODE_STORE_KEY]))
        ) {
          try {
            if (lang === "json") {
              return JSON.parse(node.value) as Shape;
            } else if (lang === "json5") {
              return JSON5.parse(node.value) as Shape;
            } else {
              return YAMLparse(node.value) as Shape;
            }
          } catch (err) {
            return opts?.onError?.(
              err,
              node,
              node.data[ENRICHED_CODE_STORE_KEY],
            ) as Shape;
          }
        }
      }
      break;

    case "inlineCode":
      return JSON5.parse(node.value) as Shape;
  }
  return null;
}
