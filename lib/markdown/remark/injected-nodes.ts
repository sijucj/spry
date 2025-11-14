/**
 * @module injected-nodes
 *
 * @summary
 * A sync-only remark plugin that expands “import spec” code fences into
 * additional, virtual `code` nodes, annotated with `data.injectedNode`
 * metadata. Later plugins (like `enrichedCode`) can treat these injected
 * nodes as if the referenced files or URLs had been written inline in the
 * Markdown.
 *
 * @description
 * This plugin implements the “pseudo cell” / include-manifest behavior
 * entirely at the remark / mdast layer. It looks for specially-marked
 * fenced code blocks whose content describes a set of files or URLs to
 * import, then injects one new `code` node per resolved target.
 *
 * ### When does it trigger?
 *
 * Each `code` node is first parsed using `parseEnrichedCodeFromCode`, which
 * extracts processing instructions (PIs) and attributes from the fence
 * language/meta. By default, a code block is treated as an “import spec”
 * block if its PI flags include `--inject`.
 *
 * Example spec block:
 *
 * ```md
 * ```import --inject --base ./workspace
 * # lines starting with # are comments
 * sql  **\/*.sql
 * utf8 assets/**\/*.png
 * json https://example.com/conf/demo.json
 * ```
 * ```
 *
 * You can override the detection logic via the `isSpecBlock` option when
 * calling `remark().use(injectedNodes, { isSpecBlock })`.
 *
 * ### Spec format
 *
 * Inside a spec block, each non-empty, non-comment line has the form:
 *
 *   `<language> <globOrUrl> [rest…]`
 *
 * where:
 *
 * - `language` becomes the `lang` of injected `code` nodes.
 * - `globOrUrl` is either:
 *   - a local glob pattern (e.g. `**\/*.sql`, `assets/**\/*.png`), or
 *   - a remote HTTP(S) URL.
 * - `rest…` are arbitrary extra tokens (flags, tags, etc.) that will be
 *   appended to the generated PI string for each injected node.
 *
 * The base directory (or directories) for resolving local globs is taken
 * from the spec block’s PI flags:
 *
 * - `--base <dir>` or `--baseDir <dir>` → that directory (or array of dirs)
 * - otherwise, `Deno.cwd()` is used as the default root.
 *
 * ### What does it inject?
 *
 * For each resolved directive:
 *
 * - A **local** directive is created for each file matched by the glob:
 *   - We walk the base dir(s) synchronously (via `walkSync` + `globToRegExp`).
 *   - Local matches are treated as files on disk.
 *
 * - A **remote** directive is created for each HTTP(S) URL:
 *   - URLs are **not** fetched by this plugin; they are treated as
 *     references that later stages can resolve.
 *
 * Each directive is turned into a new mdast `code` node:
 *
 * - `type`: `"code"`
 * - `lang`: the `language` from the spec line (e.g. `"sql"`, `"utf8"`, `"json"`)
 * - `meta`: a synthesized PI string of the form:
 *
 *     `<relativeFirstToken> --import <fullPathOrUrl> [--is-binary] [rest…]`
 *
 *   where:
 *   - `relativeFirstToken` is:
 *     - the path to the file relative to the base dir (for locals), or
 *     - a filesystem-style relative path derived from the URL (for remotes),
 *       e.g. `conf/demo.json`.
 *   - `--import` holds the absolute file path or full URL.
 *   - `--is-binary` is included when the language is `"utf8"` to signal a
 *     binary-ish reference.
 *   - `rest…` are the extra tokens from the original spec line.
 *
 * - `value`:
 *   - For **local, non-binary** files (language != `"utf8"`):
 *     - The plugin reads the file synchronously using `Deno.readTextFileSync`
 *       and sets `value` to the file contents.
 *   - For **binary-ish** locals (language === `"utf8"`) and **remote** URLs:
 *     - `value` is left as an empty string (`""`); the actual bytes or remote
 *       content are not loaded at this stage.
 *
 * - `data.injectedNode`:
 *
 *   Each injected node is annotated with:
 *
 *   ```ts
 *   interface InjectedNodeData {
 *     isInjected: true;
 *     source?: {
 *       isRefToBinary: boolean;
 *     } & (
 *       | {
 *           isRefToBinary: false;
 *           importedFrom: string | string[];
 *           original: string;
 *         }
 *       | {
 *           isRefToBinary: true;
 *           importedFrom: string;
 *           encoding: "UTF-8";
 *           rs?: ReadableStream<Uint8Array>;
 *         }
 *     );
 *   }
 *   ```
 *
 *   - For **local, non-binary** text files:
 *
 *     ```ts
 *     {
 *       isRefToBinary: false,
 *       importedFrom: "/absolute/path/to/file.ext",
 *       original: "<file contents>",
 *     }
 *     ```
 *
 *   - For **local binary-ish** files (language `"utf8"`):
 *
 *     ```ts
 *     {
 *       isRefToBinary: true,
 *       importedFrom: "/absolute/path/to/file.bin",
 *       encoding: "UTF-8",
 *       rs: ReadableStream<Uint8Array>, // created via lazyFileBytesReader
 *     }
 *     ```
 *
 *   - For **remote** URLs:
 *
 *     ```ts
 *     {
 *       isRefToBinary: true,
 *       importedFrom: "https://example.com/conf/demo.json",
 *       encoding: "UTF-8",
 *       // rs is intentionally omitted here to avoid starting a fetch in the plugin
 *     }
 *     ```
 *
 *   A helper type guard `isInjectedCode(node)` is provided to simplify
 *   detection of these nodes in later plugins:
 *
 *   ```ts
 *   if (isInjectedCode(codeNode)) {
 *     const src = codeNode.data.injectedNode.source;
 *     // ...
 *   }
 *   ```
 *
 * ### Sync-only design
 *
 * The plugin is deliberately **synchronous**:
 *
 * - It does **not** use `async` transformers or `await` anywhere.
 * - Local text files are read synchronously with `Deno.readTextFileSync`.
 * - Local binary files get a lazy `ReadableStream` via `lazyFileBytesReader`
 *   without starting any async operations.
 * - Remote URLs are recorded as references only; no network I/O is initiated
 *   in this plugin. This keeps remark processing fast and avoids test leaks
 *   due to unfinished fetches.
 *
 * Any actual streaming from `rs` or remote fetching is expected to happen
 * in later stages (e.g. an executor, bundler, or `enrichedCode`-style plugin)
 * that can opt into async behavior and manage lifecycle explicitly.
 *
 * ### Relationship to `enrichedCode`
 *
 * `injected-nodes` does **one thing**:
 *
 * - It rewrites the mdast tree to include additional, “virtual” code nodes
 *   derived from import spec blocks, and annotates them with enough metadata
 *   to be usable later.
 *
 * It does **not** execute, transform, or interpret these nodes beyond that.
 * The idea is to keep the concerns separated:
 *
 * - `injected-nodes`: imports expansion and node injection.
 * - `enrichedCode` (and other plugins): interpretation, execution, or
 *   further enrichment of both original and injected nodes.
 *
 * Typical usage:
 *
 * ```ts
 * import { remark } from "remark";
 * import { injectedNodes } from "./injected-nodes.ts";
 * import { enrichedCode } from "./enriched-code.ts";
 *
 * const tree = remark()
 *   .use(injectedNodes)   // expands import specs into injected code nodes
 *   .use(enrichedCode)    // consumes injected nodes plus normal ones
 *   .parse(src);
 * ```
 */
import { type WalkEntry, walkSync } from "jsr:@std/fs@^1";
import { globToRegExp, isAbsolute, relative } from "jsr:@std/path@^1";
import type { Code, Root } from "npm:@types/mdast@^4";
import type { Plugin } from "npm:unified@^11";
import { visit } from "npm:unist-util-visit@^5";
import {
  isTextHttpUrl,
  lazyFileBytesReader,
  lazyUrlBytesReader,
  relativeUrlAsFsPath,
} from "../../universal/content-acquisition.ts";
// Adjust this import to wherever you export it:
import { parseEnrichedCodeFromCode } from "./enriched-code.ts";

/** Shape of the injectedNode metadata we attach to mdast.Code.data. */
export type InjectedNodeSource =
  & { isRefToBinary: boolean; isContentAcquired: boolean }
  & (
    | {
      isRefToBinary: false;
      importedFrom: string | string[];
      original: string;
    }
    | {
      isRefToBinary: true;
      importedFrom: string;
      encoding: "UTF-8";
      stream?: () => ReadableStream<Uint8Array>;
    }
  );

export interface InjectedNode {
  isInjected: true;
  source?: InjectedNodeSource;
}

/** Convenience type guard for enrichedCode and friends. */
export function isInjectedCode(
  node: Code,
): node is Code & { data: { injectedNode: InjectedNode } } {
  return Boolean(
    node.data && (node.data as { injectedNode?: InjectedNode }).injectedNode
      ?.isInjected,
  );
}

/** Internal directive type: local file(s) or remote URL. */
type Directive =
  & {
    line: number; // 1-based line number within the spec block
    language: string;
    restParts: string[];
  }
  & (
    | {
      kind: "local";
      glob: string;
      baseDir: string;
      we: WalkEntry;
    }
    | {
      kind: "remote";
      url: string;
      base: string;
    }
  );

/** Options to customize how we detect "spec" blocks. */
export interface InjectedNodesOptions {
  /**
   * Decide whether a code node is an import/spec block and how to treat it.
   *
   * - return `false`  → not a spec block; ignore.
   * - return `"retain-after-injections"` →
   *       treat as spec, keep this node, and insert injected nodes
   *       immediately *after* it.
   * - return `"remove-before-injections"` →
   *       treat as spec, remove this node from the AST, and splice
   *       injected nodes into its place.
   *
   * If omitted, the default behavior is:
   *   - If the parsed PI has `--inject`, return `"retain-after-injections"`.
   *   - Otherwise, return `false`.
   */
  readonly isSpecBlock?: (
    node: Code,
    parsed: ReturnType<typeof parseEnrichedCodeFromCode>,
  ) => false | "retain-after-injections" | "remove-before-injections";
}

/** Tiny sync globber over a root directory using walkSync + globToRegExp. */
function expandGlobSync(pattern: string, root: string): WalkEntry[] {
  const regex = globToRegExp(pattern, { extended: true, globstar: true });

  const entries: WalkEntry[] = [];
  for (
    const we of walkSync(root, {
      includeFiles: true,
      includeDirs: false,
      followSymlinks: true,
    })
  ) {
    const rel = relative(root, we.path);
    if (regex.test(rel)) entries.push(we);
  }
  return entries;
}

/** Parse the spec string into local/remote directives. Sync version. */
function parseDirectivesFromSpec(
  spec: string,
  baseDir: string | string[],
): Directive[] {
  const baseDirs = Array.isArray(baseDir) ? baseDir : [baseDir];

  const lines = spec.split(/\r?\n/);
  const out: Directive[] = [];

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const parts = line.split(/\s+/);
    if (parts.length < 2) return;

    const [language, globOrUrl, ...restParts] = parts;

    // Remote URL?
    if (isTextHttpUrl(globOrUrl)) {
      // Use the first baseDir just for relative URL rendering
      const base = baseDirs[0] ?? Deno.cwd();
      out.push({
        kind: "remote",
        url: globOrUrl,
        base,
        language,
        restParts,
        line: lineNo,
      });
      return;
    }

    // Local glob
    for (const root of baseDirs) {
      const rootDir = isAbsolute(globOrUrl) ? "/" : (root || Deno.cwd());

      const matches = expandGlobSync(globOrUrl, rootDir);
      for (const we of matches) {
        out.push({
          kind: "local",
          glob: globOrUrl,
          baseDir: rootDir,
          we,
          language,
          restParts,
          line: lineNo,
        });
      }
    }
  });

  return out;
}

/**
 * Default heuristic for deciding whether a code block is a "spec/import"
 * block that should be expanded:
 *
 * - use parseEnrichedCodeFromCode(node)
 * - check for a lang called "import"
 *
 * You can override this via plugin options.
 */
function defaultIsSpecBlock(node: Code) {
  return node.lang === "import" ? "retain-after-injections" : false;
}

/**
 * The main remark plugin.
 *
 * It:
 * - Finds "spec" code fences (per isSpecBlock)
 * - Parses their body as import directives
 * - For each directive, injects a new mdast.Code node
 *   with:
 *   - lang = directive.language
 *   - meta = constructed PI string
 *   - value = file text (local, non-binary) or ""
 *   - data.injectedNode = { isInjected: true, source: ... }
 */
export const injectedNodes: Plugin<[InjectedNodesOptions?], Root> = (
  options,
) => {
  const isSpecBlock = options?.isSpecBlock ?? defaultIsSpecBlock;

  return (tree: Root) => {
    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Code[];
      mode: "retain-after-injections" | "remove-before-injections";
    }[] = [];

    visit(tree, "code", (node: Code, index, parent) => {
      if (parent == null || index == null) return;

      const parsed = parseEnrichedCodeFromCode(node);
      const mode = isSpecBlock(node, parsed);

      if (!mode) return; // not a spec block

      // Determine base dir(s) from PI flags
      const flags = parsed?.pi?.flags ?? {};
      const suppliedBase = (flags["base"] ?? flags["baseDir"]) as
        | string
        | string[]
        | boolean
        | undefined;

      let base: string | string[];
      if (!suppliedBase || typeof suppliedBase === "boolean") {
        base = Deno.cwd();
      } else {
        base = suppliedBase;
      }

      const directives = parseDirectivesFromSpec(node.value ?? "", base);
      if (!directives.length) return;

      const injectedNodesForThisSpec: Code[] = [];

      for (const d of directives) {
        const { language } = d;
        const isBinaryHint = language === "utf8";

        let pi: string;
        let importedFrom: string;
        let value = "";

        if (d.kind === "local") {
          importedFrom = d.we.path;
          const firstToken = relative(d.baseDir, d.we.path);

          pi = [
            firstToken,
            "--import",
            importedFrom,
            isBinaryHint ? "--is-binary" : "",
            ...d.restParts,
          ].join(" ").trim();

          if (!isBinaryHint) {
            // Non-binary local file: sync read into node.value
            value = Deno.readTextFileSync(importedFrom);
          }
        } else {
          // remote
          importedFrom = d.url;
          const firstToken = relativeUrlAsFsPath(d.base, d.url);

          pi = [
            firstToken,
            "--import",
            importedFrom,
            isBinaryHint ? "--is-binary" : "",
            ...d.restParts,
          ].join(" ").trim();

          // Remote: leave value empty; actual bytes are via rs in data.injectedNode.source
          value = "";
        }

        // Build injectedNode.source metadata
        let source: InjectedNodeSource | undefined;

        if (isBinaryHint && d.kind === "local") {
          source = {
            isRefToBinary: true,
            isContentAcquired: false,
            importedFrom,
            encoding: "UTF-8",
            stream: () => lazyFileBytesReader(importedFrom),
          };
        } else if (d.kind === "remote") {
          // Remote: mark as binary-ish reference but DO NOT start fetch here.
          source = {
            isRefToBinary: true,
            isContentAcquired: false,
            importedFrom,
            encoding: "UTF-8",
            stream: () => lazyUrlBytesReader(d.url),
          };
        } else {
          // Plain text local file (it's already in node.value)
          source = {
            isRefToBinary: false,
            isContentAcquired: true,
            importedFrom,
            original: value,
          };
        }

        const injected: Code = {
          type: "code",
          lang: language,
          meta: pi,
          value,
          data: {
            ...(node.data ?? {}),
            injectedNode: {
              isInjected: true,
              source,
            } satisfies InjectedNode,
          },
          // Optional position mapping approximate to spec line:
          position: node.position
            ? {
              start: {
                line: node.position.start.line + (d.line ?? 0),
                column: 1,
                offset: undefined,
              },
              end: {
                line: node.position.start.line + (d.line ?? 0),
                column: 1,
                offset: undefined,
              },
            }
            : undefined,
        };

        injectedNodesForThisSpec.push(injected);
      }

      if (injectedNodesForThisSpec.length) {
        mutations.push({
          parent,
          index,
          injected: injectedNodesForThisSpec,
          mode,
        });
      }
    });

    // Apply mutations after traversal, from right to left.
    mutations.sort((a, b) => b.index - a.index);

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        // Replace spec node with injected nodes
        parent.children.splice(index, 1, ...injected);
      } else {
        // retain-after-injections: keep spec; insert injected nodes after it
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};
