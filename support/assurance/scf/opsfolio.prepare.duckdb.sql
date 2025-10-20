SET VARIABLE opsfolio_xls_source = 'next-opsfolio-ux.xlsx';

INSTALL excel;
LOAD excel;

-- NOTE: This script assumes that we're running in DuckDB :memory: destination

CREATE TABLE "opsfolio_regime" AS
SELECT
  "SCF Regime Name" AS scf_regime_name,
  "Opsfolio Rank" AS opsfolio_rank,
  "Description not in SCF" AS description_not_in_scf,
  "Opsfolio Regime Group" AS opsfolio_regime_group
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regimes', header=true);

CREATE TABLE "opsfolio_regime_group" AS
SELECT
  "Regime Group" AS regime_group,
  "Opsfolio Rank" AS opsfolio_rank,
  "Regime Group Description not in SCF" AS description_not_in_scf
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regime Group', header=true);

-- Assurance Prime Logging
DROP TABLE IF EXISTS assurance_prime_invalide_regime;
CREATE TABLE assurance_prime_invalide_regime (
    log_type TEXT,
    log_message TEXT,
    timestamp TIMESTAMP
);

CREATE TEMP TABLE xlsx_header AS
SELECT *
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regimes', header=false, range='A1:D1');

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regimes sheet. Expected "SCF Regime Name" in column A, but found ' || A,
    CURRENT_TIMESTAMP
FROM xlsx_header WHERE A != 'SCF Regime Name';

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regimes sheet. Expected "Opsfolio Rank" in column B, but found ' || B,
    CURRENT_TIMESTAMP
FROM xlsx_header WHERE B != 'Opsfolio Rank';

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regimes sheet. Expected "Description not in SCF" in column C, but found ' || C,
    CURRENT_TIMESTAMP
FROM xlsx_header WHERE C != 'Description not in SCF';

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regimes sheet. Expected "Opsfolio Regime Group" in column D, but found ' || D,
    CURRENT_TIMESTAMP
FROM xlsx_header WHERE D != 'Opsfolio Regime Group';

CREATE TEMP TABLE all_rows AS
SELECT
  ROW_NUMBER() OVER () + 1 AS row,
  *
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regimes', header=true);

INSERT INTO assurance_prime_invalide_regime
WITH warnings AS (
    SELECT
        row,
        "SCF Regime Name" as regime,
        'Opsfolio Rank is missing' as message
    FROM all_rows
    WHERE "SCF Regime Name" IS NOT NULL AND ("Opsfolio Rank" IS NULL OR CAST("Opsfolio Rank" AS VARCHAR) = '')
    UNION ALL
    SELECT
        row,
        "SCF Regime Name" as regime,
        'Description not in SCF is missing' as message
    FROM all_rows
    WHERE "SCF Regime Name" IS NOT NULL AND ("Description not in SCF" IS NULL OR "Description not in SCF" = '')
)
SELECT
    'warning',
    json_group_array(json_object('row', row, 'regime', regime, 'message', message)),
    CURRENT_TIMESTAMP
FROM warnings;

CREATE TEMP TABLE xlsx_header_group AS
SELECT *
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regime Group', header=false, range='A1:C1');

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regime Group sheet. Expected "Regime Group" in column A, but found ' || A,
    CURRENT_TIMESTAMP
FROM xlsx_header_group WHERE A != 'Regime Group';

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regime Group sheet. Expected "Opsfolio Rank" in column B, but found ' || B,
    CURRENT_TIMESTAMP
FROM xlsx_header_group WHERE B != 'Opsfolio Rank';

INSERT INTO assurance_prime_invalide_regime
SELECT
    'error',
    'Header mismatch in Opsfolio Regime Group sheet. Expected "Regime Group Description not in SCF" in column C, but found ' || C,
    CURRENT_TIMESTAMP
FROM xlsx_header_group WHERE C != 'Regime Group Description not in SCF';

CREATE TEMP TABLE all_rows_group AS
SELECT
  ROW_NUMBER() OVER () + 1 AS row,
  *
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regime Group', header=true);

INSERT INTO assurance_prime_invalide_regime
WITH warnings AS (
    SELECT
        row,
        "Regime Group" as regime,
        'Opsfolio Rank is missing' as message
    FROM all_rows_group
    WHERE "Regime Group" IS NOT NULL AND ("Opsfolio Rank" IS NULL OR CAST("Opsfolio Rank" AS VARCHAR) = '')
    UNION ALL
    SELECT
        row,
        "Regime Group" as regime,
        'Regime Group Description not in SCF is missing' as message
    FROM all_rows_group
    WHERE "Regime Group" IS NOT NULL AND ("Regime Group Description not in SCF" IS NULL OR "Regime Group Description not in SCF" = '')
)
SELECT
    'warning',
    json_group_array(json_object('row', row, 'regime', regime, 'message', message)),
    CURRENT_TIMESTAMP
FROM warnings;


INSTALL sqlite; LOAD sqlite;

ATTACH 'scf-2025.3.sqlite.db' AS scf (TYPE sqlite);

DROP TABLE IF EXISTS scf."opsfolio_regime";
CREATE TABLE scf."opsfolio_regime" AS SELECT * FROM "opsfolio_regime";

DROP TABLE IF EXISTS scf."opsfolio_regime_group";
CREATE TABLE scf."opsfolio_regime_group" AS SELECT * FROM "opsfolio_regime_group";

DROP TABLE IF EXISTS scf."assurance_prime_invalide_regime";
CREATE TABLE scf."assurance_prime_invalide_regime" AS SELECT * FROM "assurance_prime_invalide_regime";


CREATE OR REPLACE VIEW scf.opsfolio_regime_count AS
SELECT
  src.regime_label as regime,
  opr.opsfolio_regime_group as regime_group,
  COUNT(src.regime_raw_value) AS control_count,
  opr.opsfolio_rank,
  opr.description_not_in_scf
FROM opsfolio_regime opr 
INNER JOIN scf_regime_control src ON src.regime_label=opr.scf_regime_name
WHERE opr.opsfolio_rank NOT NULL
GROUP BY
  src.regime_label,
  opr.opsfolio_regime_group,
  opr.opsfolio_rank,
  opr.description_not_in_scf
ORDER BY opr.opsfolio_rank ASC;

CREATE OR REPLACE VIEW scf.opsfolio_regime_group_count AS
SELECT
  org.regime_group,
  COUNT(src.regime_raw_value) AS control_count,
  org.opsfolio_rank,
  org.description_not_in_scf
FROM scf_regime_control src
INNER JOIN opsfolio_regime opr ON src.regime_label = opr.scf_regime_name
INNER JOIN opsfolio_regime_group org ON opr.opsfolio_regime_group = org.regime_group
WHERE org.opsfolio_rank NOT NULL
GROUP BY
  org.regime_group,
  org.opsfolio_rank,
  org.description_not_in_scf
ORDER BY org.opsfolio_rank ASC;
