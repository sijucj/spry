export function depsResolver<
  Node extends {
    readonly nodeName: string;
    readonly injectableFlags?: Record<string, unknown>;
  },
>(nodes: Iterable<Node>) {
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

    for (const node of nodes) {
      const flags = node.injectableFlags;
      if (!flags || typeof flags !== "object") continue;
      if (!("injected-dep" in flags)) continue;

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
            errors.push({ taskId: node.nodeName, regEx: expr });
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

      const depName = node.nodeName;
      if (
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
  function deps(
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
    injectedDeps,
    deps,
  };
}
