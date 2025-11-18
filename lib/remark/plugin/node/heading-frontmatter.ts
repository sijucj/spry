/**
 * @module heading-frontmatter
 *
 * @summary
 * A remark plugin that lets headings carry their own YAML / JSON
 * “frontmatter” defined in fenced code blocks within the heading’s section.
 *
 * A heading’s “section” is all sibling nodes from that heading until the next
 * heading of any depth. Any number of qualifying code fences inside that
 * section can contribute frontmatter; their parsed objects are merged
 * (later ones override earlier keys).
 *
 * By default, a fenced code block is considered "heading frontmatter" if:
 *
 * - `lang` is one of: yaml, yml, json, json5
 * - AND the code text contains one of:
 *   - `HFM` or `META` (ALL CAPS), or
 *   - `headFM`, `headingFM` (any case)
 */

import type { Code, Heading, Root, RootContent } from "types/mdast";
import type { Data, Node } from "types/unist";
import type { Plugin } from "unified";

import { parse as parseYaml } from "@std/yaml";
import JSON5 from "json5";

// ... existing imports, types, plugin code above ...

/**
 * Type guard:
 * Ensures the node is a Heading *and* has a typed `headingFM`
 * (with an optional `inheritedHeadingFM`).
 */
export function isHeadingWithFrontmatter<
  OwnShape extends Record<string, unknown>,
  InheritedShape extends Record<string, unknown> = OwnShape,
>(
  node: Node,
): node is Heading & {
  data: {
    headingFM: OwnShape;
    inheritedHeadingFM?: InheritedShape;
  };
} {
  if (node.type !== "heading") return false;

  const data = node.data;
  if (!data || typeof data !== "object") return false;

  // deno-lint-ignore no-explicit-any
  const fm = (data as any).headingFM;
  if (!fm || typeof fm !== "object") return false;

  return true;
}

export type CodeWithFrontmatterData = {
  readonly codeConsumedAsHeadingFM: RootContent[];
  [key: string]: unknown;
};

export type CodeConsumedAsHeadingFrontmatterNode = Code & {
  data: CodeWithFrontmatterData;
};

/**
 * Type guard: returns true if a `RootContent` node is a `code` node
 * that already carries CodeWithFrontmatterNode at the default store key.
 */
export function isCodeConsumedAsHeadingFrontmatterNode(
  node: RootContent,
): node is CodeConsumedAsHeadingFrontmatterNode {
  if (
    node.type === "code" && node.data &&
    "codeConsumedAsHeadingFM" in node.data
  ) {
    return true;
  }
  return false;
}

type JsonObject = Record<string, unknown>;

export type FrontmatterConsumeDecision =
  | false
  | "retain-after-consume"
  | "remove-before-consume";

export interface HeadingFrontmatterOptions {
  readonly isHeading?: (node: RootContent) => node is Heading;
  readonly isFrontmatterCode?: (code: Code) => FrontmatterConsumeDecision;
  readonly parseFrontmatterCode?: (node: Code) => JsonObject | undefined;
  readonly annotationNode?: (n: RootContent) => string | false;
}

const FRONTMATTER_LANGS = new Set(["yaml", "yml", "json", "json5"]);

/**
 * Ensure we only treat plain objects as frontmatter.
 */
function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Default: parse from the raw code block using YAML / JSON / JSON5 based on `lang`.
 */
export function parseFrontmatterCode(node: Code): JsonObject | undefined {
  const raw = node.value ?? "";
  if (!raw.trim()) return undefined;

  const lang = (node.lang ?? "").toLowerCase().trim();

  try {
    if (lang === "yaml" || lang === "yml") {
      return asJsonObject(parseYaml(raw));
    }
    if (lang === "json") {
      return asJsonObject(JSON.parse(raw));
    }
    if (lang === "json5") {
      return asJsonObject(JSON5.parse(raw));
    }
  } catch {
    // If parsing fails, just ignore and treat as "no frontmatter"
  }

  return undefined;
}

/**
 * Default heading detector.
 */
function defaultIsHeading(node: RootContent): node is Heading {
  return node.type === "heading";
}

/**
 * Default frontmatter code detector:
 * YAML / YML / JSON / JSON5 fenced code WITH a heading-frontmatter marker.
 */
function defaultIsFrontmatterCode(node: Code): FrontmatterConsumeDecision {
  if (
    node &&
    node.type === "code" &&
    node.lang &&
    FRONTMATTER_LANGS.has(node.lang.toLowerCase().trim()) && node.meta &&
    (node.meta === "META" || node.meta === "HFM" || node.meta === "headingFM" ||
      node.meta === "headFM")
  ) {
    return "retain-after-consume";
  }
  return false;
}

/**
 * Merge two JSON-ish objects with `b` winning on conflicts.
 */
function mergeFm(
  a: JsonObject | undefined,
  b: JsonObject | undefined,
): JsonObject | undefined {
  if (!a && !b) return undefined;
  return {
    ...(a ?? {}),
    ...(b ?? {}),
  };
}

/**
 * remark plugin: attach per-heading and inherited heading frontmatter.
 *
 * - `data.headingFM`: merge of all frontmatter blocks in the heading’s
 *   section (from that heading until the next heading of *any* depth).
 * - `data.inheritedHeadingFM`: merge of all ancestor headings’ local
 *   frontmatter plus this heading’s own `headingFM`.
 */
export const headingFrontmatter: Plugin<
  [HeadingFrontmatterOptions?],
  Root
> = (options = {}) => {
  const {
    isHeading = defaultIsHeading,
    isFrontmatterCode = defaultIsFrontmatterCode,
    parseFrontmatterCode: parseFm = parseFrontmatterCode,
    annotationNode = (n: RootContent) =>
      n.type === "paragraph" &&
        n.children[0]?.type === "text" &&
        n.children[0].value.startsWith("@")
        ? n.children[0].value
        : false,
  } = options;

  return (tree) => {
    const children = tree.children;

    // Track inherited FM by heading depth (1–6).
    const inheritedByDepth: Array<JsonObject | undefined> = [];

    let i = 0;
    while (i < children.length) {
      const node = children[i] as RootContent;

      if (!isHeading(node)) {
        i += 1;
        continue;
      }

      const depth = node.depth;

      // When we hit a heading at this depth, discard deeper levels.
      for (let d = depth + 1; d < inheritedByDepth.length; d++) {
        inheritedByDepth[d] = undefined;
      }

      // Section for this heading: from i+1 until *next* heading of any depth.
      let sectionEnd = children.length;
      for (let j = i + 1; j < children.length; j++) {
        const n = children[j] as RootContent;
        if (isHeading(n)) {
          sectionEnd = j;
          break;
        }
      }

      // Collect and merge all frontmatter blocks within the section.
      let localFm: JsonObject | undefined;
      const removeIdxs: number[] = [];

      for (let j = i + 1; j < sectionEnd; j++) {
        const n = children[j] as RootContent;

        const ann = annotationNode(n);
        if (ann && ann.startsWith("@id ")) {
          localFm = mergeFm(localFm, { id: ann.slice(4) });
          removeIdxs.push(j);
          continue;
        }

        if (n.type !== "code") continue;

        const decision = isFrontmatterCode(n);
        if (!decision) continue;

        const parsed = parseFm(n as Code);
        if (parsed) {
          localFm = mergeFm(localFm, parsed);
        }

        if (isCodeConsumedAsHeadingFrontmatterNode(n)) {
          n.data.codeConsumedAsHeadingFM.push(n);
        } else {
          const data = n.data ??= {};
          // deno-lint-ignore no-explicit-any
          (data as any)["codeConsumedAsHeadingFM"] = [n];
        }

        if (decision === "remove-before-consume") {
          removeIdxs.push(j);
        }
      }

      // Remove consumed nodes if requested (from the end to preserve indices).
      if (removeIdxs.length) {
        removeIdxs.sort((a, b) => b - a);
        for (const idx of removeIdxs) {
          children.splice(idx, 1);
          if (idx < sectionEnd) sectionEnd--;
        }
      }

      const parentInherited = depth > 1
        ? inheritedByDepth[depth - 1]
        : undefined;
      const inherited = mergeFm(parentInherited, localFm);

      const data = (node.data ??= {} as Data);
      const d = data as JsonObject;

      if (localFm && Object.keys(localFm).length > 0) {
        d.headingFM = localFm;
      }

      if (inherited && Object.keys(inherited).length > 0) {
        d.inheritedHeadingFM = inherited;
      }

      inheritedByDepth[depth] = inherited;

      i += 1;
    }
  };
};

export default headingFrontmatter;
