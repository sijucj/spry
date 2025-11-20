/**
 * CodeSpawnable is a structured enrichment type for remark `code` nodes.
 * It uses fenced code blocks enriched with CodeFrontmatter for PI, and
 * attaches executable functionality that marks the `code` "spawnable" as
 * an executable.
 */

import z from "@zod/zod";
import type { Code, Root, RootContent } from "types/mdast";
import { visit } from "unist-util-visit";
import { languageRegistry, LanguageSpec } from "../../../universal/code.ts";
import { PosixPIQuery } from "../../../universal/posix-pi.ts";
import {
  CodeWithFrontmatterData,
  isCodeWithFrontmatterNode,
} from "./code-frontmatter.ts";
import { isCodePartialNode } from "./code-partial.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

/** The structured enrichment attached to a code node by this plugin. */
export type CodeSpawnable<PiFlagsShape extends Record<string, unknown>> = {
  readonly identity: string;
  readonly pi: PosixPIQuery<PiFlagsShape>;
};

export const CODESPAWNABLE_KEY = "codeSpawnable" as const;
export type CodeSpawnableData<PiFlagsShape extends Record<string, unknown>> =
  & CodeWithFrontmatterData
  & {
    readonly codeSpawnable: CodeSpawnable<PiFlagsShape>;
    [key: string]: unknown;
  };

export type CodeSpawnableNode<PiFlagsShape extends Record<string, unknown>> =
  & Code
  & { data: CodeSpawnableData<PiFlagsShape> };

/**
 * Type guard: returns true if a `RootContent` node is a `code` node
 * that already carries CodeSpawnable data at the default store key.
 */
export function isCodeSpawnableNode<
  PiFlagsShape extends Record<string, unknown> = Record<string, unknown>,
>(
  node: RootContent,
): node is CodeSpawnableNode<PiFlagsShape> {
  if (node.type === "code" && node.data && CODESPAWNABLE_KEY in node.data) {
    return true;
  }
  return false;
}

/** Configuration options for the CodeFrontmatter plugin. */
export interface CodeSpawnableOptions<
  PiFlagsShape extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Return true if this code is spawnable.
   */
  readonly isSpawnable?: (code: Code) => false | { language: LanguageSpec };
  /**
   * If defined, this callback is called whenever code cells are enriched
   */
  readonly collect?: (node: CodeSpawnableNode<PiFlagsShape>) => void;

  /**
   * Optional Zod schema describing the expected shape of `pi.flags`.
   *
   * When provided:
   * - `safeFlags()` uses `schema.safeParse(pi.flags)` and returns the
   *   usual Zod-safe-parse result, typed as `FlagsShape`.
   * - `flags()` calls `safeFlags()` and:
   *    - returns `data` when `success === true`,
   *    - throws a ZodError with extra context when `success === false`.
   *
   * When omitted:
   * - `safeFlags()` returns `{ success: true, data: pi.flags as FlagsShape }`.
   * - `flags()` returns `pi.flags as FlagsShape`.
   */
  piFlagsZodSchema?: z.ZodType<PiFlagsShape>;
}

/**
 * CodeFrontmatter remark plugin.
 *
 * @param options - See {@link CodeSpawnableOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link CodeSpawnable}.
 *
 * @example
 * ```ts
 * import { remark } from "remark";
 * import codeFrontmatter from "./code-frontmatter.ts";
 *
 * const processor = remark().use(codeFrontmatter, {
 *   normalizeFlagKey: (k) => k.toLowerCase(),
 *   onAttrsParseError: "ignore",
 *   coerceNumbers: true,
 * });
 *
 * const tree = processor.parse("```bash --env prod { ok: true }\necho\n```");
 * // Walk to a code node and read `node.data.codeFrontmatter`.
 * ```
 */
export default function codeSpawnable(options: CodeSpawnableOptions = {}) {
  const {
    isSpawnable = (code) =>
      spawnableLangSpecs.find((lang) =>
        lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
      ),
    collect,
  } = options;

  return function transformer(tree: Root) {
    visit(tree, "code", (node) => {
      if (
        isSpawnable(node) && isCodeWithFrontmatterNode(node) &&
        !isCodePartialNode(node)
      ) {
        // spawnable code nodes must have at least an identifier
        if (node.data.codeFM.pi.posCount) {
          // deno-lint-ignore no-explicit-any
          const untypedNode = node as any;
          const data = (untypedNode.data ??= {});
          if (!data[CODESPAWNABLE_KEY]) {
            const ppiq = node.data.codeFM.queryPI();
            const cs: CodeSpawnable<Record<string, unknown>> = {
              identity: ppiq.getFirstBareWord()!,
              pi: ppiq,
            };
            data[CODESPAWNABLE_KEY] = cs;
          }
          collect?.(node as CodeSpawnableNode<Record<string, unknown>>);
        }
      }
    });
  };
}

/**
 * Unified collection of Partials. It also maintains an index for injectable
 * matching (by glob) and exposes a `compose` helper to apply the best-match
 * wrapper around a rendered content partial’s result.
 */
export function codeSpawnableCollection<
  PiFlagsShape extends Record<string, unknown> = Record<string, unknown>,
>() {
  const catalog = new Map<string, CodeSpawnableNode<PiFlagsShape>>();

  /**
   * Find tasks that should be *implicitly* injected as dependencies of `taskId`
   * based on other tasks' `--injected-dep` flags, and report invalid regexes.
   *
   * Behavior:
   *
   * - Any task may declare `--injected-dep`. The value can be:
   *   - boolean true  → means ["*"] (match all taskIds)
   *   - string        → treated as [that string]
   *   - string[]      → used as-is
   *
   * - Each string is treated as a regular expression source. We compile all of them
   *   once and cache them in `t.parsedPI.flags[".injected-dep-cache"]` as `RegExp[]`.
   *
   * - Special case: "*" means "match everything", implemented as `/.*\/`.
   *
   * - If ANY compiled regex for task `t` matches the given `taskId`, then that task’s
   *   `parsedPI.firstToken` (the task's own name/id) will be considered an injected
   *   dependency. It will be added to the returned `injected` list unless it is already
   *   present in `taskDeps` or already added.
   *
   * Reliability:
   *
   * - The only error we surface is regex compilation failure. If a pattern cannot be
   *   compiled, it is skipped and recorded in `errors` as `{ taskId, regEx }`.
   *
   * - No exceptions propagate. Bad inputs are ignored safely.
   *
   * Assumptions:
   *
   * - `this.tasks` exists and is an array of task-like code cells.
   * - Each task that participates has `parsedPI.firstToken` (string task name) and
   *   `parsedPI.flags` (an object).
   *
   * @param taskId The task identifier we are resolving deps for.
   *
   * @param taskDeps Existing, explicit dependencies for this task. Used only for de-duping.
   *
   * @example
   * ```ts
   * const { injected, errors } = this.injectedDeps("build", ["clean"]);
   * // injected could be ["lint","compile"]
   * // errors could be [{ taskId: "weirdTask", regEx: "(" }]
   * ```
   */
  function injectedDeps(
    taskId: string,
    taskDeps: string[] = [],
  ) {
    const injected: string[] = [];
    const errors: { taskId: string; regEx: string }[] = [];

    // normalize taskDeps just in case caller passed something weird
    const safeTaskDeps = Array.isArray(taskDeps) ? taskDeps : [];

    for (const t of catalog.values()) {
      const qpi = t.data.codeFM.queryPI();
      if (!qpi.pi.posCount) continue; // no cell identifier
      const cellName = qpi.getFirstBareWord();

      const flags = qpi.pi.flags;
      if (!flags || typeof flags !== "object") continue;

      if (!qpi.hasFlag("injected-dep")) continue;

      // Normalize `--injected-dep` forms into an array of string patterns
      const diFlag = flags["injected-dep"];
      let di: string[] = [];

      if (typeof diFlag === "boolean") {
        if (diFlag === true) {
          di = ["*"];
        }
      } else if (typeof diFlag === "string") {
        di = [diFlag];
      } else if (Array.isArray(diFlag)) {
        di = diFlag.filter((x) => typeof x === "string");
      }

      if (di.length === 0) continue;

      // Compile/cache regexes if not already done
      if (!Array.isArray(flags[".injected-dep-cache"])) {
        const compiledList: RegExp[] = [];

        for (const expr of di) {
          const source = expr === "*" ? ".*" : expr;

          try {
            compiledList.push(new RegExp(source));
          } catch {
            // Record invalid regex source
            errors.push({
              taskId: typeof cellName === "string" && cellName
                ? cellName
                : "(unknown-task)",
              regEx: expr,
            });
            // skip adding invalid one
          }
        }

        // deno-lint-ignore no-explicit-any
        (flags as any)[".injected-dep-cache"] = compiledList;
      }

      // deno-lint-ignore no-explicit-any
      const cached = (flags as any)[".injected-dep-cache"] as RegExp[];

      if (!Array.isArray(cached) || cached.length === 0) {
        // nothing valid compiled, move on
        continue;
      }

      // Check whether ANY of the compiled regexes matches the requested taskId
      let matches = false;
      for (const re of cached) {
        if (re instanceof RegExp && re.test(taskId)) {
          matches = true;
          break;
        }
      }

      if (!matches) continue;

      // Inject this task's firstToken (the task name)
      const depName = cellName;
      if (
        typeof depName === "string" &&
        depName.length > 0 &&
        !safeTaskDeps.includes(depName) &&
        !injected.includes(depName)
      ) {
        injected.push(depName);
      }
    }

    return { injected, errors };
  }

  /**
   * Returns a merged list of explicit and injected dependencies for a given task.
   *
   * This is a lightweight wrapper around {@link injectedDeps} that merges
   * the explicitly declared `taskDeps` (if any) with automatically injected
   * dependencies discovered via `--injected-dep` flags on other tasks.
   *
   * Results are cached per `taskId` in the provided `cellDepsCache` map.
   *
   * @param taskId The task identifier to resolve dependencies for.
   *
   * @param taskDeps Optional list of explicitly declared dependencies for this task.
   *
   * @param cellDepsCache Cache map used to store and retrieve previously resolved dependency lists.
   *
   * @returns A unique, ordered list of merged dependencies for the given `taskId`.
   *
   * @example
   * ```ts
   * const cache = new Map<string, string[]>();
   * const deps = this.cellDeps("build", ["clean"], cache);
   * // => ["clean", "compile", "lint"]
   * ```
   */
  function taskDeps(
    taskId: string,
    taskDeps: string[] | undefined,
    cellDepsCache?: Map<string, string[]>,
  ) {
    // Return cached value if available
    if (cellDepsCache) {
      const cached = cellDepsCache.get(taskId);
      if (cached) return cached;
    }

    // Compute injected dependencies
    const { injected } = injectedDeps(taskId, taskDeps ?? []);

    // Merge explicit + injected dependencies, ensuring uniqueness and order
    const merged = Array.from(
      new Set([...injected, ...(taskDeps ?? [])]),
    );

    // Cache and return result
    cellDepsCache?.set(taskId, merged);
    return merged;
  }

  return {
    catalog,

    register: (
      csn: CodeSpawnableNode<PiFlagsShape>,
      onDuplicate?: (
        csn: CodeSpawnableNode<PiFlagsShape>,
      ) => "overwrite" | "throw" | "ignore",
    ) => {
      const identity = csn.data.codeSpawnable.identity;
      const found = catalog.get(identity);
      if (found && onDuplicate) {
        const action = onDuplicate(csn);
        if (action === "throw") {
          throw new Deno.errors.AlreadyExists(
            `CodeSpawnable '${identity}' already exists in codeSpawnableCollection`,
          );
        }
        if (action === "ignore") return;
        // overwrite on "overwrite"
      }
      catalog.set(identity, csn);
    },

    get: (identity: string) => catalog.get(identity),
    taskDeps,
  };
}
