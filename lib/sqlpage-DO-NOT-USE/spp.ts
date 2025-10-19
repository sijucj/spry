import { literal } from "../universal/sql-text.ts";
import { PageRoute, RouteSupplier } from "./route.ts";

export type SqlPagePath =
  & {
    readonly path: string;
    readonly sql: string; // usually '${path}'
    readonly absURL: () => string; // usually (sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || '${path}')
    readonly homePath: () => string; // usually ('${path}' || '/index.sql')
    readonly isRoute: boolean;
  }
  & (
    | {
      readonly nature: "route";
      readonly isRoute: true;
    } & RouteSupplier
    | {
      readonly nature: "path";
      readonly isRoute: false;
    }
  );

export function sqlPagePath(candidate: string | PageRoute): SqlPagePath {
  const sql = literal(
    typeof candidate === "string" ? candidate : candidate.path,
  );
  const absURL = () =>
    `(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || ${sql})`;
  const homePath = () => `(${sql} || '/index.sql')`;

  if (typeof candidate === "string") {
    return {
      nature: "path",
      isRoute: false,
      path: candidate,
      sql,
      absURL,
      homePath,
    };
  } else {
    return {
      nature: "route",
      isRoute: true,
      route: candidate,
      sql,
      path: candidate.path,
      absURL,
      homePath,
    };
  }
}

export function sqlPagePathsFactory() {
  const encountered = new Map<string, SqlPagePath>();
  return {
    sqlPagePath: (candidate: Parameters<typeof sqlPagePath>[0]) => {
      const key = typeof candidate === "string" ? candidate : candidate.path;
      let spp = encountered.get(key);
      if (!spp) {
        spp = sqlPagePath(candidate);
        encountered.set(key, spp);
      }
      return spp;
    },
  };
}
