import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  fbInjectableCandidate,
  fbInjectablesCollection,
  fbPartialCandidate,
  fbPartialsCollection,
  type FencedBlockInjectable,
  type FencedBlockPartial,
} from "./md-partial.ts";

Deno.test("fbPartialCandidate", async (t) => {
  await t.step(
    "returns content with interpolate=true and preserves locals",
    async () => {
      const p = fbPartialCandidate("hello", "Hi there!");
      const res = await p.content({ who: "world" });
      assertEquals(res.content, "Hi there!");
      assertEquals(res.interpolate, true);
      assertEquals(res.locals, { who: "world" });
    },
  );

  await t.step(
    "validates locals when argsZodSchemaSpec provided (success)",
    async () => {
      const p = fbPartialCandidate(
        "with-schema",
        "OK",
        { who: { type: "string" } },
      );
      const res = await p.content({ who: "Alice" });
      assertEquals(res.content, "OK");
      assertEquals(res.interpolate, true);
    },
  );

  await t.step(
    "validates locals when argsZodSchemaSpec provided (failure)",
    async () => {
      const p = fbPartialCandidate(
        "with-schema",
        "SHOULD NOT SEE",
        { who: { type: "string" } },
      );
      const res = await p.content({ who: 42 });
      assertFalse(res.interpolate);
      assertMatch(
        res.content,
        /Invalid arguments passed to partial 'with-schema'/,
      );
      assertMatch(res.content, /expected arguments/);
    },
  );

  await t.step("invokes registerIssue on invalid zod schema", () => {
    let called = false;
    const p = fbPartialCandidate(
      "bad-schema",
      "text",
      // Bad: properties must be a record; shove nonsense to trigger error
      { $bad: "not-real" } as unknown as Record<string, unknown>,
      {
        registerIssue: (msg, content, err) => {
          called = true;
          assertMatch(msg, /Invalid Zod schema spec/);
          assertEquals(content, "text");
          assert(err);
        },
      },
    );
    // It still returns a partial; schema is simply not applied
    assertEquals(p.identity, "bad-schema");
    assertEquals(typeof p.content, "function");
    assert(called);
  });
});

Deno.test("fbPartialsCollection", async (t) => {
  await t.step("register + fetch by identity", () => {
    const col = fbPartialsCollection<{ partial: FencedBlockPartial }>();
    const p = fbPartialCandidate("p1", "one");
    col.register({ partial: p });
    assertEquals(col.partial("p1")?.identity, "p1");
  });

  await t.step("duplicate behavior: default overwrite", async () => {
    const col = fbPartialsCollection<{ partial: FencedBlockPartial }>();
    col.register({ partial: fbPartialCandidate("dup", "first") });
    col.register({ partial: fbPartialCandidate("dup", "second") });
    const res = await col.partial("dup")!.content({});
    assertEquals(res.content, "second"); // overwritten
  });

  await t.step("duplicate behavior: throw", () => {
    const col = fbPartialsCollection<{ partial: FencedBlockPartial }>({
      onDuplicate: () => "throw",
    });
    col.register({ partial: fbPartialCandidate("dup", "first") });

    assertThrows(
      () => col.register({ partial: fbPartialCandidate("dup", "second") }),
      Deno.errors.AlreadyExists,
    );
  });

  await t.step("duplicate behavior: ignore", async () => {
    const col = fbPartialsCollection<{ partial: FencedBlockPartial }>({
      onDuplicate: () => "ignore",
    });
    col.register({ partial: fbPartialCandidate("dup", "first") });
    col.register({ partial: fbPartialCandidate("dup", "second") });
    const res = await col.partial("dup")!.content({});
    assertEquals(res.content, "first"); // ignored second
  });
});

Deno.test("Injectables (every injectable is also a partial)", async (t) => {
  await t.step("candidate parses flags and defaults to prepend", async () => {
    const inj = fbInjectableCandidate(
      "wrap1 --inject reports/**/*.sql", // no explicit --prepend/--append => defaults to prepend
      "-- header",
    );
    assertEquals(inj.identity, "wrap1");
    assertEquals(inj.globs, ["reports/**/*.sql"]);
    assertEquals(inj.mode, "prepend");
    // underlying partial is a proper partial
    const pr = await inj.partial.content({});
    assertEquals(pr.content, "-- header");
  });

  await t.step("append only", () => {
    const inj = fbInjectableCandidate(
      "footer --inject **/*.sql --append",
      "-- footer",
    );
    assertEquals(inj.mode, "append");
  });

  await t.step("both prepend and append", () => {
    const inj = fbInjectableCandidate(
      "enclose --inject **/*.sql --prepend --append",
      "-- begin\n-- end",
    );
    assertEquals(inj.mode, "both");
  });

  await t.step(
    "collection registers injectable and its underlying partial",
    async () => {
      const injections = fbInjectablesCollection<
        { injectable: FencedBlockInjectable }
      >();
      const inj = fbInjectableCandidate(
        "header --inject **/*.sql --prepend",
        "-- header",
      );
      injections.register({ injectable: inj });

      // Ensure it's in the injectable catalog
      assertEquals(injections.injectable("header")?.identity, "header");

      // Ensure underlying partial landed in internal partials collection
      const p = injections.partials.partial("header");
      assert(p, "underlying partial should be in partials registry");
      const pr = await p!.content({});
      assertEquals(pr.content, "-- header");
    },
  );

  await t.step("compose(): prepend behavior", async () => {
    const injections = fbInjectablesCollection<
      { injectable: FencedBlockInjectable }
    >();
    injections.register({
      injectable: fbInjectableCandidate(
        "hdr --inject reports/**/*.sql --prepend",
        "-- header",
      ),
    });

    // Simulate a content partial render output
    const input = { content: "SELECT 1;", interpolate: true, locals: {} };
    const out = await injections.compose(input, {
      path: "reports/2025/monthly.sql",
    });
    assertEquals(out.content, "-- header\nSELECT 1;");
    assertEquals(out.interpolate, true);
    assertEquals(out.locals, {});
  });

  await t.step("compose(): append behavior", async () => {
    const injections = fbInjectablesCollection<
      { injectable: FencedBlockInjectable }
    >();
    injections.register({
      injectable: fbInjectableCandidate(
        "ftr --inject **/*.sql --append",
        "-- footer",
      ),
    });

    const input = { content: "SELECT 2;", interpolate: true, locals: {} };
    const out = await injections.compose(input, { path: "any/path/query.sql" });
    assertEquals(out.content, "SELECT 2;\n-- footer");
  });

  await t.step("compose(): both behavior", async () => {
    const injections = fbInjectablesCollection<
      { injectable: FencedBlockInjectable }
    >();
    injections.register({
      injectable: fbInjectableCandidate(
        "enc --inject **/*.sql --prepend --append",
        "-- bound",
      ),
    });

    const input = { content: "SELECT 3;", interpolate: true, locals: {} };
    const out = await injections.compose(input, { path: "z/x.sql" });
    assertEquals(out.content, "-- bound\nSELECT 3;\n-- bound");
  });

  await t.step(
    "compose(): no matching injectable leaves content unchanged",
    async () => {
      const injections = fbInjectablesCollection<
        { injectable: FencedBlockInjectable }
      >();
      injections.register({
        injectable: fbInjectableCandidate(
          "only-reports --inject reports/**/*.sql --prepend",
          "-- hdr",
        ),
      });

      const input = { content: "SELECT 4;", interpolate: true, locals: {} };
      const out = await injections.compose(input, {
        path: "other/path/table.ddl",
      });
      assertEquals(out.content, "SELECT 4;"); // unchanged
    },
  );

  await t.step("findInjectableForPath(): exact (non-glob) match works", () => {
    const injections = fbInjectablesCollection<
      { injectable: FencedBlockInjectable }
    >();
    injections.register({
      injectable: fbInjectableCandidate(
        "exact --inject reports/2025/monthly.sql --prepend",
        "-- hdr",
      ),
    });

    const found = injections.findInjectableForPath("reports/2025/monthly.sql");
    assert(found);
    assertEquals(found!.injectable.identity, "exact");
  });

  await t.step(
    "specificity: fewer wildcards beats more; longer literal breaks ties",
    async () => {
      const injections = fbInjectablesCollection<
        { injectable: FencedBlockInjectable }
      >();

      // More generic
      injections.register({
        injectable: fbInjectableCandidate(
          "generic --inject reports/**/*.sql --prepend",
          "-- G",
        ),
      });

      // More specific (fewer wildcards)
      injections.register({
        injectable: fbInjectableCandidate(
          "monthlies --inject reports/*/monthly.sql --prepend",
          "-- M",
        ),
      });

      const path = "reports/2025/monthly.sql";
      const found = injections.findInjectableForPath(path)!;
      assertEquals(found.injectable.identity, "monthlies");

      const input = { content: "SELECT 5;", interpolate: true, locals: {} };
      const out = await injections.compose(input, { path });
      assertEquals(out.content, "-- M\nSELECT 5;");
    },
  );

  await t.step(
    "compose(): wrapper render errors are surfaced and disable interpolation",
    async () => {
      // Create an injectable whose underlying partial will throw (via schema check failure)
      const bad = fbInjectableCandidate(
        "bad --inject **/*.sql --prepend",
        "WRAP", // content OK, but we'll make its content() fail via schema & locals mismatch
        { mustBe: { type: "string" } },
      );
      const injections = fbInjectablesCollection<
        { injectable: FencedBlockInjectable }
      >();
      injections.register({ injectable: bad });

      const input = {
        content: "BODY",
        interpolate: true,
        locals: { mustBe: 123 },
      };
      const out = await injections.compose(input, {
        path: "any.sql",
        onError: (msg) => `ERR: ${msg}`,
      });

      assertFalse(out.interpolate);
      assertMatch(out.content, /ERR: Injectable 'bad' failed to render/);
    },
  );
});
