import { dirname } from "jsr:@std/path@^1";
import z from "jsr:@zod/zod@4";
import {
  fbPartialsCollection,
  Issue,
  PlaybookCodeCell,
  Source,
} from "../markdown/notebook/mod.ts";
import {
  parsedInfo,
  TaskDirectiveInspector,
  TaskDirectives,
} from "../task/cell.ts";
import {
  safeSourceText,
  SourceRelativeTo,
} from "../universal/content-acquisition.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { forestToStatelessViews } from "../universal/path-tree-tabular.ts";
import { raw as rawSQL, SQL, sqlCat } from "../universal/sql-text.ts";
import { executionPlan } from "../universal/task.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import { dropUndef } from "./conf.ts";
import {
  isSqlPageContent,
  SqlPageContent,
  sqlPageContentHelpers,
  SqlPageFileUpsert,
  sqlPagePathsFactory,
} from "./content.ts";
import * as interp from "./interpolate.ts";
import { markdownLinkFactory } from "./interpolate.ts";
import {
  isRouteSupplier,
  PageRoute,
  pageRouteSchema,
  pathExtensions,
  RoutesBuilder,
} from "./route.ts";

export type SqlPageProvenance = string;
export type SqlPageFrontmatter = Record<string, unknown> & {
  "sqlpage-conf"?: Record<string, unknown>;
};
export type SqlPageCellAttrs = Record<string, unknown>;
export type SqlPageIssue = Issue<SqlPageProvenance>;
export type SqlPageTDI = TaskDirectiveInspector<
  SqlPageProvenance,
  SqlPageFrontmatter,
  SqlPageCellAttrs,
  SqlPageIssue
>;

export const sqlCodeCellLang = "sql" as const;
export type SqlCodeCellLang = typeof sqlCodeCellLang;

export const sqlTaskHead = "HEAD" as const;
export const sqlTaskTail = "TAIL" as const;
export const sqlTaskSqlPageFileUpsert = "sqlpage_file-upsert" as const;
export const sqlTaskNature = [
  sqlTaskHead,
  sqlTaskTail,
  sqlTaskSqlPageFileUpsert,
] as const;
export type SqlTaskNature = typeof sqlTaskNature[number];

export function counter<Identifier>(identifier: Identifier, padValue = 4) {
  let value = -1;
  const incr = () => ++value;
  const nextPadded = () => String(incr()).padStart(padValue, "0");
  const nextText = (text = `${identifier}-`) =>
    `${text}${String(incr()).padStart(padValue, "0")}`;
  return { identifier, incr, nextPadded, nextText };
}

export function sqlHeadCellTDI(): SqlPageTDI {
  const heads = counter(sqlTaskHead);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLang) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // no identity, ignore
    if (pi.first.toLocaleUpperCase() != sqlTaskHead) return false;
    const identity = pi.identity(`sql.d/head/${heads.nextText()}`);
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "head_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
    };
  };
}

export function sqlTailCellTDI(): SqlPageTDI {
  const tails = counter(sqlTaskTail);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLang) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // no identity, ignore
    if (pi.first.toLocaleUpperCase() != sqlTaskTail) return false;
    const identity = pi.identity(`sql.d/head/${tails.nextText()}`);
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "tail_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
    };
  };
}

export function mutateRoute(
  cell: PlaybookCodeCell<string, SqlPageCellAttrs>,
  identity: string,
  registerIssue: (message: string, error?: unknown) => void,
) {
  if (!isRouteSupplier(cell.attrs)) return;
  const route = cell.attrs.route as PageRoute;
  if (!route.path) route.path = identity;
  const extensions = pathExtensions(route.path);
  route.pathBasename = extensions.basename;
  route.pathBasenameNoExtn = extensions.basename.split(".")[0];
  route.pathDirname = dirname(route.path);
  route.pathExtnTerminal = extensions.terminal;
  route.pathExtns = extensions.extensions;
  const parsed = z.safeParse(pageRouteSchema, route);
  if (!parsed.success) {
    registerIssue(
      `Zod error parsing route: ${z.prettifyError(parsed.error)}`,
      parsed.error,
    );
    return false;
  }
  return true;
}

export function sqlPageFileCellTDI(): SqlPageTDI {
  return ({ cell, registerIssue }) => {
    if (cell.language != sqlCodeCellLang) return false;
    const pi = parsedInfo(cell.info);
    if (!pi) return false; // no identity, ignore
    const path = pi.first;
    mutateRoute(cell, path, registerIssue);
    return {
      nature: "CONTENT",
      identity: path,
      content: {
        kind: "sqlpage_file_upsert",
        path,
        contents: cell.source,
        cell,
        asErrorContents: (text) => text.replaceAll(/^/gm, "-- "),
        isUnsafeInterpolatable: true,
        isInjectableCandidate: true,
      } satisfies SqlPageContent,
    };
  };
}

export function sqlPagePlaybookState() {
  const partials = fbPartialsCollection();
  const directives = new TaskDirectives<
    SqlPageProvenance,
    SqlPageFrontmatter,
    SqlPageCellAttrs,
    SqlPageIssue
  >(partials);
  directives.use(sqlHeadCellTDI());
  directives.use(sqlTailCellTDI());
  directives.use(sqlPageFileCellTDI()); // order matters, put head/tail before SqlPageFile
  const routes = new RoutesBuilder();
  const spp = sqlPagePathsFactory();
  return { directives, routes, spp, partials };
}

export type SqlPagePlaybookState = ReturnType<typeof sqlPagePlaybookState>;

export function sqlPageInterpolator() {
  const context = (state: SqlPagePlaybookState) => {
    const { directives, routes } = state;
    const pagination = {
      active: undefined as undefined | ReturnType<typeof interp.pagination>,
      prepare: interp.pagination,
      debug: `/* \${paginate("tableOrViewName")} not called yet*/`,
      limit: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navigation: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navWithParams: (..._extraQueryParams: string[]) =>
        `/* \${paginate("tableOrViewName")} not called yet*/`,
    };
    return {
      state,
      directives,
      routes,
      pagination,
      absUrlQuoted: interp.absUrlQuoted,
      absUrlUnquoted: interp.absUrlUnquoted,
      absUrlUnquotedEncoded: interp.absUrlUnquotedEncoded,
      absUrlQuotedEncoded: interp.absUrlQuotedEncoded,
      sitePrefixed: interp.absUrlQuoted,
      md: markdownLinkFactory({ url_encode: "replace" }),
      rawSQL,
      sqlCat,
      SQL,
      paginate: (tableOrViewName: string, whereSQL?: string) => {
        const pn = interp.pagination({ tableOrViewName, whereSQL });
        pagination.active = pn;
        pagination.debug = pn.debugVars();
        pagination.limit = pn.limit();
        pagination.navigation = pn.navigation();
        pagination.navWithParams = pn.navigation;
        return pagination.active.init();
      },
    };
  };

  async function mutateUpsertUnsafely(
    ctx: ReturnType<typeof context>,
    spfu: SqlPageFileUpsert,
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    const { state: { directives } } = ctx;
    const { path } = spfu;

    let errSource: string | undefined;
    try {
      // "ic" is basically a "layout"
      const ic = spfu.isInjectableCandidate
        ? directives.partials.findInjectableForPath(path)
        : undefined;

      if (spfu.isUnsafeInterpolatable) {
        const source = ic?.injection?.wrap(spfu.contents) ?? spfu.contents;
        errSource = source;

        // NOTE: This is intentionally unsafe. Do not feed untrusted content.
        // Assume you're treating code cell blocks as fully trusted source code.
        const mutated = await unsafeInterp.interpolate(source, {
          pagination: ctx.pagination,
          paginate: ctx.paginate,
          safeJsonStringify,
          SQL,
          cat: sqlCat,
          md: ctx.md,
          raw: rawSQL,
          ...spfu.cell?.attrs,
          ...spfu,
          partial: async (
            name: string,
            partialLocals?: Record<string, unknown>,
          ) => {
            const found = directives.partials.get(name);
            if (found) {
              const { content: partial, interpolate, locals } = await found
                .content({
                  ...partialLocals,
                  ...spfu.cell?.attrs,
                  ...spfu,
                });
              if (!interpolate) return partial;
              return await unsafeInterp.interpolate(partial, locals, [{
                template: partial,
              }]);
            } else {
              return `/* partial '${name}' not found */`;
            }
          },
        });

        if (mutated !== spfu.contents) {
          spfu.contents = String(mutated);
          spfu.isInterpolated = true;
        }
      } else if (ic && ic.injection) {
        spfu.contents = ic.injection.wrap(spfu.contents);
      }

      if (ic) spfu.partialInjected = ic;
      return spfu;
    } catch (error) {
      spfu.error = error;
      return {
        ...spfu,
        contents: spfu.asErrorContents(
          `finalSqlPageFileEntries error: ${
            String(error)
          }\n*****\nSOURCE:\n${errSource}\n${
            safeJsonStringify({ ctx: unsafeInterp.ctx, spf: spfu }, 2)
          }`,
          error,
        ),
      };
    }
  }

  async function mutateUnsafely(
    ctx: ReturnType<typeof context>,
    spc: SqlPageContent,
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    if (spc.kind === "sqlpage_file_upsert") {
      return await mutateUpsertUnsafely(ctx, spc, unsafeInterp);
    }
    return spc;
  }

  return { context, mutateUpsertUnsafely, mutateUnsafely };
}

export class SqlPagePlaybook {
  protected constructor() {
  }

  async *sources(init: { mdSources: string[]; srcRelTo: SourceRelativeTo }) {
    for await (const md of init.mdSources) {
      const safeMdSrc = await safeSourceText(md, init.srcRelTo, {
        baseUrl: new URL(import.meta.url),
      });
      if (safeMdSrc.nature == "error") {
        console.error(safeMdSrc);
        continue;
      }
      yield {
        provenance: typeof safeMdSrc.source === "string"
          ? safeMdSrc.source
          : safeMdSrc.source.href,
        content: safeMdSrc.text,
      } satisfies Source<SqlPageProvenance>;
    }
  }

  async prepare(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const { state } = init;
    const { directives: td, routes } = state;

    /*  Markdown Files' Fenced Cells
        ↓
        NotebookCodeCell (syntactic)
           ↓
           PlaybookCodeCell (contextual)
               ↓
               TaskDirective (semantic)
                   ↓
                   Task / TaskCell (executable)
                       ↓
                       TASK (executable)
                       CONTENT (optionally executable) */

    // directives now has all the tasks/content across all notebooks in memory
    await td.populate(() => this.sources(init));

    // build the routes tree from anything with { route: {...} } in fenced attrs
    for (const c of td.tasks.filter((c) => isRouteSupplier(c.attrs))) {
      routes.encounter(c.attrs.route as PageRoute);
    }

    const plan = executionPlan(state.directives.tasks);

    const spInterpolator = sqlPageInterpolator();
    const spiContext = spInterpolator.context(state);
    const unsafeInterp = unsafeInterpolator(spiContext);

    return {
      state,
      executionPlan: plan,
      spInterpolator,
      spiContext,
      unsafeInterp,
    };
  }

  async *sqlPageFiles(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const p = await this.prepare(init);
    const { state, spInterpolator, spiContext, unsafeInterp } = p;
    const { directives, routes } = state;
    const { sql: sqlSPF, json: jsonSPF } = sqlPageContentHelpers();

    for (const pd of directives.partialDirectives) {
      yield sqlSPF(
        `spry.d/auto/partial/${pd.partialDirective.partial.identity}.auto.sql`,
        `-- ${safeJsonStringify(pd)}\n${pd.partialDirective.partial.identity}`,
        { isPartial: true, cell: pd },
      );
    }

    const { mutateUnsafely } = spInterpolator;
    for await (const t of directives.tasks) {
      const { taskDirective: td } = t;
      if (td.nature === "CONTENT" && isSqlPageContent(td.content)) {
        yield mutateUnsafely(spiContext, td.content, unsafeInterp);
        if (td.content.cell) {
          const cell = td.content.cell;
          if (Object.entries(cell.attrs).length) {
            yield jsonSPF(
              `spry.d/auto/resource/${td.content.path}.auto.json`,
              JSON.stringify(dropUndef(cell.attrs), null, 2),
              { cell, isAutoGenerated: true },
            );
          }
        }
      }
    }

    const { forest, breadcrumbs, edges, serializers } = await routes.resolved();

    yield sqlSPF(
      `spry.d/auto/route/tree.auto.txt`,
      serializers.asciiTreeText({
        showPath: true,
        includeCounts: true,
      }),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/forest.auto.json`,
      JSON.stringify(forest.roots, null, 2),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/forest.schema.auto.json`,
      JSON.stringify(z.toJSONSchema(forest.schemas.forest), null, 2),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/breadcrumbs.auto.json`,
      JSON.stringify(breadcrumbs.crumbs, null, 2),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/breadcrumbs.schema.auto.json`,
      JSON.stringify(z.toJSONSchema(breadcrumbs.schema), null, 2),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/edges.auto.json`,
      JSON.stringify(edges.edges, null, 2),
      { isAutoGenerated: true },
    );
    yield jsonSPF(
      `spry.d/auto/route/edges.schema.auto.json`,
      JSON.stringify(z.toJSONSchema(edges.schemas.edges), null, 2),
      { isAutoGenerated: true },
    );

    const sv = forestToStatelessViews(forest, { viewPrefix: "navigation_" });
    yield sqlSPF(`sql.d/tail/navigation.auto.sql`, sv.sql, {
      kind: "tail_sql",
    });
    return p;
  }

  async execute(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const { state, executionPlan: plan } = await this.prepare(init);
    const { directives: td, routes } = state;

    console.log(td.issues);
    console.log(plan.dag.map((t) => t.taskId()));
    console.log((await routes.resolved()).candidates);

    return { state };
  }

  static instance() {
    return new SqlPagePlaybook();
  }
}
