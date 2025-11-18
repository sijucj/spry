#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// Use `deno run -A --watch` in the shebang if you're contributing / developing Spry itself.

import { CLI } from "../../../lib/remark/mdastctl.ts";

await new CLI({
  cmdName: import.meta.filename?.split("/").pop(),
  defaultFiles: ["Qualityfolio.md"],
}).run();
