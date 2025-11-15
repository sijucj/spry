/**
 * @module document-frontmatter
 *
 * Remark plugin that:
 * - Assumes remark-frontmatter has already run.
 * - Finds the first `yaml` node in the tree.
 * - Parses it as YAML.
 * - Optionally validates it with a Zod schema (safeParse).
 * - Stores a rich parsedFM payload on:
 *   - the yaml node: node.data.parsedFM
 *   - the document root: root.data.documentFrontmatter
 *   - the VFile: file.data.frontmatter (fm only, for convenience)
 */

import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Root, RootContent } from "npm:@types/mdast@^4";
import type { Plugin } from "npm:unified@^11";
import type { VFile } from "npm:vfile@^6";
import { z } from "npm:zod@^4";

// deno-lint-ignore no-explicit-any
type Any = any;
type Dict = Record<string, unknown>;

export interface ParsedFrontmatter<FM extends Dict = Dict> {
  fm: FM;
  yamlErr?: Error;
  // Always present when a schema is supplied (even if it failed)
  zodParseResult?: z.ZodSafeParseResult<FM>;
}

export type YamlWithParsedFrontmatter<FM extends Dict = Dict> =
  & Extract<RootContent, { type: "yaml" }>
  & {
    data: {
      parsedFM: ParsedFrontmatter<FM>;
      [key: string]: unknown;
    };
  };

export interface DocumentFrontmatter<FM extends Dict = Dict> {
  node: YamlWithParsedFrontmatter<FM>;
  parsed: ParsedFrontmatter<FM>;
}

export type RootWithDocumentFrontmatter<FM extends Dict = Dict> = Root & {
  data: Root["data"] & {
    documentFrontmatter: DocumentFrontmatter<FM>;
  };
};

export interface DocumentFrontmatterOptions<FM extends Dict = Dict> {
  // Optional Zod schema to validate the parsed YAML
  readonly schema?: z.ZodType<FM, Any, Any>;
  // If true, remove the YAML block from tree.children after parsing
  readonly removeYamlNode?: boolean;
}

function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null;
}

export function isYamlWithParsedFrontmatter<
  FM extends Dict = Dict,
>(node: RootContent): node is YamlWithParsedFrontmatter<FM> {
  if (node.type !== "yaml") return false;
  const data = (node as { data?: unknown }).data;
  if (!isObject(data)) return false;
  const pfm = (data as Dict).parsedFM;
  return isObject(pfm) && "fm" in pfm;
}

export function isRootWithDocumentFrontmatter<
  FM extends Dict = Dict,
>(tree: Root): tree is RootWithDocumentFrontmatter<FM> {
  const data = (tree as { data?: unknown }).data;
  if (!isObject(data)) return false;
  const dfm = (data as Dict).documentFrontmatter;
  if (!isObject(dfm)) return false;
  return "node" in dfm && "parsed" in dfm;
}

/**
 * Plugin implementation.
 */
export const documentFrontmatter: Plugin<
  [DocumentFrontmatterOptions?],
  Root
> = function documentFrontmatterPlugin(options?: DocumentFrontmatterOptions) {
  return function transform(tree: Root, file?: VFile): void {
    const yamlIndex = tree.children.findIndex(
      (n): n is Extract<RootContent, { type: "yaml" }> => n.type === "yaml",
    );

    if (yamlIndex < 0) return;

    const yamlNode = tree.children[yamlIndex] as Extract<
      RootContent,
      { type: "yaml" }
    >;

    const raw = typeof yamlNode.value === "string" ? yamlNode.value : "";
    let yamlErr: Error | undefined;
    let parsedYaml: unknown = {};

    try {
      parsedYaml = YAMLparse(raw);
      if (!isObject(parsedYaml)) {
        parsedYaml = {};
      }
    } catch (err) {
      yamlErr = err instanceof Error ? err : new Error(String(err));
      parsedYaml = {};
    }

    type FM = Dict;

    let fm: FM = parsedYaml as FM;

    const schema = options?.schema as z.ZodType<FM> | undefined;

    // This will always be defined when a schema is supplied (even if it fails)
    let zodParseResult: z.ZodSafeParseResult<FM> | undefined;

    if (schema) {
      const result = schema.safeParse(parsedYaml);
      zodParseResult = result;
      if (result.success) {
        fm = result.data as FM;
      }
    }

    const parsedFM: ParsedFrontmatter<FM> = {
      fm,
      ...(yamlErr ? { yamlErr } : null),
      ...(schema ? { zodParseResult } : null),
    };

    // Attach to yaml node
    const nodeData = (yamlNode.data ??= {} as Dict);
    (nodeData as Any).parsedFM = parsedFM;

    // Attach to document root for O(1) lookup
    const rootData = (tree.data ??= {} as Dict);
    (rootData as Any).documentFrontmatter = {
      node: yamlNode as YamlWithParsedFrontmatter<FM>,
      parsed: parsedFM,
    } satisfies DocumentFrontmatter<FM>;

    // Also expose plain fm via VFile for ecosystem compatibility
    if (file) {
      const fdata = (file.data ??= {} as Dict);
      // just the fm object, not the full parsedFM
      (fdata as Any).frontmatter = fm;
    }

    // Optionally remove the YAML node itself from the AST
    if (options?.removeYamlNode) {
      tree.children.splice(yamlIndex, 1);
    }
  };
};

export default documentFrontmatter;
