---
siteName: Demo
sqlpage-conf:
  database_url: "sqlite://app.db"
  listen_on: "0.0.0.0:8080"
  web_root: "./"
  site_prefix: "/sqlpage"
  https_domain: "example.com"
  host: "example.com"
  allow_exec: true
  max_uploaded_file_size: 1048576
  environment: "development"
  oidc:
    issuer_url: "https://issuer.example/"
    client_id: "abc"
    client_secret: "shh"
---

## Intro

```sql HEAD
-- head at start
PRAGMA foreign_keys = ON;
```

```sql admin/index.sql { route: { caption: "test" } }
select 1;
-- this is the path: ${path}
-- this is the caption: ${route.caption}
```

```sql users/list.sql
select 2;
-- this is the path: ${path}
-- this is the cell: ${cell?.kind}
-- this is the frontmatter in the cell's notebook: ${JSON.stringify(cell.frontmatter)}
```

```sql PARTIAL test-partial { newLocal: { type: "string", required: true } }
-- this is the path in test-partial: ${path}
-- this is the cell in test-partial: ${cell?.kind}
-- this is the newLocal in test-partial: ${newLocal}
```

```sql debug.sql
-- site prefixed: ${ctx.sitePrefixed("'test'")}

-- partial 1 (error): ${await partial("non-existent")}

-- partial 2 (works): ${await partial("test-partial", { newLocal: "passed from debug.sql"})}

-- partial 3 (error): ${await partial("test-partial", { mistypedNewLocal: "passed from debug.sql"})}

-- partial 4 (without await): ${partial("test-partial", { newLocal: "passed from debug.sql without await"})}

-- full context: ${JSON.stringify(ctx)}
```

```sql pagination.sql { route: { caption: "Unpivoted" } }
SELECT 'text' AS component, 'Pagination Example' AS title;

${paginate("sqlpage_files")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT * FROM "sqlpage_files"
${pagination.limit}; -- needed as part of SELECT for pagination
${pagination.navigation}

${paginate("another_table")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT * FROM "another_table"
${pagination.limit}; -- needed as part of SELECT for pagination
${pagination.navigation}
```

The following `LAYOUT` will be prefixed across every SQLPage page because no
paths are provided (`sql LAYOUT` without path is same as `sql LAYOUT **/*`).

The `${path}` will be replaced with the path of the page. `${ctx.*}` are all
state variables like `${ctx.directives}`, `${ctx.routes}`, etc. but the local
page variables are like `${page}`, `${route}`, `${cell}`, etc.

```sql LAYOUT
-- global LAYOUT (defaults to **/*)
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
-- add shell, etc. here
```

The following `LAYOUT` will be prefixed only for the admin paths:

```sql LAYOUT admin/**
-- admin/** LAYOUT
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
-- add shell, etc. here
```

## Explanation

```sql HEAD
-- head 2, near TAIL
```

```sql TAIL
-- done
```

## Appendix
