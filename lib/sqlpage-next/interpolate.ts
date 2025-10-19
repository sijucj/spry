import {
  fragToSql,
  isSingleQuoted,
  SQL,
  sqlCat,
  SQLFrag,
  sqlRaw,
  stripOuterParens,
} from "../universal/sql-text.ts";
import { dedentIfFirstLineBlank } from "../universal/tmpl-literal-aide.ts";
import { SqlPagePath } from "./content.ts";

export const absUrlUnquoted = (path: string) =>
  `(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || ${path})`;

export const absUrlQuoted = (path: string) =>
  `(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || '${path}')`;

export const absUrlUnquotedEncoded = (path: string) =>
  `sqlpage.url_encode(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || ${path})`;

export const absUrlQuotedEncoded = (path: string) =>
  `sqlpage.url_encode(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || '${path}')`;

/**
 * Generates SQL pagination logic including initialization, debugging variables,
 * and rendering pagination controls for SQLPage.
 *
 * @param config - The configuration object for pagination.
 * @param config.varName - Optional function to customize variable names.
 * @param config.tableOrViewName - The name of the table or view to paginate. This is required if `countSQL` is not provided.
 * @param config.countSQL - Custom SQL supplier to count the total number of rows. This is required if `tableOrViewName` is not provided.
 *
 * @returns An object containing methods to initialize pagination variables,
 *          debug variables, and render pagination controls.
 *
 * @example
 * const paginationConfig = {
 *   varName: (name) => `custom_${name}`,
 *   tableOrViewName: 'my_table'
 * };
 * const paginationInstance = pagination(paginationConfig);
 * - required: paginationInstance.init() should be placed into a SQLa template to initialize SQLPage pagination;
 * - optional: paginationInstance.debugVars() should be placed into a SQLa template to view var values in web UI;
 * - required: paginationInstance.renderSimpleMarkdown() should be placed into SQLa template to show the next/prev pagination component in simple markdown;
 */
export const pagination = (
  config:
    & {
      varName?: (name: string) => string;
      whereSQL?: string;
    }
    & ({ readonly tableOrViewName: string; readonly countSQL?: never } | {
      readonly tableOrViewName?: never;
      readonly countSQL: string;
    }),
) => {
  // `n` renders the variable name for definition, $ renders var name for accessor
  const n = config.varName ?? ((name) => name);
  const $ = config.varName ?? ((name) => `$${n(name)}`);
  return {
    init: () => {
      const countSQL = config.countSQL
        ? config.countSQL
        : `SELECT COUNT(*) FROM ${config.tableOrViewName} ${
          config.whereSQL && config.whereSQL.length > 0 ? config.whereSQL : ``
        }`;

      return dedentIfFirstLineBlank(`
          SET ${n("total_rows")} = (${countSQL});
          SET ${n("limit")} = COALESCE(${$("limit")}, 50);
          SET ${n("offset")} = COALESCE(${$("offset")}, 0);
          SET ${n("total_pages")} = (${$("total_rows")} + ${
        $("limit")
      } - 1) / ${$("limit")};
          SET ${n("current_page")} = (${$("offset")} / ${$("limit")}) + 1;`);
    },

    limit: () => {
      return `LIMIT ${$("limit")} OFFSET ${$("offset")}`;
    },

    debugVars: () => {
      return `
          SELECT 'text' AS component,
              '- Start Row: ' || ${$("offset")} || '\n' ||
              '- Rows per Page: ' || ${$("limit")} || '\n' ||
              '- Total Rows: ' || ${$("total_rows")} || '\n' ||
              '- Current Page: ' || ${$("current_page")} || '\n' ||
              '- Total Pages: ' || ${$("total_pages")} as contents_md;`;
    },

    navigation: (...extraQueryParams: string[]) => {
      const whereTabvalue =
        extraQueryParams.find((item) => item.startsWith("$tab='")) || null;
      const filteredParams = extraQueryParams.filter((item) =>
        item !== whereTabvalue
      );
      return `
          SELECT 'text' AS component,
              (SELECT CASE WHEN CAST($current_page AS INTEGER) > 1 THEN '[Previous](?limit=' || $limit || '&offset=' || ($offset - $limit)${
        filteredParams.length
          ? " || " + filteredParams.map((qp) =>
            `COALESCE('&${n(qp)}=' ||  sqlpage.url_encode($${qp}), '')`
          ).join(" || ")
          : ""
      } || ')' ELSE '' END)
              || ' '
              || '(Page ' || $current_page || ' of ' || $total_pages || ") "
              || (SELECT CASE WHEN CAST($current_page AS INTEGER) < CAST($total_pages AS INTEGER) THEN '[Next](?limit=' || $limit || '&offset=' || ($offset + $limit)${
        filteredParams.length
          ? " || " + filteredParams.map((qp) =>
            `COALESCE('&${n(qp)}=' ||  sqlpage.url_encode($${qp}), '')`
          ).join(" || ")
          : ""
      } || ')' ELSE '' END)
              AS contents_md
          ${whereTabvalue ? ` WHERE ${whereTabvalue}` : ""};
        `;
    },
  };
};

/**
 * markdownLinkFactory — build safe, Markdown-style link expressions in SQL.
 *
 * Overview
 * ----------
 * This factory returns a small helper API for composing **type-safe SQL** strings that
 * render Markdown links of the form `[text](url)` (e.g., for SQLPage). It’s designed
 * as a **documented, complex example** of how to generate robust SQL from JavaScript /
 * TypeScript using the primitives in this module (`SQL`, `sqlRaw`, `sqlCat`, etc.).
 *
 * The best documentation is the **unit tests** (see “markdownLinkFactory — basics”),
 * which act as an executable cookbook demonstrating common and edge-case scenarios.
 *
 * Core behavior
 * -------------
 * - **Base URL is never encoded.** It is assumed to be safe or already encoded.
 * - **URL parts are encoded per segment**: for a URL expression built with `||`,
 *   each **non-literal** segment (identifiers, expressions) is wrapped in
 *   `sqlpage.url_encode(...)`. Single-quoted string literals (e.g. `'/x/'`, `'?q='`)
 *   are **not** encoded.
 * - All inputs accept `SQLFrag` (string | `SQL` | `sqlRaw` | arrays of those) so
 *   callers can mix values, raw identifiers, and composed expressions safely.
 *
 * Returned API
 * ------------
 * const md = markdownLinkFactory(init?);
 *
 * - `md.mdLink(textExpr, urlExpr, opts?) : string`
 *    Build a SQL expression producing a Markdown link: `[text](base + encoded(url))`
 *    where:
 *      • `textExpr` → label expression (`SQLFrag`)
 *      • `urlExpr`  → URL expression (`SQLFrag`), split on top-level `||`
 *                     and **only non-literals** are encoded
 *      • `opts.base` (optional) overrides the factory’s base for this call
 *        - `false` → no base; use only the encoded URL parts
 *        - `SQLFrag` → custom base (left unencoded)
 *
 * - `md.cat\`...\` : string`
 *    Convenience alias for `sqlCat` to build concatenation expressions ergonomically.
 *
 * - `md.raw` : typeof `sqlRaw`
 * - `md.SQL` : typeof `SQL`
 *    Expose the underlying primitives for advanced composition.
 *
 * - `md.splitTopLevelConcat(expr: string) : string[]`
 *    Utility that splits a SQL expression on **top-level** `||`, respecting
 *    parentheses and quoted strings. Helpful for advanced assembly.
 *
 * - `md.encodeEachNonLiteral(expr: string) : string`
 *    Returns a SQL expression where each **non-literal** top-level segment is wrapped
 *    with `sqlpage.url_encode(...)`. Literals remain as-is; already-encoded parts are
 *    left unchanged. (Used internally by `mdLink`.)
 *
 * - `md.getBase() : string`
 *    Introspect the resolved base configured by the factory.
 *
 * Initialization
 * --------------
 * markdownLinkFactory(init?: { base?: SQLFrag | false })
 *  - `base`: left **unencoded** and prefixed to all `mdLink()` results
 *     • `undefined` → defaults to `sqlpage.environment_variable('SQLPAGE_SITE_PREFIX')`
 *     • `false`     → no base (use only encoded URL parts)
 *     • `SQLFrag`   → a custom base expression (verbatim)
 *
 * Usage examples (see unit tests for more)
 * ----------------------------------------
 * ```ts
 * const md = markdownLinkFactory(); // default base = env('SQLPAGE_SITE_PREFIX')
 *
 * // Basic: label is an identifier; URL = literal + identifier (only id encoded)
 * const label = md.cat`${"name"}`;           // → name
 * const url   = md.cat`/p/${"id"}`;          // → ('/p/' || id)
 * md.mdLink(label, url);
 * // → ('[' || name || '](' || sqlpage.environment_variable('SQLPAGE_SITE_PREFIX')
 * //    || '/p/' || sqlpage.url_encode(id) || ')')
 *
 * // Custom base for all links built by this factory
 * const md2 = markdownLinkFactory({ base: sqlRaw`'https://example.org'` });
 * md2.mdLink(md2.cat`${"title"}`, md2.cat`/x?id=${"doc_id"}`);
 * // → ('[' || title || '](' || 'https://example.org'
 * //    || '/x?id=' || sqlpage.url_encode(doc_id) || ')')
 *
 * // Per-call override to skip base entirely
 * md.mdLink(label, url, { base: false });
 * // → ('[' || name || '](' || '/p/' || sqlpage.url_encode(id) || ')')
 * ```
 *
 * Notes
 * -----
 * - Treat this factory as a **pattern** for building higher-level, type-safe SQL helpers
 *   targeting specific tools (like SQLPage) while keeping the low-level power of `SQL`,
 *   `sqlRaw`, and `sqlCat`.
 * - Prefer `SQL.safe()` for executing parameterized queries; helpers here focus on
 *   generating readable, testable SQL **strings** for presentation or derived content.
 */
export function markdownLinkFactory(
  init?: { base?: SQLFrag | false; url_encode?: false | "sqlpage" | "replace" },
) {
  // Resolve base once (left unencoded).
  const defaultBase = init?.base === false
    ? ""
    : init?.base === undefined
    ? "sqlpage.environment_variable('SQLPAGE_SITE_PREFIX')"
    : fragToSql(init.base);

  // Split top-level a || b || c (respects quotes & parentheses)
  const splitTopLevelConcat = (expr: string): string[] => {
    const s = stripOuterParens(expr).trim();
    const parts: string[] = [];
    let cur = "", depth = 0, inSQ = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inSQ) {
        cur += ch;
        if (ch === "'" && s[i + 1] === "'") {
          cur += "'";
          i++;
          continue;
        }
        if (ch === "'") inSQ = false;
        continue;
      }
      if (ch === "'") {
        inSQ = true;
        cur += ch;
        continue;
      }
      if (ch === "(") {
        depth++;
        cur += ch;
        continue;
      }
      if (ch === ")") {
        depth--;
        cur += ch;
        continue;
      }
      if (depth === 0 && ch === "|" && s[i + 1] === "|") {
        parts.push(cur.trim());
        cur = "";
        i++;
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };

  // Encode each non-literal part (skip single-quoted literals; keep already-encoded)
  const encodeEachNonLiteral = (expr: string): string => {
    const parts = splitTopLevelConcat(expr);
    if (parts.length === 0) return "''";
    const mapped = parts.map((p) => {
      if (isSingleQuoted(p)) return p; // literal → leave as-is
      if (init?.url_encode) {
        switch (init.url_encode) {
          case "sqlpage":
            return `sqlpage.url_encode(${p})`;
          case "replace":
            return `replace(replace(replace(${p}, ' ', '%20'), '&', '%26'), '#', '%23')`;
        }
      }
      return p; // already encoded → pass-through
    });
    return mapped.join(" || "); // no extra outer parens
  };

  // Public cat helper (alias of sqlCat) for nicer ergonomics.
  const cat = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    sqlCat(strings, ...values);

  function mdLink(
    textExpr: SQLFrag,
    urlExpr: SQLFrag,
    opts?: { base?: SQLFrag | false },
  ): string {
    const text = fragToSql(textExpr);
    const url = fragToSql(urlExpr);

    // Base is left unencoded
    const base = opts?.base === undefined
      ? defaultBase
      : opts.base === false
      ? ""
      : fragToSql(opts.base);

    const encodedUrlParts = encodeEachNonLiteral(url); // encode ONLY non-literal parts
    const fullUrl = base ? `${base} || ${encodedUrlParts}` : encodedUrlParts;

    return sqlCat`[${text}](${fullUrl})`;
  }

  return {
    link: mdLink,
    // convenience & low-level tools
    cat,
    raw: sqlRaw,
    SQL,
    splitTopLevelConcat,
    encodeEachNonLiteral,
    stripOuterParens,
    getBase: () => defaultBase,
  };
}
//   breadcrumbsSQL(
//     activePath: string,
//     ...additional: ({ title: string; titleExpr?: never; link?: string } | {
//       title?: never;
//       titleExpr: string;
//       link?: string;
//     })[]
//   ) {
//     return ws.unindentWhitespace(`
//         SELECT 'breadcrumb' as component;
//         WITH RECURSIVE breadcrumbs AS (
//             SELECT
//                 COALESCE(abbreviated_caption, caption) AS title,
//                 COALESCE(url, path) AS link,
//                 parent_path, 0 AS level,
//                 namespace
//             FROM sqlpage_aide_navigation
//             WHERE namespace = 'prime' AND path='${activePath.replaceAll("'", "''")}'
//             UNION ALL
//             SELECT
//                 COALESCE(nav.abbreviated_caption, nav.caption) AS title,
//                 COALESCE(nav.url, nav.path) AS link,
//                 nav.parent_path, b.level + 1, nav.namespace
//             FROM sqlpage_aide_navigation nav
//             INNER JOIN breadcrumbs b ON nav.namespace = b.namespace AND nav.path = b.parent_path
//         )
//         SELECT title ,
//         ${this.absoluteURL("/")}||link as link
//         FROM breadcrumbs ORDER BY level DESC;`) +
//       (additional.length
//         ? (additional.map((crumb) => `\nSELECT ${crumb.title ? `'${crumb.title}'` : crumb.titleExpr} AS title, '${crumb.link ?? "#"}' AS link;`))
//         : "");
//   }

//   /**
//    * Assume caller's method name contains "path/path/file.sql" format, reflect
//    * the method name in the call stack and assume that's the path then compute
//    * the breadcrumbs.
//    * @param additional any additional crumbs to append
//    * @returns the SQL for active breadcrumbs
//    */
//   activeBreadcrumbsSQL(
//     ...additional: ({ title: string; titleExpr?: never; link?: string } | {
//       title?: never;
//       titleExpr: string;
//       link?: string;
//     })[]
//   ) {
//     return this.breadcrumbsSQL(
//       this.sqlPagePathComponents(3)?.path ?? "/",
//       ...additional,
//     );
//   }

/**
 * Assume caller's method name contains "path/path/file.sql" format, reflect
 * the method name in the call stack and assume that's the path then compute
 * the page title.
 * @returns the SQL for page title
 */
export const activePageTitle = (spp?: SqlPagePath) => {
  return SQL`
       SELECT 'title' AS component, (SELECT COALESCE(title, caption)
       FROM sqlpage_aide_navigation
       WHERE namespace = 'prime' AND path = ${spp?.path ?? "/"}) as contents;
    `;
};

/**
 * Assume caller's method name contains "path/path/file.sql" format, reflect
 * the method name in the call stack and assume that's the path then create a
 * link to the page's source in /console/sqlpage-files/*.
 * @returns the SQL for linking to this page's source
 */
export const activePageSource = (spp: SqlPagePath) => {
  return `
    SELECT 'text' AS component, '[View ${
    spp.isRoute ? spp.route.caption : spp.path
  }](' || ${
    absUrlQuoted(`/console/sqlpage-files/sqlpage-file.sql?path=${spp.path}`)
  } || ')' AS contents_md;
  `;
};
