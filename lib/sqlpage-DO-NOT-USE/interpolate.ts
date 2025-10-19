import { SQL } from "../universal/sql-text.ts";
import { SqlPagePath } from "./spp.ts";

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

      return `
          SET ${n("total_rows")} = (${countSQL});
          SET ${n("limit")} = COALESCE(${$("limit")}, 50);
          SET ${n("offset")} = COALESCE(${$("offset")}, 0);
          SET ${n("total_pages")} = (${$("total_rows")} + ${
        $("limit")
      } - 1) / ${$("limit")};
          SET ${n("current_page")} = (${$("offset")} / ${$("limit")}) + 1;`;
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
