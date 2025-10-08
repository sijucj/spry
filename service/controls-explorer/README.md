# Controls Explorer

This small demo service contains a Compliance Explorer built as a SQLPage site. It catalogs common compliance frameworks and provides SQL-driven pages and cards describing each framework.

The content in this folder is authored as markdown-driven SQLPage pages (`index.md` and `head.md`) and the site is configured to use a local SQLite database (`sqlpage.db`). The README below highlights how to ingest the provided CSVs, build the site, and run the SQLPage server locally.

## What it is

- A demo 'Compliance Explorer' presenting standards like CMMC, AICPA, HITRUST, ISO 27001, HIPAA, and others.
- Uses SQLPage to render markdown and SQL to pages and cards.

## Files

 - `index.md` — the page source (markdown + SQL) that defines the site content and cards.
 - `head.md` — an additional page fragment (same format as `index.md`) used for shared head/content.
- `ingest/` — CSV files and supporting data to import into the local `sqlpage.db` (not all files listed here).

## Quick start

1. Ingest CSV files (recursively) and transform them into the SQLPage database (`sqlpage.db`):

   surveilr ingest files --csv-transform-auto -r ingest -d sqlpage.db

2. Ensure foreign keys are enabled in SQLite (SQLPage uses this):

   PRAGMA foreign_keys = ON;

3. Build the SQLPage notebook page from `index.md` and pipe into the database:

 ../../lib/sqlpage/codebook.ts --md index.md --md head.md --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db

4. Start the SQLPage server:

   - Windows: `sqlpage.exe`
   - Linux (from repository root): `./sqlpage.bin`
   - macOS (Homebrew): `sqlpage`

5. Open your browser at the configured port (default in the examples: `http://localhost:9219`).


## Example page content (from `index.md` and `head.md`)

The `index.md` and `head.md` files include SQL blocks that define a page with components, text, and cards. Example SQL snippets produce a front page that contains:

- A text component with the site intro describing the purpose of the compliance explorer.
- A grid of cards listing frameworks: CMMC, AICPA, HiTRUST e1, ISO 27001:2022, HIPAA, Together.Health Security Assessment, with short metadata for each.

## Configuration

The top of `index.md` and `head.md` contains a YAML front-matter example used by SQLPage:

```yaml
siteName: Demo
sqlpage-conf:
  database_url: "sqlite://sqlpage.db?mode=rwc"
  web_root: "src"
  allow_exec: true
  port: 9219
```

Adjust the `database_url` and `port` as needed.

## Notes

- This folder is a demonstration and assumes you have the SQLPage tooling from the repository (see `lib/sqlpage`).
- `surveilr` is used to ingest CSV files — ensure it is installed or available in your PATH.
- Commands above assume a Unix-like shell; Windows paths/commands differ slightly.

## Development: auto rebuild & restart

During active development it's convenient to automatically rebuild the packaged page and restart the `sqlpage.bin` server when markdown changes. The following example uses `watchexec` to watch `.md` files, rebuild the notebook with the repository `codebook` tool, write the output into `sqlpage.db`, and restart the local `sqlpage.bin` server:

```sh
watchexec -e md -- bash -c 'pkill -f sqlpage.bin || true; deno run -A ../../lib/sqlpage/codebook.ts --md index.md --md head.md --package --conf sqlpage/sqlpage.json | sqlite3 sqlpage.db; sleep 1; sqlpage.bin &'
```

Notes:

- This command assumes `watchexec`, `deno`, and `sqlite3` are installed and available in your PATH.
   - Install `watchexec` from: https://webinstall.dev/watchexec/
- The `pkill` call attempts to stop any running `sqlpage.bin` process before starting a fresh instance. On systems without `pkill`, stop the server manually.
- The one-second `sleep` gives SQLite a moment to flush the write before the server restarts.

## Troubleshooting

- If the server won't start, confirm `sqlpage` binary exists and is executable. On Linux you may need to run `chmod +x sqlpage.bin` from repo root.
- If pages fail to render, check the `sqlpage.db` file for schema issues and that `PRAGMA foreign_keys` is enabled.

## License

Contents inherit the repository license (see `LICENSE` at project root).
