import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import { remark } from "npm:remark@^15";
import { ensureLanguageByIdOrAlias } from "../../universal/code.ts";
import enrichedCode, {
  type EnrichedCodeOptions,
  parseEnrichedCodeFromCode,
} from "./enriched-code.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function pipeline(opts?: EnrichedCodeOptions) {
  return remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).use(
    enrichedCode,
    opts ?? { coerceNumbers: true },
  );
}

function codeNodes(tree: Any): Any[] {
  const out: Any[] = [];
  const walk = (n: Any) => {
    if (n.type === "code") out.push(n);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

Deno.test("EnrichedCode plugin ...", async (t) => {
  await t.step("basic: bare tokens and boolean flags", () => {
    const md = "```bash first -x --flag\ncode\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const node = codeNodes(tree)[0] as Any;
    assert(node?.data?.enrichedCode);

    const ec = node.data.enrichedCode;
    assertEquals(ec.lang, "bash");
    assertEquals(ec.langSpec.id, ensureLanguageByIdOrAlias("bash").id);
    assertEquals(ec.pi.pos, ["first", "x", "flag"]);
    // flags normalized with both bare and boolean forms
    assertEquals(ec.pi.flags.first, true);
    assertEquals(ec.pi.flags.x, true);
    assertEquals(ec.pi.flags.flag, true);
  });

  await t.step(
    "flags with =value and two-token form merge into arrays and pos includes normalized keys",
    () => {
      const md = "```ts --tag=alpha --tag beta -L 9 key=value\ncode\n```";
      const tree = pipeline().parse(md);
      pipeline().runSync(tree);

      const ec = (codeNodes(tree)[0] as Any).data.enrichedCode;
      assertEquals(ec.langSpec.id, "typescript");
      assertEquals(ec.pi.pos, ["tag", "tag", "L", "key"]);
      assertEquals(ec.pi.flags.tag, ["alpha", "beta"]);
      assertEquals(ec.pi.flags.L, 9 as Any);
      assertEquals(ec.pi.flags.key, "value");
    },
  );

  await t.step("ATTRS JSON parsed and exposed", () => {
    const md =
      "```json5 --x {priority: 5, env: 'qa', note: 'hello', list: [1,2,3]}\n{}\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const ec = (codeNodes(tree)[0] as Any).data.enrichedCode;
    assertEquals(ec.lang, "json5");
    assertEquals(ec.langSpec.id, "json5");
    assertEquals(ec.attrs.priority, 5);
    assertEquals(ec.attrs.env, "qa");
    assertEquals(ec.attrs.note, "hello");
    assertEquals(ec.attrs.list, [1, 2, 3]);
  });

  await t.step("normalizeFlagKey override maps aliases", () => {
    const md = "```py --ENV=prod -e qa stage\nprint('x')\n```";
    const tree = pipeline({
      normalizeFlagKey: (k) => k.toLowerCase(),
    }).parse(md);
    pipeline({
      normalizeFlagKey: (k) => k.toLowerCase(),
    }).runSync(tree);

    const ec = (codeNodes(tree)[0] as Any).data.enrichedCode;
    // all keys normalized to lower-case
    assertEquals(ec.langSpec.id, "python");
    assertEquals(ec.pi.pos, ["env", "e", "stage"]);
    assertEquals(ec.pi.flags.env, "prod");
    assertEquals(ec.pi.flags.e, "qa");
    assertEquals(ec.pi.flags.stage, true);
  });

  await t.step("storeKey override", () => {
    const md = "```bash first {x:1}\ncode\n```";
    const tree = pipeline({ storeKey: "cell" }).parse(md);
    pipeline({ storeKey: "cell" }).runSync(tree);

    const node = codeNodes(tree)[0] as Any;
    assert(node.data.cell);
    assertEquals(node.data.enrichedCode, undefined);
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
        const ec = (codeNodes(tree)[0] as Any).data.enrichedCode;
        assertEquals(ec.attrs, {}); // ignored on error
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

      const node = codeNodes(tree)[0] as Any;
      assertEquals(typeof node.data.enrichedCode.lang, "string");
      assertEquals(Array.isArray(node.data.enrichedCode.pi.pos), true);
      assertEquals(node.data.enrichedCode.attrs.x, 1);
    },
  );

  await t.step("public helper parseEnrichedCodeFromCode()", () => {
    const md = "```sql --stage prod {sharded: true}\nSELECT 1;\n```";
    const tree = pipeline().parse(md);
    pipeline().runSync(tree);

    const node = codeNodes(tree)[0] as Any;
    const parsed = parseEnrichedCodeFromCode(node);
    assert(parsed);
    assertEquals(parsed?.lang, "sql");
    assertEquals(parsed?.pi.flags.stage, "prod");
    assertEquals(parsed?.attrs?.sharded, true);
  });

  await t.step(
    "mixed: bare tokens recorded in pos and as booleans",
    () => {
      const md = "```txt alpha beta -x --y\n...\n```";
      const tree = pipeline().parse(md);
      pipeline().runSync(tree);

      const pi = (codeNodes(tree)[0] as Any).data.enrichedCode.pi;
      assertEquals(pi.pos, ["alpha", "beta", "x", "y"]);
      assertEquals(pi.flags.alpha, true);
      assertEquals(pi.flags.beta, true);
      assertEquals(pi.flags.x, true);
      assertEquals(pi.flags.y, true);
    },
  );
});
