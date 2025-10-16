---
sqlpage-conf:
  database_url: "sqlite://scf-2025.3.sqlite.db?mode=rwc"
  web_root: "./"
  allow_exec: true
  port: 9227
---

## Secure Controls Framework (SCF) Exploration

This script automates the conversion of the latest Secure Controls Framework
(SCF) Excel workbook from the
[official SCF GitHub repository](https://github.com/securecontrolsframework/securecontrolsframework)
into a structured SQLite database.

- Uses DuckDB with its built-in `excel` and `sqlite` extensions.
- Reads each major worksheet from the SCF Excel workbook (e.g., _SCF 2025.3_,
  _Authoritative Sources_, _Assessment Objectives_, etc.).
- Creates corresponding SQLite tables with matching names (e.g., `scf_control`,
  `scf_authoritative_source`, etc.).
- All columns are imported as untyped strings (`VARCHAR`), preserving the
  original Excel text exactly as-is.
- Adds a metadata column `scf_xls_source` to every table to record the source
  workbook name for provenance.
- Creates a registry view `scf_xls_sheet` listing each imported sheet, its
  corresponding table, and the source file name.

Instructions:

1. Download the SCF Excel workbook from the GitHub repo.
2. Run the DuckDB SQL script.

   ```bash
   rm -f scf-2025.3.sqlite.db && cat prepare.duckdb.sql | duckdb ":memory:"
   ```
3. Build the SQLPage notebook page from `README.md` and pipe it into the database:
  
   ```bash
   ../../../lib/sqlpage/spry.ts --md README.md --package --conf sqlpage/sqlpage.json | sqlite3 scf-2025.3.sqlite.db
   ```

4. Start the SQLPage server:

   - Linux (from repository root): `SQLPAGE_SITE_PREFIX="" sqlpage.bin`

## Layout

```sql LAYOUT
-- BEGIN: global LAYOUT (defaults to **/*)
SELECT 'shell' AS component,
       'Secure Controls Framework (SCF) Explorer' AS title,
       NULL AS icon,
       'https://www.surveilr.com/assets/brand/content-assembler.ico' AS favicon,
       'https://www.surveilr.com/assets/brand/compliance-explorer.png' AS image,
       'fluid' AS layout,
       true AS fixed_top_menu,
       'index.sql' AS link,
       '{"link":"/index.sql","title":"Home"}' AS menu_item;

SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
SET page_title  = json_extract($resource_json, '$.route.caption');
-- END: global LAYOUT (defaults to **/*)
```



```sql index.sql { route: { caption: "Home" } }

SELECT
  'card' AS component,
  '' AS title,
  2 AS columns;
  SELECT
  json_extract(np.json, '$.caption') AS title,  
  json_extract(np.json, '$.caption') AS description_md,
  ${ctx.absUrlUnquoted("nn.path")} as link
  FROM navigation_node AS nn
  INNER JOIN navigation_payload AS np
  ON nn.path = np.path
  WHERE nn.is_index <> 1 
  AND nn.virtual <> 1 
  AND nn.parent_path = '/scf';  
  

```
## Unpivoted page

```sql scf/regime_control_unpivoted.sql { route: { caption: "Long form of SCF x Regime mappings" } }
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_control_unpivoted")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'SCF #' as  markdown,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT
  '[' || regime_label || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime_label, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime",  
  '['|| scf_no || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime_control_unpivoted_details.sql?scf_no=' || replace(replace(replace(scf_no, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' as "SCF #",  
  scf_domain AS "SCF Domain",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker",
  regime_column_ordinal AS "Regime Column Ordinal"
FROM "scf_regime_control_unpivoted"
ORDER BY scf_no, regime_column_ordinal
${pagination.limit}; 
${pagination.navigation}
```

## Regime Controls page

```sql scf/regime_control.sql { route: { caption: "Clean list of regime mappings" } }
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_control")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search,
       'Regime' AS markdown;              -- interpret the "Regime" column as Markdown
SELECT
  scf_no AS "SCF #",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker"
FROM "scf_regime_control"
ORDER BY scf_no
${pagination.limit}; 
${pagination.navigation}

```

## Regime Count page

```sql scf/regime_count.sql { route: { caption: "Controls per regime (totals)" } }
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_count")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT  
  '[' || regime || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime", 
  control_count AS "Controls"
FROM "scf_regime_count"
ORDER BY control_count DESC, regime
${pagination.limit}; 
${pagination.navigation}

```

## Domain Count page

```sql scf/regime_domain_count.sql { route: { caption: "Domain x Regime counts" } }
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_domain_count")}

SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT
  domain AS "Domain",
  control_count AS "Controls"
FROM "scf_regime_domain_count"
ORDER BY control_count DESC, domain
${pagination.limit}; 
${pagination.navigation}

```

## Coverage page

```sql scf/regime_domain_coverage.sql { route: { caption: "Domain coverage % by regime" } }
SELECT
  'text' AS component,
 $page_title AS title;

 ${paginate("scf_regime_domain_coverage")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT
  scf_domain AS "Domain",  
  '[' || regime_label || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime_label, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime",
  mapped_controls AS "Mapped Controls",
  domain_total_controls AS "Total Controls",
  coverage_pct AS "Coverage %"
FROM "scf_regime_domain_coverage"
ORDER BY scf_domain, coverage_pct DESC, regime_label
${pagination.limit}; 
${pagination.navigation}

```

## Regime Rank page

```sql scf/regime_domain_rank.sql { route: { caption: "Top regimes within each domain" } }

SELECT
  'text' AS component,
 $page_title AS title;
 
 ${paginate("scf_regime_domain_rank")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT
  scf_domain AS "Domain", 
  '[' || regime_label || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime_label, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime",
  control_count AS "Controls",
  regime_rank_in_domain AS "Rank in Domain"
FROM "scf_regime_domain_rank"
ORDER BY scf_domain, regime_rank_in_domain, regime_label
${pagination.limit}; 
${pagination.navigation}
```

## Jaccard page

```sql scf/regime_overlap_jaccard.sql { route: { caption: "Regime overlap (Jaccard)" } }
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_overlap_jaccard")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime A' as  markdown,
       'Regime B' as  markdown,
       TRUE     AS search;              
SELECT  
  '[' || regime_a || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime_a, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime A",  
  '[' || regime_b || '](' || ${ctx.absUrlUnquoted("'' || 'details/regime.sql?regime=' || replace(replace(replace(regime_b, ' ', '%20'), '&', '%26'), '#', '%23') || ''")} || ')' AS "Regime B",    
  in_both AS "In Both",
  a_total AS "A Total",
  b_total AS "B Total",
  jaccard AS "Jaccard"
FROM "scf_regime_overlap_jaccard"
ORDER BY jaccard DESC, in_both DESC, regime_a, regime_b
${pagination.limit}; 
${pagination.navigation}
```

```sql scf/details/regime_control_unpivoted_details.sql { route: { caption: "Long form of SCF x Regime mappings details" } }
SELECT
  'text' AS component,
 $page_title||' for SCF # '||$scf_no AS title;

${paginate("scf_regime_control_unpivoted", "WHERE scf_no = $scf_no")}

SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT
  regime_label AS "Regime Label",
  scf_no AS "SCF #",
  scf_domain AS "SCF Domain",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker",
  regime_column_ordinal AS "Regime Column Ordinal"
FROM "scf_regime_control_unpivoted"
WHERE scf_no = $scf_no
ORDER BY scf_no, regime_column_ordinal
${pagination.limit}; 
${pagination.navigation}

```
## Controls per regime (totals) details page

```sql scf/details/regime.sql { route: { caption: "Controls per regime (totals) details" } }
SELECT
  'text' AS component,
 $page_title||' for '||$regime AS title;

${paginate("scf_regime_control", "WHERE regime_label = $regime")}

SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT
  scf_no AS "SCF #",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker"
FROM "scf_regime_control"
WHERE regime_label = $regime
ORDER BY scf_no
${pagination.limit}; 
${pagination.navWithParams("regime")}

```
## Threat Catalog Page

```sql scf/threat_catalog.sql { route: { caption: "Threat Catalog" } }
SELECT 'table' as component,
       TRUE as sort,
       TRUE as search;
SELECT
    "Threat Grouping",
    "Threat #",
    "Threat Description",
    "≥ 5% of pre-tax income",
    "≥ 0.5% of total assets",
    "≥ 1% of total equity",
    "≥ 0.5% of total revenue"
FROM scf_threat_catalog;
```