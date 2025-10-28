#!/bin/sh
# SpryMD.org quick init
# Usage:
#   curl -fsSL https://spry.md/init.sh | sh
#   curl -fsSL https://spry.md/init.sh | sh -s -- [target-dir]
#
# Behavior:
# - Verifies Deno is installed
# - Runs the Spry CLI init in the current dir (or optional target dir)
# - Prints next-step commands

set -eu

CLI_URL="https://raw.githubusercontent.com/programmablemd/spry/main/lib/sqlpage/cli.ts"

say() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v deno >/dev/null 2>&1 || err "Deno not found.
Install Deno first:
  curl -fsSL https://deno.land/install.sh | sh
Then re-run:
  curl -fsSL https://spry.md/init.sh | sh"

TARGET_DIR="${1:-.}"

# Normalize and ensure target dir exists
if [ "$TARGET_DIR" != "." ]; then
  mkdir -p "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

say "Initializing Spry in: $(pwd)"
say "Running Spry CLI init…"

# --node-modules-dir=auto is used to ensure Node-style deps (if any) resolve
deno run --node-modules-dir=auto -A "$CLI_URL" init

say ""
say "✅ Spry initialized."
say ""
say "Next steps:"
if [ -x "./spry.ts" ]; then
  say "  ./spry.ts help"
else
  # Fallback in case spry.ts isn't marked executable
  say "  deno run -A ./spry.ts help"
fi

say ""
say "Tip: Keep this two-step install handy for docs:"
say "  1) curl -fsSL https://deno.land/install.sh | sh"
say "  2) curl -fsSL https://spry.md/init.sh | sh"