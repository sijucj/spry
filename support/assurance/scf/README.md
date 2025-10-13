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

```sql index.sql { route: { caption: "Secure Controls Framework (SCF) Explorer" } }
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search,
       'Regime' AS markdown;              -- interpret the "Regime" column as Markdown
SELECT
  '[' || regime || '](' || 'regime.sql?regime=' || regime || ')' AS "Regime",
  control_count AS "Controls"
FROM "scf_regime_count"
ORDER BY control_count DESC, regime;
```
