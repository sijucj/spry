import JSON5 from "npm:json5@^2";

/**
 * POSIX-style processing instruction (PI) extracted from a `cmd/lang + meta` string.
 *
 * This represents the parsed token stream and normalized flags from the
 * non-JSON portion of a Markdown code-fence info string, e.g.:
 *
 *   ```js PARTIAL main --level=2 --name "hello world" { id: "foo" }
 *   ^^^^ ^^^^^^^^^^^^ ^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^
 *   cmd   tokens        flags           flags              attrs
 *   ```
 *
 * The first token is treated as a **command / language hint** (`cmd/lang`).
 * By default it is excluded from flag / positional parsing, but it is
 * available separately in the result as `cmdLang`.
 *
 * The JSON5 `{ ... }` block, if present, is returned separately as `attrs`.
 */
export interface PosixStylePI {
  /**
   * Raw token stream split from the entire info string (including cmd/lang,
   * flags, words, and anything inside the attrs block), using
   * POSIX-like tokenization:
   *
   * - Whitespace separates tokens;
   * - Single and double quotes group text and are not included in tokens;
   * - A backslash escapes the next character (outside or inside double quotes).
   */
  args: string[];
  /**
   * Positional tokens (normalized).
   *
   * When the default behavior is used (see `retainCmdLang`), this excludes
   * the leading `cmd/lang` token.
   *
   * Contains:
   * - normalized flag keys for two-token flags
   *   (e.g. "`--key value`" -> `"key"`);
   * - bare tokens (no leading dashes), normalized via `normalizeFlagKey`
   *   when provided.
   */
  pos: string[];
  /**
   * Mapping of normalized flag key -> value.
   *
   * Single occurrences are stored as:
   * - boolean for bare flags (e.g. `--verbose`),
   * - string or number for key-value flags.
   *
   * Repeated occurrences of the same key accumulate into arrays:
   *   `--tag a --tag=b --tag c`  ->  `flags.tag = ["a", "b", "c"]`
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

/**
 * Result of `instructionsFromText`.
 *
 * This wraps the POSIX-style PI plus richer, higher-level context about
 * how the string was interpreted.
 */
export interface InstructionsResult {
  /** Parsed POSIX-style PI for the command-line portion. */
  pi: PosixStylePI;
  /** Parsed JSON5 attrs object, if a `{ ... }` block was present. */
  attrs?: Record<string, unknown>;
  /**
   * First token from the CLI portion, treated as a "command / language hint".
   *
   * For code fences, this is typically the language (e.g. `"ts"` or `"sql"`),
   * but may be any arbitrary command-like string.
   */
  cmdLang?: string;
  /**
   * Raw CLI text that was tokenized for PI parsing, i.e. the substring
   * before the first unquoted `{` (or the entire string if no attrs block).
   */
  cli: string;
  /**
   * Raw JSON5 text handed to the JSON5 parser, i.e. the substring starting
   * at the first unquoted `{` (including that brace), or `undefined` when
   * no attrs block was found.
   */
  attrsText?: string;
}

/**
 * Tokenize a string in a POSIX-like way:
 *
 * - Whitespace delimits tokens.
 * - Single quotes `'...'` group literal text; backslashes are not special.
 * - Double quotes `"..."` group text; backslash escapes the next character.
 * - Outside quotes, a backslash escapes the next character.
 * - Quotes are **not** included in the resulting tokens.
 */
function tokenizePosix(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  type State = "OUT" | "SINGLE" | "DOUBLE";
  let state: State = "OUT";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (state === "OUT") {
      if (ch === "'") {
        state = "SINGLE";
        continue;
      }
      if (ch === '"') {
        state = "DOUBLE";
        continue;
      }
      if (/\s/.test(ch)) {
        if (buf.length) {
          out.push(buf);
          buf = "";
        }
        continue;
      }
      if (ch === "\\") {
        const next = input[++i];
        if (next !== undefined) buf += next;
        continue;
      }
      buf += ch;
      continue;
    }

    if (state === "SINGLE") {
      if (ch === "'") {
        state = "OUT";
        continue;
      }
      // Everything is literal inside single quotes
      buf += ch;
      continue;
    }

    // state === "DOUBLE"
    if (ch === '"') {
      state = "OUT";
      continue;
    }
    if (ch === "\\") {
      const next = input[++i];
      if (next !== undefined) buf += next;
      continue;
    }
    buf += ch;
  }

  if (buf.length) out.push(buf);
  return out;
}

/**
 * Split the info string into:
 * - a "command-line" CLI portion (before the first unquoted `{`), and
 * - an optional JSON5 attrs portion (starting from that `{`).
 *
 * A `{` inside single or double quotes does NOT start the attrs block.
 */
function splitCliAndAttrs(text: string): { cli: string; attrsText?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { cli: "" };

  type State = "OUT" | "SINGLE" | "DOUBLE";
  let state: State = "OUT";

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (state === "OUT") {
      if (ch === "'") {
        state = "SINGLE";
        continue;
      }
      if (ch === '"') {
        state = "DOUBLE";
        continue;
      }
      if (ch === "{") {
        const cli = trimmed.slice(0, i).trim();
        const attrsText = trimmed.slice(i).trim();
        return { cli, attrsText };
      }
      continue;
    }

    if (state === "SINGLE") {
      if (ch === "'") state = "OUT";
      continue;
    }

    // state === "DOUBLE"
    if (ch === '"') {
      state = "OUT";
      continue;
    }
    if (ch === "\\") {
      // skip escaped char
      i++;
    }
  }

  return { cli: trimmed, attrsText: undefined };
}

/**
 * Parse a `cmd/lang + meta` string into:
 * - a POSIX-style PI structure (`pi`),
 * - an optional JSON5 `{ ... }` attributes object (`attrs`),
 * - plus higher-level metadata (`cmdLang`, `cli`, `attrsText`).
 *
 * The string is conceptually split into:
 *
 *   [command-like portion] [optional JSON5 attrs block]
 *
 * The command-like portion (before the first unquoted `{`) is tokenized using
 * POSIX-like rules (see `tokenizePosix`). Flags and positional tokens are
 * extracted only from this portion.
 *
 * The attrs block is the substring from the first unquoted `{` to the end,
 * passed verbatim to JSON5 for parsing.
 *
 * Parsing rules (for the CLI portion):
 * - The **first token** is treated as a `cmd/lang` hint.
 * - By default, this `cmd/lang` is excluded from flag / positional parsing
 *   (`retainCmdLang` is `false`), but is returned separately as `cmdLang`.
 * - When `retainCmdLang` is `true`, the entire token stream (including the
 *   first token) participates in flag and `pos` parsing.
 * - Flags are recognized as:
 *   - `--key=value` or `-k=value`
 *   - `--key value` or `-k value` (two-token form)
 *   - bare tokens (no leading dashes) which become boolean flags `true`.
 *
 * Examples:
 *
 *   "js --tag important { id: 'foo' }"
 *     -> cmdLang === "js"
 *     -> pi.flags.tag === "important"
 *
 *   "ts --name 'hello world' --path \"a b/c\" tag"
 *     -> cmdLang === "ts"
 *     -> pi.flags.name === "hello world"
 *     -> pi.flags.path === "a b/c"
 *     -> pi.flags.tag === true
 */
export function instructionsFromText(
  text: string,
  options?: {
    /**
     * Optional normalization for flag keys (e.g. convert short `"L"` -> `"level"`).
     *
     * Applied to:
     * - `--key=value`
     * - `--key value`
     * - Short form `-k`, `-k=value`, `-k value`
     * - Bare tokens (so `"tag"` can be normalized as needed).
     */
    normalizeFlagKey?: (key: string) => string;
    /**
     * How to handle invalid JSON5 inside the `{ ... }` ATTRS object.
     *
     * - `"ignore"` (default): swallow parse errors and produce an empty object.
     * - `"throw"`: rethrow the parsing error to the caller.
     * - `"store"`: store the raw string under `attrs.__raw` and keep `{}` otherwise.
     */
    onAttrsParseError?: "ignore" | "throw" | "store";
    /**
     * If true, numeric string values like `"9"` are coerced to numbers `9`
     * for flag values parsed from:
     * - `--key value` / `-k value` (two-token form), and
     * - `--key=9` / `-k=9` key-value form.
     *
     * JSON5 parsing of the attrs block already produces numbers where appropriate.
     */
    coerceNumbers?: boolean;
    /**
     * Whether the `cmd/lang` token should participate in flag and `pos` parsing.
     *
     * - `false` (default): the first CLI token is treated purely as a hint and
     *   is **not** parsed as a flag or positional token; it is still returned
     *   as `cmdLang`.
     * - `true`: the first CLI token is treated like any other token and is
     *   included in flag / `pos` parsing.
     */
    retainCmdLang?: boolean;
  },
): InstructionsResult {
  const { cli, attrsText } = splitCliAndAttrs(text);

  const cliTokens = cli ? tokenizePosix(cli) : [];
  const cmdLang = cliTokens.length ? cliTokens[0] : undefined;
  const tokens = options?.retainCmdLang ? cliTokens : cliTokens.slice(1);

  const args = text.trim().length ? tokenizePosix(text.trim()) : [];

  const flags: Record<
    string,
    string | number | boolean | (string | number | boolean)[]
  > = {};
  const pos: string[] = [];

  const normalize = (k: string) =>
    options?.normalizeFlagKey ? options.normalizeFlagKey(k) : k;

  const coerce = (v: string): string | number | boolean => {
    if (options?.coerceNumbers && /^-?\d+(\.\d+)?$/.test(v)) {
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

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    const raw = token;

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

    // "--key value" two-token form
    const next = tokens[i + 1];
    if (raw.startsWith("-") && next && !next.startsWith("-")) {
      i++;
      pushFlag(token, coerce(next));
      pos.push(normalize(token));
      continue;
    }

    // bare token (no dashes): treated as a boolean flag
    pushFlag(token, true);
    pos.push(normalize(token));
  }

  const attrs: Record<string, unknown> = {};
  if (attrsText) {
    const raw = attrsText.trim();
    try {
      const parsed = JSON5.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(attrs, parsed as Record<string, unknown>);
      }
    } catch (err) {
      if (options?.onAttrsParseError === "throw") throw err;
      if (options?.onAttrsParseError === "store") {
        const attrsWithRaw: Record<string, unknown> & { __raw?: string } =
          attrs;
        attrsWithRaw.__raw = raw;
      }
      // otherwise ignore -> attrs stays {}
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
    attrs: attrsText ? attrs : undefined,
    cmdLang,
    cli,
    attrsText,
  };
}
