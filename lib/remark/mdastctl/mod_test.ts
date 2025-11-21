import $ from "@david/dax";
import { assertEquals } from "@std/assert/equals";
import { collectMdastStats } from "../mdast/statistics.ts";
import { markdownASTs } from "./io.ts";

function _stripAnsiControlChars(text: string | null | undefined): string {
  if (text == null) return "";
  // deno-lint-ignore no-control-regex
  const ansiPattern = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  return text.replace(ansiPattern, "");
}

export function fixturePath(relative: string): string {
  // Resolve the calling module directory
  const base = new URL(".", import.meta.url);
  return new URL(relative, base).pathname;
}

const mdastctl = fixturePath("mod.ts");
const fixture01Golden = "../fixture/test-fixture-01.md-stats.golden.json";

// use this when stats change and you want to create a new version
async function _saveGolden(json: unknown) {
  await Deno.writeTextFile(
    fixturePath(fixture01Golden),
    JSON.stringify(json, null, 2),
  );
}

Deno.test("mdastctl mod.ts", async () => {
  for await (
    const md of markdownASTs([fixturePath("../fixture/test-fixture-01.md")])
  ) {
    const stats = collectMdastStats(md.mdastRoot);
    // await saveGolden(stats); // when stats change, run this
    const statsGolden = JSON.parse(
      await Deno.readTextFile(fixturePath(fixture01Golden)),
    );
    assertEquals(stats, statsGolden);
  }
});

Deno.test("mdastctl mod.ts executable", async () => {
  const _stdout = await $`${mdastctl} mdast ls ${
    fixturePath("../fixture/test-fixture-01.md")
  }`.text();
});
