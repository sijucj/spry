// =============================================================================
// File: mdql_test.ts
// Description: Unit tests for MDQL tokenizer + parser (Deno test)
// =============================================================================

import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import {
  AttributeSelector,
  CompoundSelector,
  parseMDQL,
  PseudoFunc,
  Selector,
  tokenize,
} from "./mdql.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("tokenize: basic symbols", () => {
  const ts = tokenize('h2 > code[lang="sql"]');
  assert(ts.length > 0);
  assert(ts.some((t) => t.kind === "ident" && t.value === "h2"));
  assert(ts.some((t) => t.kind === "gt"));
});

Deno.test("parse: type + child + attr", () => {
  const r = parseMDQL('heading[level=2] > code[lang="sql"]');
  assert(r.ok);
  const list = r.value;
  assertEquals(list.items.length, 1);
  const sel = list.items[0];
  assertEquals(sel.core.head.parts[0].kind, "Type");
  // deno-lint-ignore no-explicit-any
  assertEquals((sel.core.head.parts[0] as any).name, "heading");
  assertEquals(sel.core.tails.length, 1);
  assertEquals(sel.core.tails[0].combinator, "child");
});

Deno.test("parse: id, class, grouping", () => {
  const r = parseMDQL("#intro, .sql, code");
  assert(r.ok);
  assertEquals(r.value.items.length, 3);
  const kinds = r.value.items.map((s) => s.core.head.parts[0].kind);
  assertEquals(kinds, ["Id", "Class", "Type"]);
});

Deno.test("parse: attribute operators", () => {
  const q = "code[lang^='p'][meta*='x'][checked!=true]";
  const r = parseMDQL(q);
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts.filter((p) => p.kind === "Attr" // deno-lint-ignore no-explicit-any
  ) as any[];
  assertEquals(parts.length, 3);
  assertEquals(parts[0].op, "^=");
  assertEquals(parts[1].op, "*=");
  assertEquals(parts[2].op, "!=");
});

Deno.test("parse: pseudos contains + fence() + ::section", () => {
  const r = parseMDQL("h2:contains('API')::section code:fence('sql')");
  assert(r.ok);
  const [a, b] = [
    r.value.items[0].core.head.parts,
    r.value.items[0].core.tails,
  ];
  assertEquals(a[a.length - 1].kind, "PseudoFunc");
  assertEquals(r.value.items[0].pseudoElement, "section");
  assertEquals(b.length, 1);
  assertEquals(b[0].combinator, "descendant");
  assertEquals(b[0].right.kind, "Compound");
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional, more complex cases
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("parse: descendant by space vs child with surrounding whitespace", () => {
  const r1 = parseMDQL("h2   code"); // descendant
  const r2 = parseMDQL("h2    >    code"); // child with spaces around
  assert(r1.ok && r2.ok);

  const tails1 = r1.value.items[0].core.tails;
  const tails2 = r2.value.items[0].core.tails;

  assertEquals(tails1.length, 1);
  assertEquals(tails1[0].combinator, "descendant");

  assertEquals(tails2.length, 1);
  assertEquals(tails2[0].combinator, "child");
});

Deno.test("parse: :has() with nested selector using adjacent sibling", () => {
  const r = parseMDQL("heading:has(+ code[lang='ts'])");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts;
  const pseudo = parts[parts.length - 1];
  assertEquals(pseudo.kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  assertEquals((pseudo as any).name, "has");
  // Ensure the nested selector list exists
  // deno-lint-ignore no-explicit-any
  const args = (pseudo as any).args as unknown[];
  assert(args.length >= 1);
  // deno-lint-ignore no-explicit-any
  const inner = args[0] as any;
  assertExists(inner.items);
  // first inner selector should have an adjacent tail
  const t0 = inner.items[0].core.tails[0];
  assertEquals(t0.combinator, "adjacent");
});

Deno.test("parse: :not and :is with multiple selector list arguments", () => {
  const r = parseMDQL("code:not([lang='js'], [lang='ts']):is([meta*='x'])");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts;
  const notP = parts.find((p) =>
    p.kind === "PseudoFunc" &&
    // deno-lint-ignore no-explicit-any
    (p as any).name === "not"
  );
  const isP = parts.find((p) =>
    p.kind === "PseudoFunc" &&
    // deno-lint-ignore no-explicit-any
    (p as any).name === "is"
  );
  assertExists(notP);
  assertExists(isP);
  // deno-lint-ignore no-explicit-any
  const notArgs = (notP as any).args as unknown[];
  assertEquals(notArgs.length, 1); // a single SelectorList containing two items
  // deno-lint-ignore no-explicit-any
  const innerList = notArgs[0] as any;
  assertEquals(innerList.items.length, 2);
});

Deno.test("parse: :lines(10..20) range and attribute numeric comparisons", () => {
  const r = parseMDQL("heading[depth>=2][depth<=3]:lines(10..20)");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts;
  // two Attrs then a PseudoFunc
  const attrs = parts.filter((p) => p.kind === "Attr");
  const last = parts[parts.length - 1];
  assertEquals(attrs.length, 2);
  // deno-lint-ignore no-explicit-any
  assertEquals((attrs[0] as any).op, ">=");
  // deno-lint-ignore no-explicit-any
  assertEquals((attrs[1] as any).op, "<=");
  assertEquals(last.kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  const args = (last as any).args as unknown[];
  // Range literal compiled to an object with kind:'range'
  const range = args[0] as { kind: string; from: number; to: number };
  assertEquals(range.kind, "range");
  assertEquals(range.from, 10);
  assertEquals(range.to, 20);
});

Deno.test("parse: more ops and attribute tests (endswith, star equals)", () => {
  const r = parseMDQL("link[url$='.pdf'][title*='spec']");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts.filter((p) => p.kind === "Attr" // deno-lint-ignore no-explicit-any
  ) as any[];
  assertEquals(parts.length, 2);
  assertEquals(parts[0].op, "$=");
  assertEquals(parts[1].op, "*=");
});

Deno.test("parse: file scope + grouping", () => {
  const r = parseMDQL(`:file("docs/**") heading, code`);
  assert(r.ok);
  assertEquals(r.value.items.length, 2);
  // first selector head starts with PseudoFunc (file)
  const firstHead = r.value.items[0].core.head.parts[0];
  assertEquals(firstHead.kind, "PseudoFunc");
  // second selector is 'code'
  const secondHead = r.value.items[1].core.head.parts[0];
  assertEquals(secondHead.kind, "Type");
  // deno-lint-ignore no-explicit-any
  assertEquals((secondHead as any).name, "code");
});

Deno.test("parse: tails after ::section with explicit child '>'", () => {
  const r = parseMDQL("h2::section > code");
  assert(r.ok);
  const sel = r.value.items[0];
  assertEquals(sel.pseudoElement, "section");
  // should have one tail and it must be 'child'
  assertEquals(sel.core.tails.length, 1);
  assertEquals(sel.core.tails[0].combinator, "child");
});

Deno.test("tokenize: two-char ops including *=", () => {
  const ts = tokenize("a[meta*='foo'][x>=1][y<=2][z!=3]");
  // must contain 'op' tokens for *=, >=, <=, !=
  const ops = ts.filter((t) => t.kind === "op").map((t) => t.value);
  assert(ops.includes("*="));
  assert(ops.includes(">="));
  assert(ops.includes("<="));
  assert(ops.includes("!="));
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra / esoteric cases
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("parse: :has() with descendant space (relative) and attr", () => {
  const r = parseMDQL("heading:has(  code[lang='ts']  )");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts;
  const has = parts[parts.length - 1];
  assertEquals(has.kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  assertEquals((has as any).name, "has");
  // deno-lint-ignore no-explicit-any
  const inner = (has as any).args[0] as any; // SelectorList
  assertEquals(inner.items.length, 1);
  // the inner selector should start with Universal head (implicit) and one tail (descendant)
  const innerSel = inner.items[0];
  assertEquals(innerSel.core.head.parts[0].kind, "Universal");
  assertEquals(innerSel.core.tails.length, 1);
  assertEquals(innerSel.core.tails[0].combinator, "descendant");
});

Deno.test("parse: :has() with chained relative tails (+ then ~)", () => {
  const r = parseMDQL("heading:has(+ code ~ link)");
  assert(r.ok);
  // deno-lint-ignore no-explicit-any
  const has = r.value.items[0].core.head.parts.slice(-1)[0] as any;
  const inner = has.args[0]; // SelectorList
  assertEquals(inner.items.length, 1);
  const tails = inner.items[0].core.tails;
  assertEquals(tails.length, 2);
  assertEquals(tails[0].combinator, "adjacent");
  assertEquals(tails[1].combinator, "sibling");
});

Deno.test("parse: nested pseudos :not(:has(code))", () => {
  const r = parseMDQL("heading:not(:has(code))");
  assert(r.ok);
  const parts = r.value.items[0].core.head.parts;
  const notP = parts.find((p) =>
    p.kind === "PseudoFunc" &&
    // deno-lint-ignore no-explicit-any
    (p as any).name === "not"
  );
  assert(notP);
  // deno-lint-ignore no-explicit-any
  const innerList = (notP as any).args[0];
  assertEquals(innerList.items.length, 1);
  const innerHeadParts = innerList.items[0].core.head.parts;
  // first token inside is a PseudoFunc ':has'
  assertEquals(innerHeadParts[0].kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  assertEquals((innerHeadParts[0] as any).name, "has");
});

Deno.test("parse: :is() vs :where() basic parse parity", () => {
  const r = parseMDQL("code:is([lang='js']) :where([meta*='opt'])");
  assert(r.ok);
  const tails = r.value.items[0].core.tails;
  assertEquals(tails.length, 1); // descendant space before :where(...)
  const headParts = r.value.items[0].core.head.parts;
  const names = headParts
    .filter((p) => p.kind === "PseudoFunc")
    // deno-lint-ignore no-explicit-any
    .map((p) => (p as any).name);
  assertEquals(names, ["is"]);
  const rightParts = tails[0].right.parts;
  // right side of descendant should start with PseudoFunc 'where'
  assertEquals(rightParts[0].kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  assertEquals((rightParts[0] as any).name, "where");
});

Deno.test("parse: boolean attr presence and explicit true/false", () => {
  const r = parseMDQL("listItem[checked][checked=false]");
  assert(r.ok);
  const attrs = r.value.items[0].core.head.parts.filter((p) =>
    p.kind === "Attr"
  );
  assertEquals(attrs.length, 2);
  // first attr has no operator (presence)
  // deno-lint-ignore no-explicit-any
  assertEquals((attrs[0] as any).op, undefined);
  // second attr is explicit equality (parsed via 'ident' -> boolean)
  // deno-lint-ignore no-explicit-any
  assertEquals((attrs[1] as any).op, "=");
  // deno-lint-ignore no-explicit-any
  assertEquals((attrs[1] as any).value, false);
});

Deno.test("parse: :lines(5) single line (number arg)", () => {
  const r = parseMDQL("paragraph:lines(5)");
  assert(r.ok);
  const p = r.value.items[0].core.head.parts.slice(-1)[0];
  assertEquals(p.kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  const args = (p as any).args as unknown[];
  assertEquals(args.length, 1);
  assertEquals(args[0], 5);
});

Deno.test("parse: comma inside string argument should not split list", () => {
  const r = parseMDQL("heading:contains('a, b, c')");
  assert(r.ok);
  const pf = r.value.items[0].core.head.parts.slice(-1)[0];
  assertEquals(pf.kind, "PseudoFunc");
  // deno-lint-ignore no-explicit-any
  const args = (pf as any).args;
  assertEquals(args[0], "a, b, c");
});

Deno.test("parse: grouped inner selectors in :has(code, table)", () => {
  const r = parseMDQL("section:has(code, table)");
  assert(r.ok);
  // deno-lint-ignore no-explicit-any
  const has = r.value.items[0].core.head.parts.slice(-1)[0] as any;
  const inner = has.args[0]; // SelectorList
  assertEquals(inner.items.length, 2);
  assertEquals(inner.items[0].core.head.parts[0].kind, "Type");
  assertEquals(inner.items[1].core.head.parts[0].kind, "Type");
});

Deno.test("parse: pseudo-elements in groups", () => {
  const r = parseMDQL("h2::slug, h2::text");
  assert(r.ok);
  assertEquals(r.value.items.length, 2);
  assertEquals(r.value.items[0].pseudoElement, "slug");
  assertEquals(r.value.items[1].pseudoElement, "text");
});

Deno.test("parse: multi-tail chain with attrs and pseudos", () => {
  const r = parseMDQL(
    "h2[depth=2]:contains('API') + code[lang='ts'] ~ link[title$='ref']",
  );
  assert(r.ok);
  const tails = r.value.items[0].core.tails;
  assertEquals(tails.length, 2);
  assertEquals(tails[0].combinator, "adjacent");
  assertEquals(tails[1].combinator, "sibling");
  assertEquals(tails[0].right.parts[0].kind, "Type"); // code
  assertEquals(tails[1].right.parts[0].kind, "Type"); // link
});

Deno.test("parse error: missing closing bracket in attr", () => {
  const r = parseMDQL("code[lang='ts'");
  assert(!r.ok);
  // Should contain at least one 'Invalid attribute value' or 'Expected rbrack'
  const msgs = r.error.map((e) => e.message).join(" | ");
  assert(
    msgs.includes("Invalid attribute value") ||
      msgs.includes("Expected rbrack"),
  );
});

Deno.test("parse error: leading combinator without right side", () => {
  const r = parseMDQL(">   ");
  assert(!r.ok);
  const msgs = r.error.map((e) => e.message).join(" | ");
  // Expect the parser to complain about missing simple selector
  assert(
    msgs.includes("Expected a simple selector") ||
      msgs.includes("Expected ident"),
  );
});

Deno.test("MDQL complex PI/ATTRS conditions", async (t) => {
  await t.step("code fence with PI + ATTRS + pseudo-element ::pi", () => {
    const q =
      `code:fence('sql')[pi.flags.env='prod'][pi.count>=2][attrs.timeout>=60]::pi`;
    const res = parseMDQL(q);
    assert(res.ok, JSON.stringify((res as Any).error, null, 2));

    const sel: Selector = res.value.items[0];
    assertStrictEquals(sel.pseudoElement, "pi");

    const head = sel.core.head as CompoundSelector;
    // Expect parts: Type 'code', PseudoFunc fence('sql'), Attr pi.flags.env, Attr pi.count, Attr attrs.timeout
    assertEquals(head.parts.length >= 5, true);

    const type = head.parts[0] as Any;
    assertStrictEquals(type.kind, "Type");
    assertStrictEquals(type.name, "code");

    const pf = head.parts[1] as PseudoFunc;
    assertStrictEquals(pf.kind, "PseudoFunc");
    assertStrictEquals(pf.name, "fence");
    assertStrictEquals(pf.args[0], "sql");

    const a1 = head.parts[2] as AttributeSelector;
    assertStrictEquals(a1.kind, "Attr");
    assertStrictEquals(a1.name, "pi.flags.env");
    assertStrictEquals(a1.op, "=");
    assertStrictEquals(a1.value, "prod");

    const a2 = head.parts[3] as AttributeSelector;
    assertStrictEquals(a2.name, "pi.count");
    assertStrictEquals(a2.op, ">=");
    assertStrictEquals(a2.value, 2);

    const a3 = head.parts[4] as AttributeSelector;
    assertStrictEquals(a3.name, "attrs.timeout");
    assertStrictEquals(a3.op, ">=");
    assertStrictEquals(a3.value, 60);
  });

  await t.step(":has(...) with relative selector including PI checks", () => {
    const q =
      `heading:has( > code[lang='bash'][pi.pos0='deploy'] + code:pi('--dry-run') )`;
    const res = parseMDQL(q);
    assert(res.ok, JSON.stringify((res as Any).error, null, 2));

    const sel = res.value.items[0];
    const head = sel.core.head as CompoundSelector;
    // head should start with Type 'heading'
    assertStrictEquals((head.parts[0] as Any).name, "heading");

    // find :has pseudo
    const hasPseudo = head.parts.find((p) =>
      p.kind === "PseudoFunc" && p.name === "has"
    ) as PseudoFunc;
    assert(hasPseudo, "expected :has pseudo");
    // arg should be a SelectorList (relative)
    const arg0 = hasPseudo.args[0] as Any;
    assertStrictEquals(arg0.kind, "SelectorList");

    const innerSel: Selector = arg0.items[0];
    // expect first tail combinator is 'child' then 'adjacent'
    assertStrictEquals(innerSel.core.tails.length, 2);
    assertStrictEquals(innerSel.core.tails[0].combinator, "child");
    assertStrictEquals(innerSel.core.tails[1].combinator, "adjacent");

    // right side of first tail should be code[lang='bash'][pi.pos0='deploy']
    const firstRight = innerSel.core.tails[0].right;
    const pLang = firstRight.parts.find((p) =>
      p.kind === "Attr" && (p as AttributeSelector).name === "lang"
    ) as AttributeSelector;
    assertStrictEquals(pLang.value, "bash");
    const pPos0 = firstRight.parts.find((p) =>
      p.kind === "Attr" && (p as AttributeSelector).name === "pi.pos0"
    ) as AttributeSelector;
    assertStrictEquals(pPos0.op, "=");
    assertStrictEquals(pPos0.value, "deploy");

    // right side of second tail should contain :pi('--dry-run')
    const secondRight = innerSel.core.tails[1].right;
    const piPseudo = secondRight.parts.find((p) =>
      p.kind === "PseudoFunc" && (p as PseudoFunc).name === "pi"
    ) as PseudoFunc;
    assert(piPseudo);
    assertStrictEquals(piPseudo.args[0], "--dry-run");
  });

  await t.step("argv + attrs tags contains + pseudo-element ::attrs", () => {
    const q = `code:argv(0,'build'):argv('release')[attrs.tags~='etl']::attrs`;
    const res = parseMDQL(q);
    assert(res.ok, JSON.stringify((res as Any).error, null, 2));

    const sel = res.value.items[0];
    assertStrictEquals(sel.pseudoElement, "attrs");

    const head = sel.core.head as CompoundSelector;
    // find both :argv pseudos
    const argvPseudos = head.parts.filter((p) =>
      p.kind === "PseudoFunc" && p.name === "argv"
    ) as PseudoFunc[];
    assertStrictEquals(argvPseudos.length, 2);
    assertStrictEquals(argvPseudos[0].args.length, 2); // (0,'build')
    assertStrictEquals(argvPseudos[0].args[0], 0);
    assertStrictEquals(argvPseudos[0].args[1], "build");
    assertStrictEquals(argvPseudos[1].args.length, 1); // ('release')
    assertStrictEquals(argvPseudos[1].args[0], "release");

    const tagsAttr = head.parts.find((p) =>
      p.kind === "Attr" && (p as AttributeSelector).name === "attrs.tags"
    ) as AttributeSelector;
    assertStrictEquals(tagsAttr.op, "~=");
    assertStrictEquals(tagsAttr.value, "etl");
  });
});
