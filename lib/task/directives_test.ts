// lib/task/directives_test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  bashCodeCellLang,
  denoTaskCodeCellLang,
  safeParseShebang,
  shCodeCellLang,
  spryCodeCellLang,
  type TaskDirective,
  TaskDirectives,
} from "./directives.ts";
import { fbPartialsCollection } from "../universal/md-partial.ts";
import type { Playbook, PlaybookCodeCell } from "../universal/md-playbook.ts";

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
    const td = makeTD();
    const pb = makePlaybook();

    const cell = makeCell({
      language: spryCodeCellLang,
      info: "PARTIAL myPartial",
      source: "echo 'partial-body'",
    });

    const ok = td.register(cell, pb, {});
    assert(ok);
    assertEquals(td.tasks.length, 0);
    const got = td.partial("myPartial");
    assert(got !== undefined);
  });

  await t.step("spry cell -> Cliffy.Command", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const cell = makeCell({
      language: spryCodeCellLang,
      info: "build --flag",
      source: "echo 'spry build'",
    });

    const ok = td.register(cell, pb, {});
    assert(ok);
    assertEquals(td.tasks.length, 1);
    const d = td.tasks[0]!.taskDirective;
    assertEquals(d.nature, "TASK");
    assertEquals(d.identity, "build");
    assertEquals(d.task.strategy, "Cliffy.Command");
    // No direct access to .command without narrowing is needed here.
  });

  await t.step("sh cell without shebang coerces to Deno.Task", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const cell = makeCell({
      language: shCodeCellLang,
      info: "fmt",
      source: "echo 'no shebang so treat as deno-task'",
    });

    const ok = td.register(cell, pb, {});
    assert(ok);
    assertEquals(td.tasks.length, 1);
    const d = td.tasks[0]!.taskDirective;
    assertEquals(d.identity, "fmt");
    assertEquals(d.task.strategy, "Deno.Task");
  });

  await t.step("bash cell with shebang stays Deno.Command + shebang", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const src = "#!/usr/bin/env bash\necho 'hello'";
    const cell = makeCell({
      language: bashCodeCellLang,
      info: "hello",
      source: src,
    });

    const ok = td.register(cell, pb, {});
    assert(ok);
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

  await t.step("onEmptyInfo callback triggers and returns false", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const cell = makeCell({
      language: denoTaskCodeCellLang,
      info: "   ",
      source: "echo nope",
    });

    let called = 0;
    const ok = td.register(cell, pb, {
      onEmptyInfo: () => called++,
    });
    assertFalse(ok);
    assertEquals(called, 1);
  });

  await t.step("onUnknown callback triggers on unsupported language", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const cell = makeCell({
      language: "python",
      info: "py",
      source: "print('x')",
    });

    let called = 0;
    const ok = td.register(cell, pb, {
      onUnknown: () => called++,
    });
    assertFalse(ok);
    assertEquals(called, 1);
  });
});

Deno.test("TaskDirectives.plan()", async (t) => {
  await t.step("builds a stable topological order and layers", () => {
    const td = makeTD();
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

    assert(td.register(A, pb, {}));
    assert(td.register(B, pb, {}));
    assert(td.register(C, pb, {}));
    assert(td.register(D, pb, {}));

    td.tasks[1]!.taskDirective.deps = ["A"]; // B -> A
    td.tasks[2]!.taskDirective.deps = ["A"]; // C -> A
    td.tasks[3]!.taskDirective.deps = ["B", "C"]; // D -> B, C

    const plan = td.plan();
    assertEquals(plan.layers, [["A"], ["B", "C"], ["D"]]);
    assertEquals(
      plan.dag.map((c) => c.taskDirective.identity),
      ["A", "B", "C", "D"],
    );
    assertEquals(plan.unresolved.length, 0);
    assertEquals(plan.missingDeps, {});
  });

  await t.step("captures missing deps without blocking topo", () => {
    const td = makeTD();
    const pb = makePlaybook();

    const E = makeCell({
      language: denoTaskCodeCellLang,
      info: "E",
      source: "echo E",
    });
    assert(td.register(E, pb, {}));

    td.tasks[0]!.taskDirective.deps = ["Z"]; // Z does not exist

    const plan = td.plan();
    assertEquals(plan.missingDeps, { E: ["Z"] });
    assertEquals(plan.dag.map((c) => c.taskDirective.identity), ["E"]);
    assertEquals(plan.unresolved.length, 0);
  });

  await t.step("detects cycles and reports unresolved", () => {
    const td = makeTD();
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

    assert(td.register(A, pb, {}));
    assert(td.register(B, pb, {}));

    td.tasks[0]!.taskDirective.deps = ["B"];
    td.tasks[1]!.taskDirective.deps = ["A"];

    const plan = td.plan();
    assertEquals(plan.layers.length, 0);
    assertEquals(plan.dag.length, 0);
    assertEquals([...plan.unresolved].sort(), ["A", "B"]);
  });

  await t.step("definition order stability for equal-priority nodes", () => {
    const td = makeTD();
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

    assert(td.register(X, pb, {}));
    assert(td.register(Y, pb, {}));
    assert(td.register(Z, pb, {}));

    const plan = td.plan();
    assertEquals(plan.layers, [["X", "Y", "Z"]]);
    assertEquals(plan.dag.map((c) => c.taskDirective.identity), [
      "X",
      "Y",
      "Z",
    ]);
  });
});
