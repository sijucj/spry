// injected-nodes_test.ts

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { remark } from "npm:remark@^15";
import type { Code, Root } from "npm:@types/mdast@^4";

import { injectedNodes, isInjectedCode } from "./injected-nodes.ts";

function getCodeNodes(tree: Root): Code[] {
  return (tree.children.filter((n) => n.type === "code") as Code[]);
}

Deno.test("injectedNodes: expands import spec into local SQL and binary utf8 nodes", async (t) => {
  // Create temp workspace with a SQL file and a small binary (PNG-like) file.
  const tmp = await Deno.makeTempDir({ prefix: "injected-nodes-" });
  const migDir = join(tmp, "migrations");
  const assetDir = join(tmp, "assets");
  await Deno.mkdir(migDir, { recursive: true });
  await Deno.mkdir(assetDir, { recursive: true });

  const sqlPath = join(migDir, "init.sql");
  await Deno.writeTextFile(sqlPath, "CREATE TABLE t(x INT);");

  const pngPath = join(assetDir, "logo.png");
  await Deno.writeFile(pngPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // PNG header bytes

  const md = [
    "```import --base " + tmp,
    "# comment",
    "sql **/*.sql",
    "utf8 assets/**/*.png",
    "```",
    "",
  ].join("\n");

  const processor = remark().use(injectedNodes);
  const tree = processor.runSync(processor.parse(md)) as Root;

  const codes = getCodeNodes(tree);
  // 1 spec block + 2 injected blocks
  assertEquals(codes.length, 3);

  const [spec, injectedSql, injectedPng] = codes;

  await t.step("spec block remains unchanged", () => {
    assertEquals(spec.lang, "import");
    assertMatch(spec.value ?? "", /sql \*\*\/\*\.sql/);
  });

  await t.step(
    "injected SQL node: text cell with relative firstToken and contents",
    () => {
      assertEquals(injectedSql.lang, "sql");
      assert(injectedSql.meta);
      // meta should start with a relative path into migrations, ending in init.sql
      assertMatch(injectedSql.meta, /migrations\/init\.sql/);
      assertMatch(injectedSql.meta, /--import/);
      assertEquals(injectedSql.value.trim(), "CREATE TABLE t(x INT);");

      // injectedNode metadata
      assert(isInjectedCode(injectedSql));
      const src = injectedSql.data!.injectedNode.source!;
      assert(!src.isRefToBinary);
      assertMatch(String(src.importedFrom), /init\.sql$/);
      assertEquals(src.original.trim(), "CREATE TABLE t(x INT);");
    },
  );

  await t.step("injected PNG node: binary utf8 ref with is-binary flag", () => {
    assertEquals(injectedPng.lang, "utf8");
    assert(injectedPng.meta);
    assertMatch(injectedPng.meta, /assets\/logo\.png/);
    assertMatch(injectedPng.meta, /--import/);
    assertMatch(injectedPng.meta, /--is-binary/);

    // For binary, we don't stuff bytes into value
    assertEquals(injectedPng.value, "");

    assert(isInjectedCode(injectedPng));
    const src = injectedPng.data!.injectedNode.source!;
    assert(src.isRefToBinary);
    assertEquals(src.encoding, "UTF-8");
    assertMatch(String(src.importedFrom), /logo\.png$/);
    // rs should be a ReadableStream if present
    assert(src.stream);
  });

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("injectedNodes: expands remote JSON spec into injected remote node", () => {
  const remoteBase = "https://example.com/";
  const remoteUrl = "https://example.com/conf/demo.json";

  const md = [
    "```import --inject --base " + remoteBase,
    `json ${remoteUrl}`,
    "```",
    "",
  ].join("\n");

  const processor = remark().use(injectedNodes);
  const tree = processor.runSync(processor.parse(md)) as Root;

  const codes = getCodeNodes(tree);
  // 1 spec block + 1 injected block
  assertEquals(codes.length, 2);

  const [_spec, injectedJson] = codes;

  assertEquals(injectedJson.lang, "json");
  assert(injectedJson.meta);
  // first token in meta should be relative path from base, e.g. "conf/demo.json"
  assertMatch(injectedJson.meta, /^conf\/demo\.json\b/);
  assertMatch(
    injectedJson.meta,
    /--import https:\/\/example\.com\/conf\/demo\.json/,
  );

  // No eager value for remote; it's a ref
  assertEquals(injectedJson.value, "");

  assert(isInjectedCode(injectedJson));
  const src = injectedJson.data!.injectedNode.source!;
  assert(src.isRefToBinary);
  assertEquals(src.encoding, "UTF-8");
  assertEquals(src.importedFrom, remoteUrl);
  assert(src.stream);
});
