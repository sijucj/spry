/**
 * unsafeInterpolator(ctx, { useCache?, ctxName? })
 * Dynamic, full-power template-literal interpolation with a configurable
 * context variable name exposed inside the template (default: `ctx`).
 *
 * SECURITY WARNING: Executes arbitrary JS in template expressions.
 * Use ONLY with trusted templates and data.
 */

/* ---------------------------
   Example (trusted template)
---------------------------
type Ctx = { app: string; version: string; util: { up: (s: string) => string } };

const { interpolate } = unsafeInterpolator<Ctx>(
  { app: "Spry", version: "2.4.0", util: { up: (s) => s.toUpperCase() } },
  { useCache: true, ctxName: "globals" }, // expose as `globals` instead of `ctx`
);

const out = interpolate(
  "Hello ${user}! ${globals.app}@${globals.version} -> ${globals.util.up(user)} sum=${a+b}",
  { user: "Zoya", a: 2, b: 3 },
);
// -> "Hello Zoya! Spry@2.4.0 -> ZOYA sum=5"
*/

export type UnsafeInterpolatorConfig = {
  /** Enable function caching per (template, local-keys-signature, ctxName). Default: true */
  useCache?: boolean;
  /** Identifier presented to templates for the bound global context. Default: "ctx" */
  ctxName?: string;
  /** How many partials or recursions can be stacked */
  recursionLimit?: number;
};

export function unsafeInterpolator<Context extends Record<string, unknown>>(
  ctx: Readonly<Context>,
  { useCache = true, ctxName = "ctx", recursionLimit = 9 }:
    UnsafeInterpolatorConfig = {},
) {
  const IDENT_RX = /^[A-Za-z_$][\w$]*$/;

  const assertValidIdentifier = (name: string, label = "identifier") => {
    if (!IDENT_RX.test(name)) {
      throw new Error(
        `Invalid ${label} "${name}". Use a simple JavaScript identifier.`,
      );
    }
  };

  assertValidIdentifier(ctxName, "ctxName");

  // cache: template -> ctxName -> sig -> compiled
  const cache = new Map<
    string,
    Map<
      string,
      Map<string, (c: Context, l: Record<string, unknown>) => Promise<string>>
    >
  >();

  function compile(source: string, keys: readonly string[]) {
    // Guard against local keys colliding with ctxName.
    if (keys.includes(ctxName)) {
      throw new Error(
        `Local key "${ctxName}" conflicts with ctxName. Rename the local or choose a different ctxName.`,
      );
    }

    // Validate local identifiers (we promote them to top-level consts).
    for (const k of keys) assertValidIdentifier(k, `local key`);

    // Escape for embedding within a backticked template in generated code.
    const safe = source.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

    // Promote locals as real identifiers.
    const decls = keys
      .map((k) => `const ${k} = __l[${JSON.stringify(k)}];`)
      .join("\n");

    // Expose the context under the chosen name.
    const ctxDecl = `const ${ctxName} = __ctx;`;

    const body = [
      `"use strict";`,
      decls,
      ctxDecl,
      `return \`${safe}\`;`,
    ].join("\n");

    // 👇 Create the AsyncFunction constructor once
    const AsyncFunction =
      Object.getPrototypeOf(async function () {}).constructor;

    // 👇 Use it instead of new Function
    return new AsyncFunction(
      "__ctx",
      "__l",
      body,
    ) as (c: Context, l: Record<string, unknown>) => Promise<string>;
  }

  async function interpolate<LocalContext extends Record<string, unknown>>(
    template: string,
    locals: Readonly<LocalContext>,
    stack?: { template: string }[],
  ): Promise<string> {
    if (stack && stack.length > recursionLimit) {
      return `Recursion stack exceeded max: ${recursionLimit} (${
        stack.map((s) => s.template).join(" → ")
      })`;
    }

    const keys = Object.keys(locals);
    const sig = keys.slice().sort().join("|");

    if (!useCache) {
      const fn = compile(template, keys);
      return fn(ctx, locals as Record<string, unknown>);
    }

    let byCtx = cache.get(template);
    if (!byCtx) {
      byCtx = new Map();
      cache.set(template, byCtx);
    }

    let bySig = byCtx.get(ctxName);
    if (!bySig) {
      bySig = new Map();
      byCtx.set(ctxName, bySig);
    }

    let fn = bySig.get(sig);
    if (!fn) {
      fn = compile(template, keys);
      bySig.set(sig, fn);
    }

    return await fn(ctx, locals as Record<string, unknown>);
  }

  return { interpolate, ctx };
}
