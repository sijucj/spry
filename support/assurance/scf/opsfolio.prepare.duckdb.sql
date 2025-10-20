SET VARIABLE opsfolio_xls_source = 'next-opsfolio-ux.xlsx';

INSTALL excel;
LOAD excel;

-- NOTE: This script assumes that we're running in DuckDB :memory: destination

CREATE TABLE "opsfolio_regime" AS
SELECT
  "SCF Regime Name" AS scf_regime_name,
  "Opsfolio Rank" AS opsfolio_rank,
  "Description not in SCF" AS description_not_in_scf
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regimes', header=true);

-- Assurance Prime Logging
DROP TABLE IF EXISTS assurance_prime_invalide_regime;
CREATE TABLE assurance_prime_invalide_regime (
    log_type TEXT,
    log_message TEXT,
    timestamp TIMESTAMP
);

CREATE TEMP TABLE xlsx_header AS
SELECT *
FROM read_xlsx(getvariable('opsfolio_xls_source'), sheet='Opsfolio Regimes', header=false, range='A1:C1');

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


INSTALL sqlite; LOAD sqlite;

ATTACH 'scf-2025.3.sqlite.db' AS scf (TYPE sqlite);

DROP TABLE IF EXISTS scf."opsfolio_regime";
CREATE TABLE scf."opsfolio_regime" AS SELECT * FROM "opsfolio_regime";

DROP TABLE IF EXISTS scf."assurance_prime_invalide_regime";
CREATE TABLE scf."assurance_prime_invalide_regime" AS SELECT * FROM "assurance_prime_invalide_regime";


CREATE OR REPLACE VIEW scf.opsfolio_regime_count AS
SELECT
  src.regime_label as regime,
  COUNT(src.regime_raw_value) AS control_count,
  opr.opsfolio_rank,
  opr.description_not_in_scf
FROM opsfolio_regime opr 
INNER JOIN scf_regime_control src ON src.regime_label=opr.scf_regime_name
WHERE opr.opsfolio_rank NOT NULL
GROUP BY
  src.regime_label,
  opr.opsfolio_rank,
  opr.description_not_in_scf
ORDER BY opr.opsfolio_rank ASC;
