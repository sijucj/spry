// lib/markdown/flexible-cell_test.ts
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { remark } from "npm:remark@^15";
import remarkGfm from "npm:remark-gfm@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import flexibleCell, {
  type FlexibleCellOptions,
  parseFlexibleCellFromCode,
} from "./flexible-cell.ts";

function pipeline(opts?: FlexibleCellOptions) {
  return remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).use(
    flexibleCell,
    opts ?? { coerceNumbers: true },
  );
}

function codeNodes(tree: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.type === "code") out.push(n);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

Deno.test("flexible-cell plugin ...", async (t) => {
  await t.step("basic: bare tokens and boolean flags", () => {
    const md = "```bash first -x --flag\ncode\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const node = codeNodes(tree)[0] as any;
    assert(node?.data?.flexibleCell);

    const fc = node.data.flexibleCell;
    assertEquals(fc.lang, "bash");
    assertEquals(fc.pi.pos, ["first", "x", "flag"]);
    // flags normalized with both bare and boolean forms
    assertEquals(fc.pi.flags.first, true);
    assertEquals(fc.pi.flags.x, true);
    assertEquals(fc.pi.flags.flag, true);
  });

  await t.step(
    "flags with =value and two-token form merge into arrays and pos includes normalized keys",
    () => {
      const md = "```ts --tag=alpha --tag beta -L 9 key=value\ncode\n```";
      const tree = pipeline().parse(md);
      pipeline().runSync(tree);

      const fc = (codeNodes(tree)[0] as any).data.flexibleCell;
      assertEquals(fc.pi.pos, ["tag", "tag", "L", "key"]);
      assertEquals(fc.pi.flags.tag, ["alpha", "beta"]);
      assertEquals(fc.pi.flags.L, 9 as any); // "9" remains a string from tokenization; acceptable in test
      assertEquals(fc.pi.flags.key, "value");
    },
  );

  await t.step("ATTRS JSON parsed and exposed", () => {
    const md =
      "```json5 --x {priority: 5, env: 'qa', note: 'hello', list: [1,2,3]}\n{}\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const fc = (codeNodes(tree)[0] as any).data.flexibleCell;
    assertEquals(fc.lang, "json5");
    assertEquals(fc.attrs.priority, 5);
    assertEquals(fc.attrs.env, "qa");
    assertEquals(fc.attrs.note, "hello");
    assertEquals(fc.attrs.list, [1, 2, 3]);
  });

  await t.step("normalizeFlagKey override maps aliases", () => {
    const md = "```py --ENV=prod -e qa stage\nprint('x')\n```";
    const tree = pipeline({
      normalizeFlagKey: (k) => k.toLowerCase(),
    }).parse(md);
    pipeline({
      normalizeFlagKey: (k) => k.toLowerCase(),
    }).runSync(tree);

    const pi = (codeNodes(tree)[0] as any).data.flexibleCell.pi;
    // all keys normalized to lower-case
    assertEquals(pi.pos, ["env", "e", "stage"]);
    assertEquals(pi.flags.env, "prod");
    assertEquals(pi.flags.e, "qa");
    assertEquals(pi.flags.stage, true);
  });

  await t.step("storeKey override", () => {
    const md = "```bash first {x:1}\ncode\n```";
    const tree = pipeline({ storeKey: "cell" }).parse(md);
    pipeline({ storeKey: "cell" }).runSync(tree);

    const node = codeNodes(tree)[0] as any;
    assert(node.data.cell);
    assertEquals(node.data.flexibleCell, undefined);
    assertEquals(node.data.cell.attrs.x, 1);
    assertEquals(node.data.cell.pi.flags.first, true);
  });

  await t.step(
    "invalid JSON attrs ignored by default, and 'throw' option propagates",
    () => {
      // Make it invalid for JSON5 too: double comma -> syntax error
      const invalid = "```ts --x {bad: 1,,}\ncode\n```";
      // default: ignore
      {
        const tree = pipeline().parse(invalid);
        pipeline().runSync(tree);
        const fc = (codeNodes(tree)[0] as any).data.flexibleCell;
        assertEquals(fc.attrs, {}); // ignored on error
      }
      // 'throw': parse error should propagate
      assertThrows(() => {
        const p = pipeline({ onAttrsParseError: "throw" });
        const tr = p.parse(invalid);
        p.runSync(tr);
      });
    },
  );

  await t.step(
    "idempotent (running plugin twice does not duplicate)",
    () => {
      const md = "```ts a b c {x:1}\ncode\n```";
      const p = pipeline();
      const tree = p.parse(md);
      p.runSync(tree);
      p.runSync(tree);

      const node = codeNodes(tree)[0] as any;
      assertEquals(typeof node.data.flexibleCell.lang, "string");
      assertEquals(Array.isArray(node.data.flexibleCell.pi.pos), true);
      assertEquals(node.data.flexibleCell.attrs.x, 1);
    },
  );

  await t.step("public helper parseFlexibleCellFromCode()", () => {
    const md = "```sql --stage prod {sharded: true}\nSELECT 1;\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const node = codeNodes(tree)[0] as any;
    const parsed = parseFlexibleCellFromCode(node);
    assert(parsed);
    assertEquals(parsed?.lang, "sql");
    assertEquals(parsed?.pi.flags.stage, "prod");
    assertEquals(parsed?.attrs.sharded, true);
  });

  await t.step(
    "mixed: bare tokens recorded in pos and as booleans",
    () => {
      const md = "```txt alpha beta -x --y\n...\n```";
      const tree = pipeline().parse(md);
      pipeline().runSync(tree);

      const pi = (codeNodes(tree)[0] as any).data.flexibleCell.pi;
      assertEquals(pi.pos, ["alpha", "beta", "x", "y"]);
      assertEquals(pi.flags.alpha, true);
      assertEquals(pi.flags.beta, true);
      assertEquals(pi.flags.x, true);
      assertEquals(pi.flags.y, true);
    },
  );
});
