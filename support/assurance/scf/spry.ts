#!/usr/bin/env -S deno run -A

// #!/usr/bin/env -S deno run -A --watch
// Use `deno --watch` in shebang ☝️ during dev of Spry itself but do not keep
// `--watch` if you're not doing Spry development.

import { CLI } from "../../../lib/sqlpage/cli.ts";

CLI.instance().run();
