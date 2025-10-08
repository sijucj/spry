---
siteName: Cpation-Explorer
sqlpage-conf:
  database_url: "sqlite://sqlpage.db?mode=rwc"  
  web_root: "./"
  allow_exec: true  
  port: 9221
---

## Intro
The compliance explorer covers a wide range of standards and guidelines across different areas of cybersecurity and data protection. They include industry-specific standards, privacy regulations, and cybersecurity frameworks. Complying with these frameworks supports a strong cybersecurity stance and alignment with data protection laws.

The content in this folder is authored as a markdown-driven SQLPage page (`README.md`) and the site is configured to use a local SQLite database (`sqlpage.db`).

## Files

- `README.md` — the page source (markdown + SQL/JSON/JS/etc..) that defines the site content and cards.
- `ingest/` — CSV files and supporting data to import into the local `sqlpage.db` (not all files listed here).

The below SQL code first sets a variable (resource_json) from the JSON file and extracts the page caption. Then it adds an introductory paragraph explaining the purpose of the compliance explorer. Finally, it renders a responsive card layout (2 columns) listing key cybersecurity and data protection standards — such as CMMC, AICPA, HiTRUST, ISO 27001, HIPAA, and THSA — each with structured markdown descriptions (geography, source, version, and review date).

```sql index.sql { shell:{name: "abc.sql"}, route: { caption: "Compliance Explorer Home" } }
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/index.sql.auto.json');

SELECT
  'text' AS component,
  json_extract($resource_json, '$.route.caption') AS title;


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
Run the notebook script with markdown input and config, then pipe output into SQLite database 'sqlpage.db'

```bash
../../lib/sqlpage/codebook.ts --md README.md  --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db
```

Windows: start the SQLPage server

```bash
sqlpage.exe
```

Linux: start the SQLPage server from root folder

```bash
sqlpage.bin
```

macOS (Homebrew installation): start the SQLPage server

```bash
sqlpage
```

The below SQL code first drops the table if it already exists, then defines columns for key attributes such as title, geography, source, version, review date, description, status, and JSON-based elaboration. It includes audit fields like created_at, updated_at, and deleted_at for tracking changes.

```sql HEAD
-- Drop the table if it exists, then create the new table with auto-increment primary key
DROP TABLE IF EXISTS "compliance_regime";
CREATE TABLE "compliance_regime" (
"compliance_regime_id" INTEGER PRIMARY KEY AUTOINCREMENT,
"title" TEXT NOT NULL,
"geography" TEXT,
"source" TEXT,
"description" TEXT,
"logo" TEXT,
"status" TEXT,
"version" TEXT,
"last_reviewed_date" TIMESTAMPTZ,
"authoritative_source" TEXT,
"custom_user_text" TEXT,
"elaboration" TEXT CHECK(json_valid(elaboration) OR elaboration IS NULL),
"created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
"created_by" TEXT DEFAULT 'UNKNOWN',
"updated_at" TIMESTAMPTZ,
"updated_by" TEXT,
"deleted_at" TIMESTAMPTZ,
"deleted_by" TEXT,
"activity_log" TEXT
);
-- Insert records into the table
INSERT INTO "compliance_regime" (
"title",
"geography",
"source",
"description",
"logo",
"status",
"version",
"last_reviewed_date",
"authoritative_source",
"custom_user_text"
)
VALUES
(
'HIPAA',
'US',
'Federal',
'Health Insurance Portability and Accountability Act',
'',
'active',
'N/A',
'2022-10-20 00:00:00+00',
'Health Insurance Portability and Accountability Act (HIPAA)',
'Below, you will find a complete list of all controls applicable to the US HIPAA framework. These controls are designed ' ||
'to ensure compliance with the Health Insurance Portability and Accountability Act (HIPAA) standards, safeguarding ' ||
'sensitive patient health information'
),
(
'NIST',
'Universal',
'SCF',
'Comprehensive cybersecurity guidance framework',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),
(
'SOC2 Type I',
'US',
'SCF',
'Report on Controls as a Service Organization. Relevant to Security, Availability, Processing Integrity, Confidentiality, or Privacy.',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'SOC2 Type II',
'US',
'SCF',
'SOC 2 Type II reports provide lists of Internal controls that are audited by an Independent third-party to show how well those controls are implemented and operating.',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'HITRUST CSF',
'US',
'SCF',
'Achieve HITRUST CSF certification, the most trusted and comprehensive security framework in healthcare.',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'CMMC Model 2.0 LEVEL 1',
'US',
'SCF',
'Achieve Cybersecurity Maturity Model Certification (CMMC) to bid on Department of Defense contracts',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'CMMC Model 2.0 LEVEL 2',
'US',
'SCF',
'110 requirements aligned with NIST SP 800-171; Triennial third-party assessment & annual affirmation; Triennial self-assessment & annual affirmation for select programs. A subset of programs with Level 2 requirements do not involve information critical to national security, and associated contractors will be permitted to meet the requirement through self-assessments. Contractors will be required to conduct self-assessment on an annual basis, accompanied by an annual affirmation from a senior company official that the company is meeting requirements. The Department intends to require companies to register self-assessments and affirmations in the Supplier Performance Risk System (SPRS).',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'CMMC Model 2.0 LEVEL 3',
'US',
'SCF',
'110+ requirements based on NIST SP 800-171 & 800-172; Triennial government-led assessment & annual affirmation. The Department intends for Level 3 cybersecurity requirements to be assessed by government officials. Assessment requirements are currently under development. Level 3 information will likewise be posted as it becomes available.',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
),(
'ISO 27001:2022',
'US',
'SCF',
'Information security management systems standard',
'',
'active',
'2024',
'2024-04-01 00:00:00+00',
'800-53 rev4',
NULL
);
```

these are the views to consolidate compliance controls from multiple frameworks (SCF, CMMC, HIPAA, HITRUST, ISO 27001, SOC2) and AI policy/prompt data. It standardizes fields like control codes, questions, evidence, and metadata, providing unified, queryable views for a Compliance Explorer platform.

```sql HEAD
DROP VIEW IF EXISTS compliance_regime_control;
CREATE VIEW compliance_regime_control AS
SELECT `SCF Domain` AS scf_domain,
`SCF Control` AS scf_control,
`Secure Controls Framework (SCF) Control Description` AS control_description,
`SCF Control Question` AS control_question,
"SCF #" AS control_code,
`US HIPAA` AS control_id,
'US HIPAA' AS control_type
FROM uniform_resource_scf_2024_2 WHERE `US HIPAA` !=''
UNION
SELECT `SCF Domain` AS scf_domain,
`SCF Control` AS scf_control,
`Secure Controls Framework (SCF) Control Description` AS control_description,
`SCF Control Question` AS control_question,
"SCF #" AS control_code,
`NIST 800-171A rev 3` AS control_id,
'NIST' AS control_type
FROM uniform_resource_scf_2024_2 WHERE `NIST 800-171A rev 3` !='';


DROP VIEW IF EXISTS scf_view;

DROP VIEW IF EXISTS scf_view;

CREATE VIEW scf_view AS
SELECT 
    'SCF-' || ROWID AS control_identifier,
    "SCF Domain" AS scf_domain,
    "SCF Control" AS scf_control,
    "SCF #" AS control_code,
    "Secure Controls Framework (SCF) Control Description" AS control_description,
    "SCF Control Question" AS control_question,
    "US CMMC 2.0 Level 1" AS cmmc_level_1,
    "US CMMC 2.0 Level 2" AS cmmc_level_2,
    "US CMMC 2.0 Level 3" AS cmmc_level_3
FROM uniform_resource_scf_2024_2;

DROP VIEW IF EXISTS ai_ctxe_policy;
CREATE VIEW ai_ctxe_policy AS
SELECT DISTINCT
  ur.uniform_resource_id,
  json_extract(ur.frontmatter, '$.title') AS title,
  json_extract(ur.frontmatter, '$.description') AS description,
  json_extract(ur.frontmatter, '$.publishDate') AS publishDate,
  json_extract(ur.frontmatter, '$.publishBy') AS publishBy,
  json_extract(ur.frontmatter, '$.classification') AS classification,
  json_extract(ur.frontmatter, '$.documentType') AS documentType,
  json_extract(ur.frontmatter, '$.approvedBy') AS approvedBy,
  json_extract(ur.frontmatter, '$.category') AS category,
  json_extract(ur.frontmatter, '$.control-id') AS control_id,
  json_extract(ur.frontmatter, '$.regimeType') AS regimeType,
  json_extract(ur.frontmatter, '$.category[1]') AS category_type,
  json_extract(ur.frontmatter,'$.fiiId') AS fii_id,
 
  TRIM(
    CASE
      WHEN instr(ur.content, '---') = 1
        THEN substr(
          ur.content,
          instr(ur.content, '---') + 3 + instr(substr(ur.content, instr(ur.content, '---') + 3), '---') + 3
        )
      ELSE ur.content
    END
  ) AS body_text
FROM
  uniform_resource ur
JOIN
  ur_ingest_session_fs_path_entry fs
    ON fs.uniform_resource_id = ur.uniform_resource_id

WHERE
  fs.file_basename LIKE '%.policy.md';

DROP VIEW IF EXISTS compliance_regime_control_soc2;

CREATE VIEW compliance_regime_control_soc2 AS
SELECT
  "#" AS control_code,
  "Control Identifier" AS control_id,
  "Fii ID" AS fii_id,
  "Common Criteria" AS common_criteria,
  "Common Criteria type" AS criteria_type,
  Name AS control_name,
  "Questions Descriptions" AS control_question,
  'AICPA SOC 2' AS control_type,
  tenant_id,
  tenant_name
FROM uniform_resource_aicpa_soc2_controls
WHERE "Control Identifier" IS NOT NULL AND "Control Identifier" != '';


DROP VIEW IF EXISTS compliance_regime_control_hitrust_e1;

CREATE VIEW compliance_regime_control_hitrust_e1 AS
SELECT
  "#" AS control_code,
  "Control Identifier" AS control_id,
  "Fii ID" AS fii_id,
  "Common Criteria" AS common_criteria,
  NULL AS criteria_type, -- not available in this table
  Name AS control_name,
  Description AS control_question,
  'HITRUST E1' AS control_type,
  tenant_id,
  tenant_name
FROM uniform_resource_hitrust_e1_assessment
WHERE "Control Identifier" IS NOT NULL 
  AND "Control Identifier" != '';

DROP VIEW IF EXISTS compliance_iso_27001_control;

CREATE VIEW compliance_iso_27001_control AS
SELECT 
    `SCF Domain` AS scf_domain,
    `SCF Control` AS scf_control,
    `SCF #` AS control_code,
    `Secure Controls Framework (SCF)
Control Description` AS control_description,
    `SCF Control Question` AS control_question,
    Evidence AS evidence,
    tenant_id,
    tenant_name,
    'ISO 27001 v3' AS control_type
FROM uniform_resource_iso_27001_v3;

DROP VIEW IF EXISTS hipaa_security_rule_safeguards;
CREATE VIEW hipaa_security_rule_safeguards AS
SELECT
    "#" AS id,
    "Common Criteria" AS common_criteria,
    "HIPAA Security Rule Reference" AS hipaa_security_rule_reference,
    Safeguard AS safeguard,
    "Handled by nQ" AS handled_by_nq,
    "FII Id" AS fii_id,
    tenant_id,
    tenant_name
FROM uniform_resource_hipaa_security_rule_safeguards;
 
DROP VIEW IF EXISTS compliance_regime_thsa;
CREATE VIEW compliance_regime_thsa AS
SELECT
   "#" AS id,
  `SCF Domain` AS scf_domain,
  `SCF Control` AS scf_control,
  `SCF Control Question` AS scf_control_question,
  "SCF #" AS scf_code,
  "Your Answer" AS your_answer,
  tenant_id,
  tenant_name
FROM uniform_resource_thsa;


DROP VIEW IF EXISTS aicpa_soc2_type2_controls;
CREATE VIEW aicpa_soc2_type2_controls AS
SELECT
    "#" AS id,
    "Control Identifier" AS control_id,
    "Fii ID" AS fii_id,
    "Common Criteria" AS common_criteria,
    "Common Criteria type" AS criteria_type,
    Name AS control_name,
    "Questions Descriptions" AS control_question,
    tenant_id,
    tenant_name
FROM uniform_resource_aicpa_soc2_type2_controls;

--###view for complaince explorer prompts #####-------

DROP VIEW IF EXISTS ai_ctxe_complaince_prompt;
CREATE VIEW ai_ctxe_complaince_prompt AS
SELECT DISTINCT
  ur.uniform_resource_id,
  json_extract(ur.frontmatter, '$.title') AS title,
  json_extract(ur.frontmatter, '$.description') AS description,
  json_extract(ur.frontmatter, '$.publishDate') AS publishDate,
  json_extract(ur.frontmatter, '$.publishBy') AS publishBy,
  json_extract(ur.frontmatter, '$.classification') AS classification,
  json_extract(ur.frontmatter, '$.documentType') AS documentType,
  json_extract(ur.frontmatter, '$.approvedBy') AS approvedBy,
  json_extract(ur.frontmatter, '$.category') AS category,
  json_extract(ur.frontmatter, '$.control-id') AS control_id,
  json_extract(ur.frontmatter, '$.regimeType') AS regime,
  json_extract(ur.frontmatter, '$.category[1]') AS category_type,
  json_extract(ur.frontmatter,'$.fiiId') AS fii_id,

  TRIM(
    CASE
      WHEN instr(ur.content, '---') = 1
        THEN substr(
          ur.content,
          instr(ur.content, '---') + 3 + instr(substr(ur.content, instr(ur.content, '---') + 3), '---') + 3
        )
      ELSE ur.content
    END
  ) AS body_text
FROM
  uniform_resource ur
JOIN
  ur_ingest_session_fs_path_entry fs
    ON fs.uniform_resource_id = ur.uniform_resource_id

WHERE
  fs.file_basename LIKE '%.prompt.md'
  AND json_extract(ur.frontmatter, '$.regimeType') IS NOT NULL;;



--###view for all controls details complaince explorer #####-------

DROP VIEW IF EXISTS all_control;

CREATE VIEW all_control AS
    SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 1" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 1" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 1' AS control_type,
    12 AS control_type_id,
    6 AS control_compliance_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 1" != ''
 
UNION ALL
SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 2" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 2" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 2' AS control_type,
    13 AS control_type_id,
    7 AS control_compliance_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 2" != ''
 
UNION ALL
SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 3" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 3" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 3' AS control_type,
    14 AS control_type_id,
    8 AS control_compliance_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 3" != ''
 
UNION ALL
 
SELECT
            CAST(cntl."#" AS INTEGER) AS display_order,
            cntl."HIPAA Security Rule Reference" AS control_identifier,
            cntl."HIPAA Security Rule Reference" AS control_code,
            cntl."FII Id" AS fii,
            cntl."Common Criteria" AS common_criteria,
            '' AS expected_evidence,
            cntl.Safeguard AS question,
            'HIPAA' AS control_type,
            0 AS control_type_id,
            1 AS control_compliance_id        
          FROM uniform_resource_hipaa_security_rule_safeguards cntl
          
UNION ALL
SELECT
            CAST(cntl."#" AS INTEGER) AS display_order,
            cntl."Control Identifier" AS control_identifier,
            cntl."Control Identifier" AS control_code,
            cntl."Fii ID" AS fii,
            cntl."Common Criteria" AS common_criteria,
            cntl."Name" AS expected_evidence,
            cntl.Description AS question,
            'HITRUST' AS control_type,
            0 AS control_type_id,
            5 AS control_compliance_id  
          FROM uniform_resource_hitrust_e1_assessment cntl
          
UNION ALL
SELECT
            (SELECT COUNT(*)
            FROM uniform_resource_iso_27001_v3 AS sub
            WHERE sub.ROWID <= cntl.ROWID) AS display_order,
            'ISO-27001-' || (ROWID) as control_identifier,
             cntl."SCF #" AS control_code,
             cntl."SCF #" AS fii,
             cntl."SCF Domain" AS common_criteria,
             Evidence as expected_evidence,
             cntl."SCF Control Question" AS question,
             'ISO 27001:2022' AS control_type,
            0 AS control_type_id,
             9 AS control_compliance_id          
        FROM uniform_resource_iso_27001_v3 as cntl
UNION ALL
SELECT
        CAST(cntl."#" AS INTEGER) AS display_order,
        cntl."Control Identifier" AS control_identifier,
        cntl."Control Identifier" AS control_code,
        cntl."Fii ID" AS fii,
        cntl."Common Criteria" AS common_criteria,
        cntl."Name" AS expected_evidence,
        cntl."Questions Descriptions" AS question,
        'SOC2 Type I' AS control_type,
        2 AS control_type_id,
        3 AS control_compliance_id
    FROM uniform_resource_aicpa_soc2_controls cntl
    UNION ALL
    SELECT
        CAST(cntl."#" AS INTEGER),
        cntl."Control Identifier",
        cntl."Control Identifier",
        cntl."Fii ID",
        cntl."Common Criteria",
        cntl."Name",
        cntl."Questions Descriptions",
        'SOC2 Type II' AS control_type,
        3 AS control_type_id,
        4 AS control_compliance_id  
    FROM uniform_resource_aicpa_soc2_type2_controls cntl;


--###view for cmmc controls details complaince explorer #####-------

DROP VIEW IF EXISTS cmmc_control;

CREATE VIEW cmmc_control AS
    SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 1" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 1" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 1' AS control_type,
    12 AS control_type_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 1" != ''
 
UNION ALL
SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 2" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 2" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 2' AS control_type,
    13 AS control_type_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 2" != ''
 
UNION ALL
SELECT
    (SELECT COUNT(*)
     FROM uniform_resource_scf_2024_2 AS sub
     WHERE sub.ROWID <= cntl.ROWID
       AND "US CMMC 2.0 Level 3" != '') AS display_order,
    'CMMCLEVEL-' || ROWID AS control_identifier,
    cntl."US CMMC 2.0 Level 3" AS control_code,
    cntl."SCF #" AS fii,
    cntl."SCF Domain" AS common_criteria,
    '' AS expected_evidence,
    cntl."SCF Control Question" AS question,
    'CMMC Model 2.0 Level 3' AS control_type,
    14 AS control_type_id
FROM uniform_resource_scf_2024_2 AS cntl
WHERE cntl."US CMMC 2.0 Level 3" != '';


--###view for hipaa controls details complaince explorer #####-------

DROP VIEW IF EXISTS hipaa_control;

CREATE VIEW hipaa_control AS
   SELECT
            CAST(cntl."#" AS INTEGER) AS display_order,
            cntl."HIPAA Security Rule Reference" AS control_identifier,
            cntl."HIPAA Security Rule Reference" AS control_code,
            cntl."FII Id" AS fii,
            cntl."Common Criteria" AS common_criteria,
            '' AS expected_evidence,
            cntl.Safeguard AS question            
          FROM uniform_resource_hipaa_security_rule_safeguards cntl;


--###view for hitrust controls details complaince explorer #####-------

DROP VIEW IF EXISTS hitrust_control;

CREATE VIEW hitrust_control as
SELECT
            CAST(cntl."#" AS INTEGER) AS display_order,
            cntl."Control Identifier" AS control_identifier,
            cntl."Control Identifier" AS control_code,
            cntl."Fii ID" AS fii,
            cntl."Common Criteria" AS common_criteria,
            cntl."Name" AS expected_evidence,
            cntl.Description AS question
          FROM uniform_resource_hitrust_e1_assessment cntl;


--###view for iso27001 controls details complaince explorer #####-------

DROP VIEW IF EXISTS iso27001_control;

CREATE VIEW iso27001_control AS    
SELECT
            (SELECT COUNT(*)
            FROM uniform_resource_iso_27001_v3 AS sub
            WHERE sub.ROWID <= cntl.ROWID) AS display_order,
            'ISO-27001-' || (ROWID) as control_identifier,
             cntl."SCF #" AS control_code,
             cntl."SCF #" AS fii,
             cntl."SCF Domain" AS common_criteria,
             Evidence as expected_evidence,
             cntl."SCF Control Question" AS question            
        FROM uniform_resource_iso_27001_v3 as cntl;


--###view for soc2 controls details complaince explorer #####-------

DROP VIEW IF EXISTS soc2_control;

CREATE VIEW soc2_control AS
    SELECT
        CAST(cntl."#" AS INTEGER) AS display_order,
        cntl."Control Identifier" AS control_identifier,
        cntl."Control Identifier" AS control_code,
        cntl."Fii ID" AS fii,
        cntl."Common Criteria" AS common_criteria,
        cntl."Name" AS expected_evidence,
        cntl."Questions Descriptions" AS question,
        'SOC2 Type I' AS control_type,
        2 AS control_type_id
    FROM uniform_resource_aicpa_soc2_controls cntl
    UNION ALL
    SELECT
        CAST(cntl."#" AS INTEGER),
        cntl."Control Identifier",
        cntl."Control Identifier",
        cntl."Fii ID",
        cntl."Common Criteria",
        cntl."Name",
        cntl."Questions Descriptions",
        'SOC2 Type II' AS control_type,
        3 AS control_type_id
    FROM uniform_resource_aicpa_soc2_type2_controls cntl;       
```

## Quick start

1. Ingest CSV files (recursively) and transform them into the SQLPage database (`sqlpage.db`):
   
   ```bash
   surveilr ingest files --csv-transform-auto -r ingest -d sqlpage.db
   ```

2. Build the SQLPage notebook page from `README.md` and pipe into the database:
  
   ```bash
   ../../lib/sqlpage/codebook.ts --md README.md --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db
   ```

4. Start the SQLPage server:

   - Windows: `sqlpage.exe`
   - Linux (from repository root): `sqlpage.bin`
   - macOS (Homebrew): `sqlpage`

5. Open your browser at the configured port (default in `README.md` example: `http://localhost:9219`).

### Notes

- This folder assumes you have the SQLPage tooling from the repository (see `lib/sqlpage`).
- [`surveilr`](https://www.surveilr.com/) is used to ingest CSV files — ensure it is installed or available in your PATH.
- Commands above assume a Unix-like shell; Windows paths/commands differ slightly.
- The top of this `README.md` contains a YAML front-matter example used by SQLPage:

  - siteName: Sets the site name as Cpation-Explorer.
  - database_url: Points to the SQLite database (sqlpage.db) in read-write-create mode.
  - web_root: Defines the web root directory for serving files (./) 
  - allow_exec: Enables execution of scripts/SQLPage commands.
  - port: Configures the web server to run on port 9221.
  - Adjust the `database_url` and `port` as needed.

## Development: auto rebuild & restart

During active development it's convenient to automatically rebuild the packaged page and restart the `sqlpage.bin` server when markdown changes. The following example uses `watchexec` to watch `.md` files, rebuild the notebook with the repository `codebook` tool, write the output into `sqlpage.db`, and restart the local `sqlpage.bin` server:

```sh
watchexec -e md -- bash -c 'pkill -f sqlpage.bin || true; deno run -A ../../lib/sqlpage/codebook.ts --md README.md --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db; sleep 1; sqlpage.bin &'
```

### Notes:

- This command assumes `watchexec`, `deno`, and `sqlite3` are installed and available in your PATH.
   - Install `watchexec` from: https://webinstall.dev/watchexec/
- The `pkill` call attempts to stop any running `sqlpage.bin` process before starting a fresh instance. On systems without `pkill`, stop the server manually.
- The one-second `sleep` gives SQLite a moment to flush the write before the server restarts.

## Troubleshooting

- If the server won't start, confirm `sqlpage` binary exists and is executable. On Linux you may need to run `chmod +x sqlpage.bin` from repo root.
- If pages fail to render, check the `sqlpage.db` file for schema.