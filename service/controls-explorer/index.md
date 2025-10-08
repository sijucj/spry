---
siteName: Demo
sqlpage-conf:
  database_url: "sqlite://sqlpage.db?mode=rwc"  
  web_root: "./"
  allow_exec: true  
  port: 9219
---

## Intro
The compliance explorer covers a wide range of standards and guidelines across different areas of cybersecurity and data protection. They include industry-specific standards, privacy regulations, and cybersecurity frameworks. Complying with these frameworks supports a strong cybersecurity stance and alignment with data protection laws.

# Ingest data files into the SQLPage database and automatically transform CSV files,
# recursively processing files in the 'ingest' folder, and store results in 'sqlpage.db'
surveilr ingest files --csv-transform-auto -r ingest -d sqlpage.db

```sql HEAD
-- head at start
PRAGMA foreign_keys = ON;
```

```sql index.sql { route: { caption: "Compliance Explorer Home" } }
SELECT
  'text' AS component,
  'Compliance Explorer' AS title;

SELECT
  'The compliance explorer covers a wide range of standards and guidelines across different areas of cybersecurity and data protection. They include industry-specific standards, privacy regulations, and cybersecurity frameworks. Complying with these frameworks supports a strong cybersecurity stance and alignment with data protection laws.' AS contents;

SELECT
  'card' AS component,
  '' AS title,
  2 AS columns;

SELECT
  'CMMC' AS title,
  '**Geography**: US 

  **Source**: Department of Defense (DoD) 

  **Version**: 2.0 

  **Published/Last Reviewed Date/Year**: 2021-11-04 00:00:00+00' AS description_md
UNION
SELECT
  'AICPA' AS title,
  '**Geography**: US 

  **Source**: American Institute of Certified Public Accountants (AICPA) 

  **Version**: N/A 

  **Published/Last Reviewed Date/Year**: 2023-10-01 00:00:00+00' AS description_md
UNION
SELECT
  'HiTRUST e1 Assessment' AS title,
  '**Geography**: US 

  **Source**: HITRUST Alliance 

  **HITRUST Essentials, 1-Year (e1) Assessment** 

  **Version**: e1 

  **Published/Last Reviewed Date/Year**: 2021-09-13 00:00:00+00' AS description_md
UNION
SELECT
  'ISO 27001:2022' AS title,
  '**Geography**: International 

  **Source**: International Organization for Standardization (ISO) 

  **Version**: 2022 

  **Published/Last Reviewed Date/Year**: 2022-10-25 00:00:00+00' AS description_md
UNION
SELECT
  'HIPAA' AS title,
  '**Geography**: US 

  **Source**: Federal 

  **Health Insurance Portability and Accountability Act (HIPAA)** 

  **Version**: N/A 

  **Published/Last Reviewed Date/Year**: 2024-01-06 00:00:00+00' AS description_md
UNION
SELECT
  'Together.Health Security Assessment (THSA)' AS title,
  '**Geography**: US 

  **Source**: Together.Health (health innovation collaborative) 

  **Together.Health Security Assessment (THSA)** 

  **Version**: v2019.1 

  **Published/Last Reviewed Date/Year**: 2019-10-26 00:00:00+00' AS description_md
```
# Run the notebook script with markdown input and config, then pipe output into SQLite database 'sqlpage.db'
../../lib/sqlpage/codebook.ts --md index.md --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db

# Windows: start the SQLPage server
sqlpage.exe

# Linux: start the SQLPage server from root folder
./sqlpage.bin

# macOS (Homebrew installation): start the SQLPage server
sqlpage