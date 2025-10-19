import { assertEquals } from "jsr:@std/assert@1";
import { sqlCat, sqlRaw } from "../universal/sql-text.ts";
import { markdownLinkFactory } from "./interpolate.ts";

Deno.test("markdownLinkFactory — basics", async (t) => {
  await t.step(
    "default base: base unencoded; ONLY non-literal url parts encoded",
    () => {
      const md = markdownLinkFactory({ url_encode: "sqlpage" }); // base = SQLPAGE_SITE_PREFIX (unencoded)
      const text = sqlCat`${"label"}`; // → label
      const url = sqlCat`/details?id=${"id"}`; // → ('/details?id=' || id)

      const got = md.link(text, url);
      const expect = "('[' || label || '](' || " +
        "sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || " +
        "'/details?id=' || sqlpage.url_encode(id) || ')')";

      assertEquals(got, expect);
    },
  );

  await t.step(
    "custom factory base applies to all calls (base unencoded)",
    () => {
      const md = markdownLinkFactory({
        base: sqlRaw`'https://example.org'`,
        url_encode: "sqlpage",
      });
      const got = md.link(sqlCat`${"name"}`, sqlCat`/p/${"id"}`);
      const expect =
        "('[' || name || '](' || 'https://example.org' || '/p/' || sqlpage.url_encode(id) || ')')";
      assertEquals(got, expect);
    },
  );

  await t.step("per-call base override: skip base entirely", () => {
    const md = markdownLinkFactory({
      base: sqlRaw`'https://x.com'`,
      url_encode: "sqlpage",
    });
    const got = md.link(sqlCat`${"label"}`, sqlCat`/y?id=${"id"}`, {
      base: false,
    });
    const expect =
      "('[' || label || '](' || '/y?id=' || sqlpage.url_encode(id) || ')')";
    assertEquals(got, expect);
  });

  await t.step(
    "idempotent per-part encoding: already-encoded or literal segments pass through",
    () => {
      const md = markdownLinkFactory({
        base: sqlRaw`'https://e.org'`,
        url_encode: "sqlpage",
      });
      const text = sqlCat`${"title"}`;
      // '/x/' is a literal -> not encoded; id is non-literal -> encoded.
      // The inner sqlpage.url_encode(id) is already encoded -> pass-through.
      const url = sqlRaw`'/x/' || ${sqlRaw`${"id"}`}`;
      const got = md.link(text, url);
      const expect =
        "('[' || title || '](' || 'https://e.org' || '/x/' || sqlpage.url_encode(id) || ')')";
      assertEquals(got, expect);
    },
  );

  await t.step("cat(): alias of sqlCat for ergonomic expressions", () => {
    const md = markdownLinkFactory();
    const u = md.cat`/z/${"id"}`; // same as sqlCat`/z/${"id"}`
    assertEquals(u, "('/z/' || id)");
  });

  await t.step(
    "encodeEachNonLiteral(): splits on top-level || and encodes only non-literals",
    () => {
      const md = markdownLinkFactory({ url_encode: "replace" });
      const expr = sqlCat`/a/${"x"}?q=${"y"}`; // -> ('/a/' || x || '?q=' || y)
      const mapped = md.encodeEachNonLiteral(expr);
      // '/a/' and '?q=' are literals -> not encoded. x and y are identifiers -> encoded.
      assertEquals(
        mapped,
        "'/a/' || replace(replace(replace(x, ' ', '%20'), '&', '%26'), '#', '%23') || '?q=' || replace(replace(replace(y, ' ', '%20'), '&', '%26'), '#', '%23')",
      );
    },
  );

  await t.step("splitTopLevelConcat(): respects quotes and parentheses", () => {
    const md = markdownLinkFactory();
    const expr = "('/a''b/' || (coalesce(x, '')) || 'q=' || y)";
    const parts = md.splitTopLevelConcat(expr);
    assertEquals(parts, ["'/a''b/'", "(coalesce(x, ''))", "'q='", "y"]);
  });

  await t.step("mdLink() with array-ish fragments via cat/sqlRaw", () => {
    const md = markdownLinkFactory({
      base: sqlRaw`'https://ex.org'`,
      url_encode: "sqlpage",
    });
    const text = [sqlRaw`${"first"}`, sqlRaw`' '`, sqlRaw`${"last"}`]; // → first || ' ' || last
    const url = md.cat`/p?id=${"pid"}&d=${"dept"}`;
    const got = md.link(text, url);
    const expect =
      "('[' || first || ' ' || last || '](' || 'https://ex.org' || " +
      "'/p?id=' || sqlpage.url_encode(pid) || '&d=' || sqlpage.url_encode(dept) || ')')";
    assertEquals(got, expect);
  });
});
