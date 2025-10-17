import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { eventBus } from "../universal/event-bus.ts";
import { fbPartialsCollection } from "../universal/md-partial.ts";
import type { Playbook, PlaybookCodeCell } from "../universal/md-playbook.ts";
import {
  bashCodeCellLang,
  denoTaskCodeCellLang,
  denoTaskParser,
  executeDAG,
  executionPlan,
  safeParseShebang,
  shCodeCellLang,
  spawnableParser,
  spryCodeCellLang,
  spryParser,
  type TaskDirective,
  TaskDirectives,
  TaskExecEventMap,
  TaskExecutionResult,
} from "./mod.ts";

type Prov = string;
type CellAttrs = Record<string, unknown>;

function makePlaybook(): Playbook<
  Prov,
  Record<string, unknown>,
  CellAttrs,
  never
> {
  // Only the bit used in registerIssue paths is needed
  return { notebook: { provenance: "test-prov" } } as unknown as Playbook<
    Prov,
    Record<string, unknown>,
    CellAttrs,
    never
  >;
}

function makeCell(partial: {
  language: string;
  info?: string;
  source: string;
  attrs?: CellAttrs;
  startLine?: number;
  endLine?: number;
}): PlaybookCodeCell<Prov, CellAttrs> {
  return {
    kind: "code",
    provenance: "test-prov",
    language: partial.language,
    info: partial.info,
    source: partial.source,
    attrs: partial.attrs ?? {},
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? 1,
  };
}

function makeTD() {
  // IMPORTANT: supply the generic, not a schema
  const partials = fbPartialsCollection<
    Extract<TaskDirective, { nature: "PARTIAL" }>
  >();
  return new TaskDirectives<Prov>(partials);
}

Deno.test("safeParseShebang", async (t) => {
  await t.step("returns object when starts with #!", () => {
    const src = "#!/usr/bin/env bash\necho hi";
    const res = safeParseShebang(src);
    assert(res !== false);
    assertEquals(res.shebang, "#!/usr/bin/env bash");
    assertEquals(res.source.trim(), "echo hi");
  });

  await t.step("returns false when no shebang", () => {
    const src = "echo hi";
    const res = safeParseShebang(src);
    assertFalse(res);
  });
});

Deno.test("TaskDirectives.register()", async (t) => {
  await t.step("registers PARTIAL and is retrievable", () => {
    const td = makeTD(); // partialsInspector is installed by default
    const pb = makePlaybook();

    const cell = makeCell({
      language: spryCodeCellLang,
      info: "PARTIAL myPartial",
      source: "echo 'partial-body'",
    });

    assert(td.register(cell, pb));
    assertEquals(td.tasks.length, 0);
    const got = td.partial("myPartial");
    assert(got !== undefined);
  });

  await t.step("spry cell -> Cliffy.Command", () => {
    const td = makeTD().use(spryParser()); // register spry inspector
    const pb = makePlaybook();

    const cell = makeCell({
      language: spryCodeCellLang,
      info: "build --flag",
      source: "echo 'spry build'",
    });

    assert(td.register(cell, pb));
    assertEquals(td.tasks.length, 1);
    const d = td.tasks[0]!.taskDirective;
    assertEquals(d.nature, "TASK");
    assertEquals(d.identity, "build");
    assertEquals(d.task.strategy, "Cliffy.Command");
  });

  await t.step(
    "sh cell without shebang -> Deno.Command (shebang:false)",
    () => {
      const td = makeTD().use(spawnableParser()); // register shell inspector
      const pb = makePlaybook();

      const cell = makeCell({
        language: shCodeCellLang,
        info: "fmt",
        source: "echo 'no shebang so spawn as command'",
      });

      assert(td.register(cell, pb));
      assertEquals(td.tasks.length, 1);
      const d = td.tasks[0]!.taskDirective;
      assertEquals(d.identity, "fmt");
      assertEquals(d.task.strategy, "Deno.Command");
      if (d.task.strategy === "Deno.Command") {
        assertEquals(d.task.command, "bash");
        assertEquals(d.task.shebang, false);
      }
    },
  );

  await t.step("bash cell with shebang stays Deno.Command + shebang", () => {
    const td = makeTD().use(spawnableParser()); // register shell inspector
    const pb = makePlaybook();

    const src = "#!/usr/bin/env bash\necho 'hello'";
    const cell = makeCell({
      language: bashCodeCellLang,
      info: "hello",
      source: src,
    });

    assert(td.register(cell, pb));
    assertEquals(td.tasks.length, 1);
    const d = td.tasks[0]!.taskDirective;

    assertEquals(d.identity, "hello");
    assertEquals(d.task.strategy, "Deno.Command");
    if (d.task.strategy === "Deno.Command") {
      assertEquals(d.task.command, "bash");
      assert(d.task.shebang !== false);
      assertEquals(d.task.shebang.shebang, "#!/usr/bin/env bash");
    }
  });

  await t.step("onUnknown callback triggers on unsupported language", () => {
    const td = makeTD(); // no python inspector installed
    const pb = makePlaybook();

    const cell = makeCell({
      language: "python",
      info: "py",
      source: "print('x')",
    });

    let called = 0;
    assertFalse(td.register(cell, pb, {
      onUnknown: () => called++,
    }));
    assertEquals(td.tasks.length, 0);
    assertEquals(called, 1);
  });
});

Deno.test("TaskDirectives.plan()", async (t) => {
  await t.step("builds a stable topological order and layers", () => {
    const td = makeTD().use(denoTaskParser()); // register deno task inspector
    const pb = makePlaybook();

    // A, B(dep:A), C(dep:A), D(dep:B,C)
    const A = makeCell({
      language: denoTaskCodeCellLang,
      info: "A",
      source: "echo A",
    });
    const B = makeCell({
      language: denoTaskCodeCellLang,
      info: "B",
      source: "echo B",
    });
    const C = makeCell({
      language: denoTaskCodeCellLang,
      info: "C",
      source: "echo C",
    });
    const D = makeCell({
      language: denoTaskCodeCellLang,
      info: "D",
      source: "echo D",
    });

    assert(td.register(A, pb));
    assert(td.register(B, pb));
    assert(td.register(C, pb));
    assert(td.register(D, pb));

    td.tasks[1]!.taskDirective.deps = ["A"]; // B -> A
    td.tasks[2]!.taskDirective.deps = ["A"]; // C -> A
    td.tasks[3]!.taskDirective.deps = ["B", "C"]; // D -> B, C

    const plan = executionPlan(td.tasks);
    assertEquals(plan.layers, [["A"], ["B", "C"], ["D"]]);
    assertEquals(
      plan.dag.map((c) => c.taskDirective.identity),
      ["A", "B", "C", "D"],
    );
    assertEquals(plan.unresolved.length, 0);
    assertEquals(plan.missingDeps, {});
  });

  await t.step("captures missing deps without blocking topo", () => {
    const td = makeTD().use(denoTaskParser());
    const pb = makePlaybook();

    const E = makeCell({
      language: denoTaskCodeCellLang,
      info: "E",
      source: "echo E",
    });
    assert(td.register(E, pb));

    td.tasks[0]!.taskDirective.deps = ["Z"]; // Z does not exist

    const plan = executionPlan(td.tasks);
    assertEquals(plan.missingDeps, { E: ["Z"] });
    assertEquals(plan.dag.map((c) => c.taskDirective.identity), ["E"]);
    assertEquals(plan.unresolved.length, 0);
  });

  await t.step("detects cycles and reports unresolved", () => {
    const td = makeTD().use(denoTaskParser());
    const pb = makePlaybook();

    const A = makeCell({
      language: denoTaskCodeCellLang,
      info: "A",
      source: "echo A",
    });
    const B = makeCell({
      language: denoTaskCodeCellLang,
      info: "B",
      source: "echo B",
    });

    assert(td.register(A, pb));
    assert(td.register(B, pb));

    td.tasks[0]!.taskDirective.deps = ["B"];
    td.tasks[1]!.taskDirective.deps = ["A"];

    const plan = executionPlan(td.tasks);
    assertEquals(plan.layers.length, 0);
    assertEquals(plan.dag.length, 0);
    assertEquals([...plan.unresolved].sort(), ["A", "B"]);
  });

  await t.step("definition order stability for equal-priority nodes", () => {
    const td = makeTD().use(denoTaskParser());
    const pb = makePlaybook();

    const X = makeCell({
      language: denoTaskCodeCellLang,
      info: "X",
      source: "echo X",
    });
    const Y = makeCell({
      language: denoTaskCodeCellLang,
      info: "Y",
      source: "echo Y",
    });
    const Z = makeCell({
      language: denoTaskCodeCellLang,
      info: "Z",
      source: "echo Z",
    });

    assert(td.register(X, pb));
    assert(td.register(Y, pb));
    assert(td.register(Z, pb));

    const plan = executionPlan(td.tasks);
    assertEquals(plan.layers, [["X", "Y", "Z"]]);
    assertEquals(plan.dag.map((c) => c.taskDirective.identity), [
      "X",
      "Y",
      "Z",
    ]);
  });
});

Deno.test("executeDAG", async (t) => {
  type Ctx = { runId: string };

  // helper inside tests
  const ok = <C>(ctx: C) => ({
    ctx,
    ok: true,
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    startedAt: new Date(),
    endedAt: new Date(),
  } satisfies TaskExecutionResult<C>);

  function makeDAGABC() {
    const td = makeTD().use(denoTaskParser());
    const pb = makePlaybook();

    // A -> B -> C
    const A = makeCell({
      language: denoTaskCodeCellLang,
      info: "A",
      source: "echo A",
    });
    const B = makeCell({
      language: denoTaskCodeCellLang,
      info: "B",
      source: "echo B",
    });
    const C = makeCell({
      language: denoTaskCodeCellLang,
      info: "C",
      source: "echo C",
    });

    assert(td.register(A, pb));
    assert(td.register(B, pb));
    assert(td.register(C, pb));

    td.tasks[1]!.taskDirective.deps = ["A"]; // B depends on A
    td.tasks[2]!.taskDirective.deps = ["B"]; // C depends on B

    return executionPlan(td.tasks);
  }

  await t.step(
    "runs in dependency order and builds section stack",
    async () => {
      const plan = makeDAGABC();

      // capture events
      const bus = eventBus<TaskExecEventMap<string, { runId: string }>>();
      const starts: string[] = [];
      const ends: string[] = [];
      const releases: Array<{ from: string; to: string[] }> = [];
      bus.on("task:start", (e) => {
        starts.push(e.id);
      });
      bus.on("task:end", (e) => {
        ends.push(e.id);
      });
      bus.on(
        "dag:release",
        (e) => {
          releases.push({ from: e.from, to: [...e.to] });
        },
      );

      // capture section lengths observed inside execute()
      const seenLen = new Map<string, number>();

      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task, section) => {
          // section is the stack of already-completed tasks (readonly)
          seenLen.set(task.taskDirective.identity, section.length);
          return { ...ok({ runId: "t1" }), disposition: "continue" };
        },
        { eventBus: bus, ctx: { runId: "t1" } as Ctx },
      );

      assertEquals(summary.ran, ["A", "B", "C"]);
      assertEquals(summary.terminated, false);

      // Verify section frames
      assertEquals(summary.section.length, 3);
      assertEquals(
        summary.section.map((f) => f.id),
        ["A", "B", "C"],
      );
      for (const f of summary.section) assertEquals(f.result.ok, true);

      // Inside-execute section sizes before each task ran
      assertEquals(seenLen.get("A"), 0);
      assertEquals(seenLen.get("B"), 1);
      assertEquals(seenLen.get("C"), 2);

      // Event sequencing basics
      assertEquals(starts, ["A", "B", "C"]);
      assertEquals(ends, ["A", "B", "C"]);
      assertEquals(releases.length, 2);
      assertEquals(releases[0], { from: "A", to: ["B"] });
      assertEquals(releases[1], { from: "B", to: ["C"] });
    },
  );

  await t.step("terminates early when execute() requests it", async () => {
    const plan = makeDAGABC();

    const bus = eventBus<TaskExecEventMap<string, { runId: string }>>();
    const starts: string[] = [];
    bus.on("task:start", (e) => {
      starts.push(e.id);
    });

    const seenLen = new Map<string, number>();

    const summary = await executeDAG(
      plan,
      // deno-lint-ignore require-await
      async (task, section) => {
        const id = task.taskDirective.identity;
        seenLen.set(id, section.length);
        if (id === "B") {
          return { ...ok({ runId: "t2" }), disposition: "terminate" };
        }
        return { ...ok({ runId: "t2" }), disposition: "continue" };
      },
      { eventBus: bus, ctx: { runId: "t2" } as Ctx },
    );

    // A runs, B runs (and terminates), C never runs
    assertEquals(summary.ran, ["A", "B"]);
    assertEquals(summary.terminated, true);

    // Section contains frames for A and B only (B recorded as ok by the engine’s synthesized result)
    assertEquals(summary.section.map((f) => f.id), ["A", "B"]);

    // Section lengths observed inside execute()
    assertEquals(seenLen.get("A"), 0);
    assertEquals(seenLen.get("B"), 1);
    assertEquals(seenLen.has("C"), false);

    // Starts were emitted for A and B only
    assertEquals(starts, ["A", "B"]);
  });

  await t.step(
    "definition-order stability for multiple ready nodes",
    async () => {
      // Build a DAG with independent nodes: X, Y, Z (no deps)
      const td = makeTD().use(denoTaskParser());
      const pb = makePlaybook();

      const X = makeCell({
        language: denoTaskCodeCellLang,
        info: "X",
        source: "echo X",
      });
      const Y = makeCell({
        language: denoTaskCodeCellLang,
        info: "Y",
        source: "echo Y",
      });
      const Z = makeCell({
        language: denoTaskCodeCellLang,
        info: "Z",
        source: "echo Z",
      });

      assert(td.register(X, pb));
      assert(td.register(Y, pb));
      assert(td.register(Z, pb));

      const plan = executionPlan(td.tasks);

      const bus = eventBus<TaskExecEventMap<string, { runId: string }>>();
      const starts: string[] = [];
      bus.on("task:start", (e) => {
        starts.push(e.id);
      });

      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => ({ ...ok({ runId: "t3" }), disposition: "continue" }),
        { eventBus: bus, ctx: { runId: "t3" } as Ctx },
      );

      // Preserve definition order for nodes of equal priority
      assertEquals(summary.ran, ["X", "Y", "Z"]);
      assertEquals(starts, ["X", "Y", "Z"]);
      assertEquals(summary.terminated, false);
      assertEquals(summary.section.map((f) => f.id), ["X", "Y", "Z"]);
    },
  );
});
