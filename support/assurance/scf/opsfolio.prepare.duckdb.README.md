# opsfolio.prepare.duckdb.sql

This script is used to generate regimes and their controls for the Opsfolio project.

## Prerequisites

Before running this script, ensure that you have the following file in the same directory:

* `scf-2025.3.sqlite.db`

## Usage

To run the script, execute the following command in your terminal:

```bash
cat opsfolio.prepare.duckdb.sql | duckdb ":memory:"
```
