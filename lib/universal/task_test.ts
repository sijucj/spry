import { assertArrayIncludes, assertEquals } from "jsr:@std/assert@^1";
import {
  executeDAG,
  executionPlan,
  type Task,
  type TaskExecutionResult,
} from "./task.ts";

/** Simple test task that implements the required Task interface. */
interface TestTask extends Task {
  run?: () => Promise<void>;
}

const T = (
  id: string,
  deps: string[] = [],
  run?: () => Promise<void>,
): TestTask => ({
  taskId: () => id,
  taskDeps: () => deps,
  run,
});

Deno.test("executionPlan()", async (t) => {
  await t.step(
    "builds ids, byId, edges, layers, dag for an acyclic graph",
    () => {
      // clean -> build -> test
      const tasks = [T("clean"), T("build", ["clean"]), T("test", ["build"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.ids, ["clean", "build", "test"]);
      assertEquals(Object.keys(plan.byId), ["clean", "build", "test"]);
      assertEquals(plan.edges, [
        ["clean", "build"],
        ["build", "test"],
      ]);
      assertEquals(plan.layers, [["clean"], ["build"], ["test"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["clean", "build", "test"]);
      assertEquals(plan.unresolved, []);
      assertEquals(plan.missingDeps, {});
    },
  );

  await t.step(
    "records missing dependencies but excludes them from edges",
    () => {
      const tasks = [T("build", ["clean", "unknown"]), T("clean")];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { build: ["unknown"] });
      assertEquals(plan.edges, [["clean", "build"]]);
    },
  );

  await t.step(
    "deduplicates duplicate dependencies while preserving first occurrence",
    () => {
      const tasks = [
        T("a"),
        T("b"),
        T("c", ["a", "a", "b", "a"]),
      ];
      const plan = executionPlan(tasks);

      assertEquals(plan.indegree["c"], 2);
      assertEquals(plan.edges, [
        ["a", "c"],
        ["b", "c"],
      ]);
    },
  );

  await t.step("stable definition-order tie-breaking in layers and dag", () => {
    const tasks = [T("a"), T("b"), T("c", ["a", "b"])];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers[0], ["a", "b"]);
    assertEquals(plan.dag.map((t) => t.taskId()), ["a", "b", "c"]);
  });

  await t.step("detects cycles and reports unresolved", () => {
    // a -> b -> a (cycle), c independent
    const tasks = [T("a", ["b"]), T("b", ["a"]), T("c")];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers[0], ["c"]);
    assertArrayIncludes(plan.unresolved, ["a", "b"]);
  });

  await t.step("indegree snapshot remains unchanged by execution", async () => {
    const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
    const plan = executionPlan(tasks);
    const snapshotBefore = { ...plan.indegree };

    const summary = await executeDAG(
      plan,
      async (task) => {
        const now = new Date();
        await (task.run?.() ?? Promise.resolve());
        const result: TaskExecutionResult<{ runId: string }> & {
          disposition: "continue";
        } = {
          disposition: "continue",
          ctx: { runId: "t" },
          success: true,
          exitCode: 0,
          startedAt: now,
          endedAt: now,
        };
        return result;
      },
    );

    assertEquals(summary.terminated, false);
    assertEquals(plan.indegree, snapshotBefore);
  });

  // ===== New planning edge cases =====

  await t.step("empty input produces empty plan", () => {
    const plan = executionPlan<TestTask>([]);
    assertEquals(plan.ids, []);
    assertEquals(plan.dag, []);
    assertEquals(plan.layers, []);
    assertEquals(plan.unresolved, []);
    assertEquals(plan.missingDeps, {});
    assertEquals(plan.edges, []);
    assertEquals(plan.adjacency, {});
    assertEquals(plan.indegree, {});
  });

  await t.step("self-dependency results in unresolved with no layers", () => {
    // a depends on itself => no zero-indegree node
    const tasks = [T("a", ["a"])];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers, []); // No wave can start
    assertEquals(plan.dag, []); // No topo
    assertEquals(plan.unresolved, ["a"]); // Stuck node
    assertEquals(plan.missingDeps, {}); // It's declared, not missing
    assertEquals(plan.indegree["a"], 1);
  });

  await t.step(
    "all-missing deps are recorded but do not increase indegree",
    () => {
      const tasks = [T("t", ["x", "y"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { t: ["x", "y"] });
      assertEquals(plan.indegree["t"], 0); // No edges added
      assertEquals(plan.edges, []);
      // With indegree 0, 't' is runnable immediately
      assertEquals(plan.layers, [["t"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["t"]);
      assertEquals(plan.unresolved, []);
    },
  );

  await t.step("large diamond retains definition-stable layers", () => {
    // root -> a, b, c -> leaf
    const tasks = [
      T("root"),
      T("a", ["root"]),
      T("b", ["root"]),
      T("c", ["root"]),
      T("leaf", ["a", "b", "c"]),
    ];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers, [
      ["root"],
      ["a", "b", "c"], // definition order
      ["leaf"],
    ]);
    assertEquals(plan.edges, [
      ["root", "a"],
      ["root", "b"],
      ["root", "c"],
      ["a", "leaf"],
      ["b", "leaf"],
      ["c", "leaf"],
    ]);
  });
});

Deno.test("executeDAG()", async (t) => {
  await t.step(
    "executes tasks in topological order and accumulates a section stack",
    async () => {
      const tasks: TestTask[] = [
        T("clean", [], async () => {}),
        T("build", ["clean"], async () => {}),
        T("test", ["build"], async () => {}),
      ];
      const plan = executionPlan(tasks);

      const order: string[] = [];
      const summary = await executeDAG(
        plan,
        async (task, section) => {
          assertEquals(order.length, section.length);
          const startedAt = new Date();
          await (task.run?.() ?? Promise.resolve());
          order.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "demo" },
            success: true,
            exitCode: 0,
            startedAt,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(summary.terminated, false);
      assertEquals(order, ["clean", "build", "test"]);
      assertEquals(summary.ran, order);
      assertEquals(summary.section.map((f) => f.taskId), order);
      const failures = summary.section.filter((f) => !f.result.success);
      assertEquals(failures.length, 0);
    },
  );

  await t.step(
    "terminates early when executor requests disposition=terminate",
    async () => {
      const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
      const plan = executionPlan(tasks);

      const seen: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const now = new Date();
          seen.push(task.taskId());
          if (task.taskId() === "b") {
            return {
              disposition: "terminate",
              ctx: { runId: "stop" },
              success: true,
              exitCode: 0,
              startedAt: now,
              endedAt: now,
            };
          }
          return {
            disposition: "continue",
            ctx: { runId: "stop" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
      );

      assertEquals(summary.terminated, true);
      assertEquals(seen, ["a", "b"]);
      assertEquals(summary.ran, ["a", "b"]);
    },
  );

  // FIXED: correct expectation — 'y' doesn't get added to `ran` if the executor throws.
  await t.step(
    "synthesizes a failing result and stops if executor throws",
    async () => {
      const tasks = [T("x"), T("y", ["x"])];
      const plan = executionPlan(tasks);

      const executed: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const now = new Date();
          if (task.taskId() === "y") {
            throw new Error("boom");
          }
          executed.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "err" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
      );

      assertEquals(summary.terminated, true);
      assertEquals(summary.ran, ["x"]);
      assertEquals(
        summary.section.map((f) => [f.taskId, f.result.success] as const),
        [["x", true], ["y", false]],
      );
    },
  );

  await t.step(
    "emits predictable releases (dag:release) order when multiple successors unlock",
    async () => {
      const tasks = [
        T("root"),
        T("a", ["root"]),
        T("b", ["root"]),
        T("c", ["a", "b"]),
      ];
      const plan = executionPlan(tasks);

      const releases: Array<{ from: string; to: string[] }> = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "dag:release") releases.push(payload);
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "continue",
            ctx: { runId: "rel" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      assertEquals(releases.length >= 1, true);
      assertEquals(releases[0].from, "root");
      assertEquals(releases[0].to, ["a", "b"]);
    },
  );

  // ===== New execution edge cases =====

  await t.step(
    "continues scheduling when executor returns success:false with disposition:continue",
    async () => {
      // a -> b -> c, mark b as a soft failure but continue
      const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
      const plan = executionPlan(tasks);

      const seen: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const startedAt = new Date();
          seen.push(task.taskId());
          const isSoftFail = task.taskId() === "b";
          return {
            disposition: "continue",
            ctx: { runId: "soft" },
            success: !isSoftFail,
            exitCode: isSoftFail ? 2 : 0,
            startedAt,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(summary.terminated, false);
      assertEquals(summary.ran, ["a", "b", "c"]);
      const successMap = Object.fromEntries(
        summary.section.map((f) => [f.taskId, f.result.success] as const),
      );
      assertEquals(successMap["a"], true);
      assertEquals(successMap["b"], false);
      assertEquals(successMap["c"], true);
    },
  );

  await t.step(
    "early terminate from root does not emit releases for successors",
    async () => {
      // root -> a
      const tasks = [T("root"), T("a", ["root"])];
      const plan = executionPlan(tasks);

      const releases: Array<{ from: string; to: string[] }> = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "dag:release") releases.push(payload);
        },
      };

      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "terminate",
            ctx: { runId: "early" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      assertEquals(summary.terminated, true);
      assertEquals(summary.ran, ["root"]);
      assertEquals(releases.length, 0);
    },
  );

  await t.step(
    "provided ctx is passed through results (via executor)",
    async () => {
      const tasks = [T("a")];
      const plan = executionPlan(tasks);

      const givenCtx = { runId: "given", custom: true } as const;
      // deno-lint-ignore no-explicit-any
      const frames: any[] = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "task:end") frames.push(payload);
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (_task) => {
          const now = new Date();
          return {
            disposition: "continue",
            // deno-lint-ignore no-explicit-any
            ctx: givenCtx as any,
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        // deno-lint-ignore no-explicit-any
        { eventBus: mockBus, ctx: givenCtx as any },
      );

      // Ensure the result ctx matches what executor returned (and we provided).
      assertEquals(frames.length, 1);
      assertEquals(frames[0].result.ctx, givenCtx);
    },
  );

  await t.step(
    "ready-queue stability with delays: roots execute in definition order",
    async () => {
      // Two roots, then a join
      const tasks = [T("a"), T("b"), T("c", ["a", "b"])];
      const plan = executionPlan(tasks);

      const ran: string[] = [];
      await executeDAG(
        plan,
        async (task) => {
          const now = new Date();
          // Introduce different delays; scheduler should still pick a before b
          if (task.taskId() === "a") await new Promise((r) => setTimeout(r, 5));
          if (task.taskId() === "b") await new Promise((r) => setTimeout(r, 1));
          ran.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "delays" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(ran, ["a", "b", "c"]);
    },
  );

  await t.step(
    "event ordering per task: scheduled -> start -> end",
    async () => {
      const tasks = [T("a"), T("b", ["a"])];
      const plan = executionPlan(tasks);

      const events: string[] = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (["task:scheduled", "task:start", "task:end"].includes(type)) {
            events.push(`${type}:${payload.id}`);
          }
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "continue",
            ctx: { runId: "order" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      // Expected sequence:
      // task:scheduled:a, task:start:a, task:end:a, task:scheduled:b, task:start:b, task:end:b
      assertEquals(events, [
        "task:scheduled:a",
        "task:start:a",
        "task:end:a",
        "task:scheduled:b",
        "task:start:b",
        "task:end:b",
      ]);
    },
  );
});

// === More planning edge cases ===
Deno.test("executionPlan()", async (t) => {
  await t.step(
    "mixed missing + existing deps only count existing in indegree",
    () => {
      // a exists; two others are missing
      const tasks = [T("a"), T("t", ["a", "missing1", "missing2"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { t: ["missing1", "missing2"] });
      assertEquals(plan.indegree["t"], 1); // only 'a' contributes
      assertEquals(plan.edges, [["a", "t"]]);
      assertEquals(plan.layers, [["a"], ["t"]]);
      assertEquals(plan.unresolved, []);
    },
  );

  await t.step(
    "multiple disconnected components are stable by definition order",
    () => {
      // Component A: a1 -> a2
      // Component B: b1 -> b2
      // Interleaved definition order should control both layers and dag
      const tasks = [T("a1"), T("b1"), T("a2", ["a1"]), T("b2", ["b1"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.layers, [["a1", "b1"], ["a2", "b2"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["a1", "b1", "a2", "b2"]);
      assertEquals(plan.edges, [
        ["a1", "a2"],
        ["b1", "b2"],
      ]);
    },
  );

  await t.step("very long chain plans correctly and remains stable", () => {
    const N = 200;
    const tasks = Array.from(
      { length: N },
      (_, i) => T(`n${i}`, i === 0 ? [] : [`n${i - 1}`]),
    );
    const plan = executionPlan(tasks);

    // ids and dag should match exactly; each layer has a single node
    assertEquals(plan.ids.length, N);
    assertEquals(plan.dag.map((t) => t.taskId()), plan.ids);
    assertEquals(plan.layers.length, N);
    assertEquals(plan.layers[0], ["n0"]);
    assertEquals(plan.layers[N - 1], [`n${N - 1}`]);
    assertEquals(plan.unresolved, []);
  });
});
