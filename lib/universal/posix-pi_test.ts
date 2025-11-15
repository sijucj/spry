import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { instructionsFromText } from "./posix-pi.ts";

Deno.test("instructionsFromText basic and edge behaviors", async (t) => {
  await t.step("empty text yields empty pi and no attrs", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText("");
    assertEquals(pi.args, []);
    assertEquals(pi.pos, []);
    assertEquals(pi.flags, {});
    assertEquals(pi.count, 0);
    assertEquals(pi.posCount, 0);
    assertEquals(attrs, undefined);
    assertEquals(cmdLang, undefined);
    assertEquals(cli, "");
    assertEquals(attrsText, undefined);
  });

  await t.step("whitespace-only text behaves like empty", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
      "   \t  ",
    );
    assertEquals(pi.args, []);
    assertEquals(pi.pos, []);
    assertEquals(pi.flags, {});
    assertEquals(pi.count, 0);
    assertEquals(pi.posCount, 0);
    assertEquals(attrs, undefined);
    assertEquals(cmdLang, undefined);
    assertEquals(cli, "");
    assertEquals(attrsText, undefined);
  });

  await t.step(
    "single cmd/lang token is captured but not parsed as flag",
    () => {
      const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText("ts");
      assertEquals(pi.args, ["ts"]);
      assertEquals(pi.pos, []);
      assertEquals(pi.flags, {});
      assertEquals(pi.count, 1);
      assertEquals(pi.posCount, 0);
      assertEquals(attrs, undefined);
      assertEquals(cmdLang, "ts");
      assertEquals(cli, "ts");
      assertEquals(attrsText, undefined);
    },
  );

  await t.step(
    "cmd/lang plus bare token becomes boolean flag and pos key",
    () => {
      const { pi, cmdLang, cli } = instructionsFromText("sql important");
      assertEquals(pi.args, ["sql", "important"]);
      assertEquals(pi.pos, ["important"]);
      assertEquals(pi.flags, { important: true });
      assertEquals(pi.count, 2);
      assertEquals(pi.posCount, 1);
      assertEquals(cmdLang, "sql");
      assertEquals(cli, "sql important");
    },
  );

  await t.step("long and short flags with =value forms", () => {
    const { pi, cmdLang } = instructionsFromText(
      "js --limit=10 -x=9 --feature=true -f=false",
    );

    assertEquals(pi.args, [
      "js",
      "--limit=10",
      "-x=9",
      "--feature=true",
      "-f=false",
    ]);
    assertEquals(pi.pos.sort(), ["limit", "x", "feature", "f"].sort());

    // no numeric coercion by default: values remain strings
    assertEquals(pi.flags, {
      limit: "10",
      x: "9",
      feature: "true",
      f: "false",
    });
    assertEquals(cmdLang, "js");
  });

  await t.step("two-token flags with and without numeric coercion", () => {
    const raw = "ts --level 2 -n 3 --name main";

    const { pi: piNoCoerce } = instructionsFromText(raw);
    assertEquals(piNoCoerce.flags, {
      level: "2",
      n: "3",
      name: "main",
    });

    const { pi: piCoerce } = instructionsFromText(raw, { coerceNumbers: true });
    assertEquals(piCoerce.flags, {
      level: 2,
      n: 3,
      name: "main",
    });

    assertEquals(piCoerce.pos.sort(), ["level", "n", "name"].sort());
  });

  await t.step(
    "bare tokens accumulate as boolean flags and pos entries",
    () => {
      const { pi } = instructionsFromText("md important draft internal");
      assertEquals(pi.flags, {
        important: true,
        draft: true,
        internal: true,
      });
      assertEquals(pi.pos.sort(), ["important", "draft", "internal"].sort());
    },
  );

  await t.step("repeated flags accumulate into arrays", () => {
    const { pi } = instructionsFromText(
      "sql --tag a --tag=b --tag c --tag=done",
    );

    assertEquals(pi.flags, {
      tag: ["a", "b", "c", "done"],
    });

    assertEquals(pi.pos, ["tag", "tag", "tag", "tag"]);
  });

  await t.step("normalizeFlagKey is applied to flags and bare tokens", () => {
    const { pi, cmdLang } = instructionsFromText(
      "ts -L=1 -L 2 level3 --tag important tag2",
      {
        normalizeFlagKey: (k) => k.toLowerCase(),
      },
    );

    assertEquals(
      pi.pos.sort(),
      ["l", "l", "level3", "tag", "tag2"].sort(),
    );

    // `--tag important` is treated as two-token flag: tag = "important"
    assertEquals(pi.flags, {
      l: ["1", "2"],
      level3: true,
      tag: "important",
      tag2: true,
    });
    assertEquals(cmdLang, "ts");
  });

  await t.step("POSIX-style quoting preserves spaces inside quotes", () => {
    const { pi } = instructionsFromText(
      `ts --name "hello world" --path 'a b/c' tag`,
    );

    assertEquals(pi.flags, {
      name: "hello world",
      path: "a b/c",
      tag: true,
    });
    assertEquals(pi.pos.sort(), ["name", "path", "tag"].sort());
  });

  await t.step("attrs-only string (no cmd/lang) parses JSON5", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
      "{ foo: 1, bar: 'baz' }",
    );

    // POSIX tokenizer removes quotes from tokens in args
    assertEquals(pi.args, ["{", "foo:", "1,", "bar:", "baz", "}"]);
    assertEquals(pi.flags, {});
    assertEquals(pi.pos, []);
    assertEquals(pi.count, pi.args.length);
    assertEquals(pi.posCount, 0);

    assert(attrs);
    assertEquals(attrs, { foo: 1, bar: "baz" });
    assertEquals(cmdLang, undefined);
    assertEquals(cli, "");
    assertEquals(attrsText, "{ foo: 1, bar: 'baz' }");
  });

  await t.step("cmd/lang plus attrs parses both", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
      "js --tag important { id: 'foo', count: 3 }",
    );

    assertEquals(pi.args, [
      "js",
      "--tag",
      "important",
      "{",
      "id:",
      "foo,",
      "count:",
      "3",
      "}",
    ]);

    // normalized behavior: "--tag important" is a two-token flag
    assertEquals(pi.flags, { tag: "important" });
    assertEquals(pi.pos, ["tag"]);

    assert(attrs);
    assertEquals(attrs, { id: "foo", count: 3 });

    assertEquals(cmdLang, "js");
    assertEquals(cli, "js --tag important");
    assertEquals(attrsText, "{ id: 'foo', count: 3 }");
  });

  await t.step("attrs parsing ignores invalid JSON5 by default", () => {
    const { pi, attrs } = instructionsFromText(
      "ts --x 1 { not: valid: json5 }",
    );

    assertEquals(pi.flags, { x: "1" });
    assert(attrs);
    // default behavior: ignore parse errors -> empty object
    assertEquals(attrs, {});
  });

  await t.step(
    "attrs parsing stores __raw when onAttrsParseError='store'",
    () => {
      const { attrs, attrsText } = instructionsFromText(
        "ts --x 1 { not: valid: json5 }",
        { onAttrsParseError: "store" },
      );

      assert(attrs);
      const a = attrs as Record<string, unknown>;
      assertEquals(Object.keys(a).length, 1);
      assert(typeof a.__raw === "string");
      assert((a.__raw as string).trim().startsWith("{"));
      assertEquals(attrsText, "{ not: valid: json5 }");
    },
  );

  await t.step("attrs parsing throws when onAttrsParseError='throw'", () => {
    assertThrows(() =>
      instructionsFromText("ts { not: valid: json5 }", {
        onAttrsParseError: "throw",
      })
    );
  });

  await t.step(
    "cmd/lang is excluded from flags by default, but can be retained",
    () => {
      // Default: cmd/lang is NOT parsed as flag
      const { pi: piDefault, cmdLang: cmdDefault } = instructionsFromText(
        "--lang --flag value",
      );
      assertEquals(piDefault.args, ["--lang", "--flag", "value"]);
      assertEquals(piDefault.flags, { flag: "value" });
      assertEquals(piDefault.pos, ["flag"]);
      assertEquals(cmdDefault, "--lang");

      // With retainCmdLang: cmd/lang participates in flag/pos parsing
      const { pi: piRetain, cmdLang: cmdRetain } = instructionsFromText(
        "--lang --flag value",
        { retainCmdLang: true },
      );
      assertEquals(piRetain.args, ["--lang", "--flag", "value"]);
      assertEquals(piRetain.flags, {
        lang: true,
        flag: "value",
      });
      assertEquals(piRetain.pos.sort(), ["lang", "flag"].sort());
      assertEquals(cmdRetain, "--lang");
    },
  );

  await t.step("no attrs when no { token is present", () => {
    const { attrs, attrsText } = instructionsFromText("ts --x 1 --y=2");
    assertEquals(attrs, undefined);
    assertEquals(attrsText, undefined);
  });
});
