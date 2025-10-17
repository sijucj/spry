import { globToRegExp, isGlob, normalize } from "jsr:@std/path@^1";
import { z, ZodType } from "jsr:@zod/zod@4";
import { parsedTextComponents } from "./md-notebook.ts";
import { jsonToZod } from "./zod-aide.ts";

// TS-only types for dev ergonomics
type InjectContentFn = (
  locals: Record<string, unknown>,
  onError?: (message: string, content: string, error?: unknown) => string,
) =>
  | { content: string; interpolate: boolean; locals: Record<string, unknown> }
  | Promise<
    { content: string; interpolate: boolean; locals: Record<string, unknown> }
  >;

export const mdFencedBlockPartialSchema = z.object({
  identity: z.string().min(1),
  argsZodSchema: z.instanceof(ZodType).optional(),
  argsZodSchemaSpec: z.string().optional(),

  // Zod v4: cannot embed parameter/return schemas for function *fields*.
  // Use z.custom<InjectFn>(...) with a guard (and optional runtime checks).
  content: z.custom<InjectContentFn>(
    (v): v is InjectContentFn =>
      typeof v === "function" &&
      // optional arity sanity-check: 1 or 2 params (locals[, onError])
      // deno-lint-ignore ban-types
      (v as Function).length >= 1 &&
      // deno-lint-ignore ban-types
      (v as Function).length <= 2,
    {
      message:
        "inject must be a function (locals: Record<string, unknown>, onError?: (msg, content, err) => string) => string | Promise<string>",
    },
  ),
}).strict();

export type FencedBlockPartial = z.infer<typeof mdFencedBlockPartialSchema>;

export type FencedBlockPartialSupplier = {
  partial: FencedBlockPartial;
};

export function fbPartialCandidate(
  info: string,
  content: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    registerIssue: (message: string, content: string, error?: unknown) => void;
  },
): FencedBlockPartial {
  const argsZodSchemaSpec = JSON.stringify(
    zodSchemaSpec
      ? Object.keys(zodSchemaSpec).length > 0 ? zodSchemaSpec : undefined
      : undefined,
  );
  let argsZodSchema: ZodType | undefined;
  if (argsZodSchemaSpec) {
    try {
      argsZodSchema = jsonToZod(JSON.stringify({
        type: "object",
        properties: JSON.parse(argsZodSchemaSpec),
        additionalProperties: true,
      }));
    } catch (error) {
      argsZodSchema = undefined;
      init?.registerIssue(
        `Invalid Zod schema spec: ${argsZodSchemaSpec}`,
        content,
        error,
      );
    }
  }

  const identity = info.trim();
  return {
    identity,
    argsZodSchema,
    argsZodSchemaSpec,
    content: (locals, onError) => {
      if (argsZodSchema) {
        const parsed = z.safeParse(
          argsZodSchema,
          locals,
        );
        if (!parsed.success) {
          const message = `Invalid arguments passed to partial '${identity}': ${
            z.prettifyError(parsed.error)
          }\nPartial '${identity}' expected arguments ${argsZodSchemaSpec}`;
          return {
            content: onError
              ? onError(message, content, parsed.error)
              : message,
            interpolate: false,
            locals,
          };
        }
      }
      return { content, interpolate: true, locals };
    },
  };
}

export function fbPartialsCollection<
  Supplier extends FencedBlockPartialSupplier,
>(
  init?: { onDuplicate?: (fbps: Supplier) => "overwrite" | "throw" | "ignore" },
) {
  const catalog = new Map<string, Supplier>();
  return {
    catalog,
    register: (fbps: Supplier) => {
      const { identity } = fbps.partial;
      const found = catalog.get(identity);
      if (found && init?.onDuplicate) {
        const onDupe = init.onDuplicate(fbps);
        if (onDupe === "throw") {
          throw new Deno.errors.AlreadyExists(
            `Partial '${identity}' defined already, not creating duplicate in fbPartialsCollection`,
          );
        } else if (onDupe === "ignore") {
          return;
        }
      } // else we overwrite by default
      catalog.set(identity, fbps);
    },
    partialSupplier: (identity: string) => catalog.get(identity),
    partial: (identity: string) => catalog.get(identity)?.partial,
  };
}

// Render shape from a partial's content()
type PartialRender = Awaited<ReturnType<InjectContentFn>>;

export type FencedBlockInjectable = {
  /** Identical to its underlying partial identity */
  identity: string;
  /** Glob patterns where this injectable applies */
  globs: readonly string[];
  /**
   * Composition mode:
   * - "prepend": wrapper content goes before the matched partial
   * - "append":  wrapper content goes after the matched partial
   * - "both":    wrapper content is added before and after
   */
  mode: "prepend" | "append" | "both";
  /** The wrapper itself; an ordinary partial created via fbPartialCandidate */
  partial: FencedBlockPartial;
};

export type FencedBlockInjectableSupplier = {
  injectable: FencedBlockInjectable;
};

/**
 * Build an Injectable. The injectable's underlying wrapper is created as a normal Partial
 * via fbPartialCandidate — every injectable is a partial.
 *
 * Flags parsed from `info` (via parsedTextComponents):
 *   --inject <glob>   (repeatable; required to target files/paths)
 *   --prepend         (optional; if absent and --append absent, default is "prepend")
 *   --append          (optional; combine with --prepend for "both")
 *
 * Examples:
 *   fbInjectableCandidate("report_wrapper --inject reports/**\/*.sql --prepend", "...wrapper text...");
 *   fbInjectableCandidate("footer --inject **\/*.sql --append", "-- footer");
 *   fbInjectableCandidate("enclose --inject **\/*.sql --prepend --append", "-- begin\n...\n-- end");
 */
export function fbInjectableCandidate(
  info: string,
  content: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    registerIssue: (message: string, content: string, error?: unknown) => void;
  },
): FencedBlockInjectable {
  const parsed = parsedTextComponents(info) ||
    {
      first: info.trim(),
      argv: [],
      flags: () => ({}) as Record<string, unknown>,
    };

  const identity = parsed.first?.trim() ?? info.trim();
  const flags = parsed.flags() as Record<string, unknown>;

  const inject = flags.inject === undefined
    ? []
    : Array.isArray(flags.inject)
    ? flags.inject as string[]
    : [String(flags.inject)];

  const hasFlag = (k: string) =>
    k in flags && flags[k] !== false && flags[k] !== undefined;
  const hasPrepend = hasFlag("prepend");
  const hasAppend = hasFlag("append");

  const mode: FencedBlockInjectable["mode"] = hasPrepend && hasAppend
    ? "both"
    : hasAppend
    ? "append"
    : "prepend"; // default if neither specified

  // Ensure the wrapper itself is a proper Partial (typed & validated)
  const wrapperPartial = fbPartialCandidate(
    identity,
    content,
    zodSchemaSpec,
    init,
  );

  return {
    identity,
    globs: inject,
    mode,
    partial: wrapperPartial,
  };
}

/**
 * Collection/registry for Injectables that also uses an internal Partials collection.
 * When you register an injectable here, its underlying Partial is also registered
 * into the internal fbPartialsCollection to keep a single source of truth.
 */
export function fbInjectablesCollection<
  Supplier extends FencedBlockInjectableSupplier,
>(
  partials = fbPartialsCollection<{ partial: FencedBlockPartial }>(),
  init?: { onDuplicate?: (inj: Supplier) => "overwrite" | "throw" | "ignore" },
) {
  const injectablesCatalog = new Map<string, Supplier>();

  type IndexEntry = {
    identity: string;
    re: RegExp;
    wc: number;
    len: number;
    supplier: Supplier;
  };

  let index: IndexEntry[] = [];

  function wildcardCount(g: string): number {
    const starStar = (g.match(/\*\*/g) ?? []).length * 2;
    const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
    return starStar + singles;
  }

  function toRegex(glob: string): RegExp {
    if (!isGlob(glob)) {
      const exact = normalize(glob).replace(
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

  function rebuildIndex() {
    const entries: IndexEntry[] = [];
    for (const supplier of injectablesCatalog.values()) {
      const inj = supplier.injectable;
      for (const g of inj.globs) {
        const gg = normalize(g);
        entries.push({
          identity: inj.identity,
          re: toRegex(gg),
          wc: wildcardCount(gg),
          len: gg.length,
          supplier,
        });
      }
    }
    index = entries;
  }

  function findInjectableForPath(path?: string): Supplier | undefined {
    if (!path) return;
    const p = normalize(path);
    const hits = index.filter((c) => c.re.test(p));
    if (!hits.length) return;
    // Specificity: fewer wildcards first; then longer literal
    hits.sort((a, b) => (a.wc - b.wc) || (b.len - a.len));
    return hits[0].supplier;
  }

  async function compose(
    // Render result from a content partial
    result: PartialRender,
    // Path for matching + optional onError hook
    ctx?: {
      path?: string;
      onError?: (msg: string, content: string, err?: unknown) => string;
    },
  ): Promise<PartialRender> {
    const supplier = findInjectableForPath(ctx?.path);
    if (!supplier) return result;

    const inj = supplier.injectable;

    // Render the wrapper partial with the same locals
    let wrapperText: string;
    try {
      const wr = await inj.partial.content(result.locals);

      // NEW: if wrapper signals invalid via interpolate=false, treat as failure
      if (!wr.interpolate) {
        const msg = `Injectable '${inj.identity}' failed to render`;
        const text = ctx?.onError
          ? ctx.onError(msg, result.content)
          : `${msg}: wrapper reported invalid arguments`;
        return { content: text, interpolate: false, locals: result.locals };
      }

      wrapperText = wr.content;
    } catch (err) {
      const msg = `Injectable '${inj.identity}' failed to render`;
      const text = ctx?.onError
        ? ctx.onError(msg, result.content, err)
        : `${msg}: ${String(err)}`;
      return { content: text, interpolate: false, locals: result.locals };
    }

    // Compose based on mode
    let merged = result.content;
    if (inj.mode === "prepend" || inj.mode === "both") {
      merged = `${wrapperText}\n${merged}`;
    }
    if (inj.mode === "append" || inj.mode === "both") {
      merged = `${merged}\n${wrapperText}`;
    }

    return {
      content: merged,
      interpolate: result.interpolate,
      locals: result.locals,
    };
  }

  return {
    // expose the underlying partials registry for convenience / inspection
    partials,

    // injectable registry
    catalog: injectablesCatalog,
    register: (inj: Supplier) => {
      const id = inj.injectable.identity;
      const found = injectablesCatalog.get(id);
      if (found && init?.onDuplicate) {
        const onDupe = init.onDuplicate(inj);
        if (onDupe === "throw") {
          throw new Deno.errors.AlreadyExists(
            `Injectable '${id}' defined already, not creating duplicate in fbInjectionsCollection`,
          );
        } else if (onDupe === "ignore") {
          return;
        }
      }
      injectablesCatalog.set(id, inj);

      // Ensure the injectable's underlying partial is also registered
      partials.register({ partial: inj.injectable.partial });

      rebuildIndex();
    },

    injectableSupplier: (identity: string) => injectablesCatalog.get(identity),
    injectable: (identity: string) =>
      injectablesCatalog.get(identity)?.injectable,

    findInjectableForPath,
    compose,
  };
}
