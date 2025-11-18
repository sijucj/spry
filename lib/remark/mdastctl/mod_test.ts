import $ from "@david/dax";
import { markdownASTs } from "./io.ts";
import { collectMdastStats } from "../mdast/statistics.ts";
import { assertEquals } from "@std/assert/equals";

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

Deno.test("mdastctl mod.ts", async () => {
  for await (
    const md of markdownASTs([fixturePath("../fixture/test-fixture-01.md")])
  ) {
    const stats = collectMdastStats(md.mdastRoot);
    const statsGolden = JSON.parse(
      await Deno.readTextFile(fixturePath(
        "../fixture/test-fixture-01.md-stats.golden.json",
      )),
    );
    assertEquals(stats, statsGolden);
  }
});

Deno.test("mdastctl mod.ts executable", async () => {
  const _stdout = await $`${mdastctl} mdast ls ${
    fixturePath("../fixture/test-fixture-01.md")
  }`.text();
});
