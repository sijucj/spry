// deno-lint-ignore-file no-explicit-any
/**
 * path-tree-tabular.ts
 *
 * Turns a generic PathTree (from path-tree.ts) into relational, SQL-friendly tables
 * plus convenience SQL views. Three main exports:
 *
 * 1) forestToTabular():
 *    - Consumes a built forest (the result of `await pathTree(...)`).
 *    - Produces strongly-typed tabular arrays (node, edge, payload, breadcrumb).
 *    - Stays pure (no DB I/O) — you can inspect/transform before emitting SQL.
 *
 * 2) forestToStatelessViews():
 *    - Emits **only views** that materialize the tabular data using inline `VALUES` unions,
 *      so **no tables are required**. Useful for read-only dashboards or ephemeral querying.
 *      Views are prefixed (e.g., `nav_`) but never suffixed.
 *      **Always** drops the views first, then recreates.
 *
 * 3) forestToStatefulViews():
 *    - Creates tables (DDL), inserts seed data (DML), and then creates views **on top of**
 *      those tables. Table names use singular nouns and accept both a prefix and a suffix
 *      (e.g., `nav_` + `_stateful`). View names use singular nouns and only accept a prefix.
 *      **Always** drops tables and views first, then recreates (immutable snapshots).
 *
 * Notes:
 * - Breadcrumbs: We derive them via `pathTreeNavigation(forest).ancestors(...)` rather than
 *   recomputing from parentMap. For each *container path*, we locate a representative payload
 *   within that container's subtree (index file preferred) and compute its ancestors.
 * - Edges: Pulled from `forestToEdges(forest)` (no recomputation).
 * - Payloads: Serialized as JSON text via `payloadSerializer` hook (default JSON.stringify).
 */

import { forestToEdges, pathTree, pathTreeNavigation } from "./path-tree.ts";

// ---------------------------------------------------------------------------
// Tabular types (use Tabular* prefix)
// ---------------------------------------------------------------------------

export type TabularNode<RowPath extends string> = {
  path: RowPath; // PRIMARY KEY
  parent_path: RowPath | null; // null for roots
  basename: string;
  virtual: 0 | 1; // synthesized container (1) or not (0)
  is_index: 0 | 1; // path itself is index-like filename
};

export type TabularEdge = { parent: string; child: string };

export type TabularPayload<RowPath extends string> = {
  path: RowPath; // FK -> node.path
  ord: number; // stable order if multiple payloads
  json: string; // serialized payload JSON
};

export type TabularBreadcrumb<RowPath extends string> = {
  path: RowPath; // container path this breadcrumb describes
  depth: number; // 0-based depth
  crumb_path: RowPath; // ancestor container path
  crumb_basename: string; // ancestor basename label
};

export type ForestToTabularResult<Node, RowPath extends string> = {
  node: TabularNode<RowPath>[];
  edge: TabularEdge[];
  payload: TabularPayload<RowPath>[];
  breadcrumb: TabularBreadcrumb<RowPath>[];
  normalize: (p: string) => RowPath;
};

export type ForestToTabularOptions<Node, RowPath extends string> = {
  payloadSerializer?: (p: Node) => string; // default JSON.stringify
};

// ---------------------------------------------------------------------------
// forestToTabular (uses pathTreeNavigation + forestToEdges)
// ---------------------------------------------------------------------------

export function forestToTabular<Node, RowPath extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, RowPath>>>,
  options: ForestToTabularOptions<Node, RowPath> = {},
): ForestToTabularResult<Node, RowPath> {
  const payloadSerializer = options.payloadSerializer ??
    ((p: Node) => JSON.stringify(p));

  // 1) Edges (canonical) — sourced directly
  const { edges } = forestToEdges<Node, RowPath>(forest);

  // 2) Nodes & Payloads (flatten)
  const node: TabularNode<RowPath>[] = [];
  const payload: TabularPayload<RowPath>[] = [];

  const walk = (n: (typeof forest.roots)[number]) => {
    const parent_path = forest.parentMap.get(n.path) ?? null;
    node.push({
      path: n.path as RowPath,
      parent_path: parent_path as RowPath | null,
      basename: n.basename,
      virtual: n.virtual ? 1 : 0,
      is_index: forest.isIndexFile(n.path) ? 1 : 0,
    });
    if (n.payloads?.length) {
      n.payloads.forEach((p, i) =>
        payload.push({
          path: n.path as RowPath,
          ord: i,
          json: payloadSerializer(p),
        })
      );
    }
    n.children.forEach(walk);
  };
  forest.roots.forEach(walk);

  // 3) Breadcrumbs via pathTreeNavigation
  // 3) Breadcrumbs via pathTreeNavigation (no recomputation)
  const breadcrumb: TabularBreadcrumb<RowPath>[] = [];
  const nav = pathTreeNavigation<Node, RowPath>(forest);

  // helper: find a representative payload within/under a node (index child preferred)
  const anyPayloadInSubtree = (
    n: (typeof forest.roots)[number],
  ): Node | null => {
    if (n.payloads?.length) return n.payloads[0];
    const idx = n.children.find((c) => forest.isIndexFile(c.path));
    if (idx?.payloads?.length) return idx.payloads[0];
    for (const c of n.children) {
      const found = anyPayloadInSubtree(c as any);
      if (found) return found;
    }
    return null;
  };

  const ROOT = forest.normalize("/") as RowPath;

  // iterate each container path once
  for (const [p] of forest.treeByPath.entries()) {
    const containerPath =
      (forest.isContainerPath(p) ? p : forest.dirname(p)) as RowPath;
    if (breadcrumb.some((b) => b.path === containerPath)) continue;

    const containerNode = forest.treeByPath.get(containerPath);

    // Special-case root: no node stored, but we still want a self crumb
    if (!containerNode && containerPath === ROOT) {
      breadcrumb.push({
        path: ROOT,
        depth: 0,
        crumb_path: ROOT,
        crumb_basename: "/",
      });
      continue;
    }

    if (!containerNode) continue; // no node & not root — skip

    const sample = anyPayloadInSubtree(containerNode);
    if (!sample) {
      // No payloads under this container — still ensure a self crumb
      breadcrumb.push({
        path: containerPath,
        depth: 0,
        crumb_path: containerPath,
        crumb_basename: containerNode.basename,
      });
      continue;
    }

    const crumbs = nav.ancestors(sample);

    // If top-level (no parent), prepend synthetic root crumb
    const isTopLevel = (forest.parentMap.get(containerPath) ?? null) === null;
    let depth = 0;
    if (isTopLevel) {
      breadcrumb.push({
        path: containerPath,
        depth: depth++,
        crumb_path: ROOT,
        crumb_basename: "/",
      });
    }

    for (const c of crumbs) {
      breadcrumb.push({
        path: containerPath,
        depth: depth++,
        crumb_path: c.node.path as RowPath,
        crumb_basename: c.node.basename,
      });
    }
  }

  return {
    node,
    edge: edges,
    payload,
    breadcrumb,
    normalize: forest.normalize,
  };
}

// ---------------------------------------------------------------------------
// SQL emitters — singular nouns; always DROP then CREATE
// ---------------------------------------------------------------------------

type StatefulOptions = {
  tablePrefix?: string; // e.g., "nav_"
  tableSuffix?: string; // e.g., "_stateful"
  viewPrefix?: string; // e.g., "nav_"
  extraIndexes?: string[];
};

type StatelessOptions = { viewPrefix?: string };

export type ForestToStatefulViewsResult = {
  sql: string;
  sections: { ddl: string; dml: string; views: string; indexes: string };
};

export type ForestToStatelessViewsResult = { sql: string };

const sqlQuote = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const valuesList = (rows: string[][]) =>
  rows.map((cols) => `(${cols.join(", ")})`).join(",\n");

// ---------------------------------------------------------------------------
// forestToStatelessViews — no tables; inline VALUES in views (singular names)
// ---------------------------------------------------------------------------

export function forestToStatelessViews<Node, RowPath extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, RowPath>>>,
  opts: StatelessOptions = {},
): ForestToStatelessViewsResult {
  const viewPrefix = opts.viewPrefix ?? "nav_";
  const V = (name: string) => `${viewPrefix}${name}`;

  const { node, edge, payload, breadcrumb } = forestToTabular<Node, RowPath>(
    forest,
  );

  const valuesView = (name: string, cols: string[], rows: string[][]) => {
    const drop = `DROP VIEW IF EXISTS ${V(name)};\n`;
    const header = `CREATE VIEW ${V(name)} AS\n`;
    if (!rows.length) {
      // Empty: emit a dummy CTE with NULLs and WHERE 0 to yield zero rows
      const nulls = cols.map(() => "NULL").join(", ");
      return drop + header +
        `WITH t(${cols.join(", ")}) AS (SELECT ${nulls}) ` +
        `SELECT * FROM t WHERE 0;\n`;
    }
    return drop + header +
      `WITH t(${cols.join(", ")}) AS (\n  VALUES\n  ${valuesList(rows)}\n)\n` +
      `SELECT * FROM t;\n`;
  };

  const sqlParts: string[] = [];

  // node
  sqlParts.push(valuesView(
    "node",
    ["path", "parent_path", "basename", "virtual", "is_index"],
    node.map((n) => [
      sqlQuote(n.path),
      n.parent_path == null ? "NULL" : sqlQuote(n.parent_path),
      sqlQuote(n.basename),
      String(n.virtual),
      String(n.is_index),
    ]),
  ));

  // edge
  sqlParts.push(valuesView(
    "edge",
    ["parent", "child"],
    edge.map((e) => [sqlQuote(e.parent), sqlQuote(e.child)]),
  ));

  // payload
  sqlParts.push(valuesView(
    "payload",
    ["path", "ord", "json"],
    payload.map((p) => [sqlQuote(p.path), String(p.ord), sqlQuote(p.json)]),
  ));

  // breadcrumb
  sqlParts.push(valuesView(
    "breadcrumb",
    ["path", "depth", "crumb_path", "crumb_basename"],
    breadcrumb.map((
      b,
    ) => [
      sqlQuote(b.path),
      String(b.depth),
      sqlQuote(b.crumb_path),
      sqlQuote(b.crumb_basename),
    ]),
  ));

  // child (derived)
  sqlParts.push(
    `DROP VIEW IF EXISTS ${V("child")};\n` +
      `CREATE VIEW ${V("child")} AS\n` +
      `SELECT p.path AS parent_path, c.path AS child_path, c.basename AS child_basename, c.virtual, c.is_index\n` +
      `FROM ${V("node")} p\n` +
      `JOIN ${V("node")} c ON c.parent_path = p.path;\n`,
  );

  // descendant (recursive CTE)
  sqlParts.push(
    `DROP VIEW IF EXISTS ${V("descendant")};\n` +
      `CREATE VIEW ${V("descendant")} AS\n` +
      `WITH RECURSIVE d(root_path, path, depth) AS (\n` +
      `  SELECT n.path AS root_path, n.path, 0 AS depth FROM ${V("node")} n\n` +
      `  UNION ALL\n` +
      `  SELECT d.root_path, c.path, d.depth + 1\n` +
      `  FROM d\n` +
      `  JOIN ${V("node")} c ON c.parent_path = d.path\n` +
      `)\n` +
      `SELECT * FROM d;\n`,
  );

  return { sql: sqlParts.join("\n") };
}

// ---------------------------------------------------------------------------
// forestToStatefulViews — tables + inserts + views (singular names)
// ---------------------------------------------------------------------------

export function forestToStatefulViews<Node, RowPath extends string = string>(
  forest: Awaited<ReturnType<typeof pathTree<Node, RowPath>>>,
  opts: StatefulOptions = {},
  tabOpts: ForestToTabularOptions<Node, RowPath> = {},
): ForestToStatefulViewsResult {
  const tablePrefix = opts.tablePrefix ?? "nav_";
  const tableSuffix = opts.tableSuffix ?? "_stateful";
  const viewPrefix = opts.viewPrefix ?? "nav_";

  const T = (name: string) => `${tablePrefix}${name}${tableSuffix}`; // table name (singular)
  const V = (name: string) => `${viewPrefix}${name}`; // view name (singular)

  const { node, edge, payload, breadcrumb } = forestToTabular<Node, RowPath>(
    forest,
    tabOpts,
  );

  // DDL ----------------------------------------------------------------------
  const ddlParts: string[] = [];
  ddlParts.push(
    `DROP TABLE IF EXISTS ${T("node")};\n` +
      `CREATE TABLE ${T("node")}(\n` +
      `  path TEXT PRIMARY KEY,\n` +
      `  parent_path TEXT REFERENCES ${T("node")}(path) ON DELETE SET NULL,\n` +
      `  basename TEXT NOT NULL,\n` +
      `  virtual INTEGER NOT NULL CHECK (virtual IN (0,1)),\n` +
      `  is_index INTEGER NOT NULL CHECK (is_index IN (0,1))\n` +
      `);\n\n` +
      `DROP TABLE IF EXISTS ${T("edge")};\n` +
      `CREATE TABLE ${T("edge")}(\n` +
      `  parent TEXT NOT NULL,\n` +
      `  child TEXT NOT NULL\n` +
      `);\n` +
      `DROP TABLE IF EXISTS ${T("payload")};\n` +
      `CREATE TABLE ${T("payload")}(\n` +
      `  path TEXT NOT NULL REFERENCES ${
        T("node")
      }(path) ON DELETE CASCADE,\n` +
      `  ord INTEGER NOT NULL,\n` +
      `  json TEXT NOT NULL,\n` +
      `  PRIMARY KEY (path, ord)\n` +
      `);\n\n` +
      `DROP TABLE IF EXISTS ${T("breadcrumb")};\n` +
      `CREATE TABLE ${T("breadcrumb")}(\n` +
      `  path TEXT NOT NULL REFERENCES ${
        T("node")
      }(path) ON DELETE CASCADE,\n` +
      `  depth INTEGER NOT NULL,\n` +
      `  crumb_path TEXT NOT NULL REFERENCES ${
        T("node")
      }(path) ON DELETE CASCADE,` +
      `  crumb_basename TEXT NOT NULL,\n` +
      `  PRIMARY KEY (path, depth)\n` +
      `);\n`,
  );

  // DML ----------------------------------------------------------------------
  const dmlParts: string[] = [];

  if (node.length) {
    const rows = node.map((n) => [
      sqlQuote(n.path),
      n.parent_path == null ? "NULL" : sqlQuote(n.parent_path),
      sqlQuote(n.basename),
      String(n.virtual),
      String(n.is_index),
    ]);
    dmlParts.push(
      `INSERT INTO ${T("node")}(path, parent_path, basename, virtual, is_index)
VALUES
  ${valuesList(rows)};\n`,
    );
  }

  if (edge.length) {
    const rows = edge.map((e) => [sqlQuote(e.parent), sqlQuote(e.child)]);
    dmlParts.push(`INSERT INTO ${T("edge")}(parent, child)
VALUES  ${valuesList(rows)};`);
  }

  if (payload.length) {
    const rows = payload.map((
      p,
    ) => [sqlQuote(p.path), String(p.ord), sqlQuote(p.json)]);
    dmlParts.push(`INSERT INTO ${T("payload")}(path, ord, json)
VALUES ${valuesList(rows)};\n`);
  }

  if (breadcrumb.length) {
    const rows = breadcrumb.map((
      b,
    ) => [
      sqlQuote(b.path),
      String(b.depth),
      sqlQuote(b.crumb_path),
      sqlQuote(b.crumb_basename),
    ]);
    dmlParts.push(
      `INSERT INTO ${T("breadcrumb")}(path, depth, crumb_path, crumb_basename)
VALUES ${valuesList(rows)};\n`,
    );
  }

  // Views (always DROP then CREATE) -----------------------------------------
  const viewsParts: string[] = [];

  // child
  viewsParts.push(
    `DROP VIEW IF EXISTS ${V("child")};\n` +
      `CREATE VIEW ${V("child")} AS\n` +
      `SELECT p.path AS parent_path, c.path AS child_path, c.basename AS child_basename, c.virtual, c.is_index\n` +
      `FROM ${T("node")} p\n` +
      `JOIN ${T("node")} c ON c.parent_path = p.path;\n\n`,
  );

  // breadcrumb (dynamic via recursive CTE)
  viewsParts.push(
    `DROP VIEW IF EXISTS ${V("breadcrumb")};\n` +
      `CREATE VIEW ${V("breadcrumb")} AS\n` +
      `WITH RECURSIVE b(path, depth, crumb_path, crumb_basename) AS (\n` +
      `  SELECT n.path, 0 AS depth, n.path AS crumb_path, n.basename AS crumb_basename\n` +
      `  FROM ${T("node")} n\n` +
      `  WHERE n.parent_path IS NULL\n` +
      `  UNION ALL\n` +
      `  SELECT b.path, b.depth + 1, c.path, c.basename\n` +
      `  FROM b\n` +
      `  JOIN ${T("node")} c ON c.parent_path = b.crumb_path\n` +
      `)\n` +
      `SELECT * FROM b;\n\n`,
  );

  // descendant (recursive CTE)
  viewsParts.push(
    `DROP VIEW IF EXISTS ${V("descendant")};\n` +
      `CREATE VIEW ${V("descendant")} AS\n` +
      `WITH RECURSIVE d(root_path, path, depth) AS (\n` +
      `  SELECT n.path AS root_path, n.path, 0 AS depth FROM ${T("node")} n\n` +
      `  UNION ALL\n` +
      `  SELECT d.root_path, c.path, d.depth + 1\n` +
      `  FROM d\n` +
      `  JOIN ${T("node")} c ON c.parent_path = d.path\n` +
      `)\n` +
      `SELECT * FROM d;\n\n`,
  );

  // edge
  viewsParts.push(
    `DROP VIEW IF EXISTS ${V("edge")};\n` +
      `CREATE VIEW ${V("edge")} AS\n` +
      `SELECT parent, child FROM ${T("edge")};\n\n`,
  );

  // Indexes ------------------------------------------------------------------
  const idxParts: string[] = [];
  idxParts.push(
    `CREATE INDEX ${T("node_parent_idx")} ON ${T("node")}(parent_path);\n`,
  );
  idxParts.push(
    `CREATE INDEX ${T("payload_path_idx")} ON ${T("payload")}(path);\n`,
  );
  idxParts.push(
    `CREATE INDEX ${T("breadcrumb_path_idx")} ON ${T("breadcrumb")}(path);\n`,
  );

  const ddl = ddlParts.join("\n");
  const dml = dmlParts.join("\n");
  const views = viewsParts.join("\n");
  const indexes = idxParts.join("\n");

  const sql = [ddl, dml, views, indexes].filter(Boolean).join("\n\n");

  return { sql, sections: { ddl, dml, views, indexes } };
}
