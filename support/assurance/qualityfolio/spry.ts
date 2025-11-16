#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// Use `deno run -A --watch` in the shebang if you're contributing / developing Spry itself.

import { CLI } from "../../../lib/markdown/remark/mdastctl.ts";

CLI.instance().run();
