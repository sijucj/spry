/**
 * Markdown AST I/O and source-related helpers:
 *
 * - Acquiring markdown from files / URLs / stdin
 * - Configuring the remark processor + plugins
 * - Computing byte ranges for nodes and heading-based sections
 * - Slicing original source text for nodes / sections
 */

import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Heading, Root, RootContent } from "types/mdast";
import { unified } from "unified";

import { remark } from "remark";

import codeFrontmatterPlugin from "./code-frontmatter.ts";
import docFrontmatterPlugin from "./doc-frontmatter.ts";
import documentSchemaPlugin, {
  boldParagraphSectionRule,
  colonParagraphSectionRule,
} from "./doc-schema.ts";
import headingFrontmatterPlugin from "./heading-frontmatter.ts";
import { classifiersFromFrontmatter } from "./node-classify-fm.ts";
import nodeClassifierPlugin from "./node-classify.ts";
import nodeIdentitiesPlugin from "./node-identities.ts";

import {
  SourceProvenance,
  sources,
  textSources,
  uniqueSources,
} from "../universal/resource.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---------------------------------------------------------------------------
// Remark orchestration
// ---------------------------------------------------------------------------

export function mardownParserPipeline() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"]) // extracts to YAML node but does not parse
    .use(remarkDirective) // creates directives from :[x] ::[x] and :::x
    .use(docFrontmatterPlugin) // parses extract YAML and stores at md AST root
    .use(remarkGfm) // support GitHub flavored markdown
    .use(headingFrontmatterPlugin) // find closest YAML blocks near headings and attached to heading.data[headingFM]
    .use(codeFrontmatterPlugin, { // finds code cells and extract posix PI and attributes to treat as "code frontmatter"
      coerceNumbers: true, // "9" -> 9
      onAttrsParseError: "ignore", // ignore invalid JSON5 instead of throwing
    })
    .use(nodeClassifierPlugin, {
      // classifies nodes using instructions from markdown document and headings frontmatter
      // be sure that all frontmatter plugins are run before this
      classifiers: classifiersFromFrontmatter(),
    })
    .use(nodeIdentitiesPlugin, {
      // establish identities last, after everything else is done for stability
      identityFromHeadingFM: (fm, node) => {
        if (!fm?.id || node.type !== "heading") return false as const;
        return {
          supplier: "headFM",
          identity: String(fm.id),
        };
      },
    })
    .use(documentSchemaPlugin, {
      // this plugin maintains node indexes so if you plan on mutating the AST,
      // do it before this plugin
      namespace: "prime",
      enrichWithBelongsTo: true,
      includeDefaultHeadingRule: true,
      sectionRules: [
        boldParagraphSectionRule(),
        colonParagraphSectionRule(),
      ],
    });
}

export async function* markdownASTs(
  src: Iterable<SourceProvenance> | AsyncIterable<SourceProvenance>,
  options?: Parameters<typeof textSources>[1] & {
    readonly mdParsePipeline?: ReturnType<typeof mardownParserPipeline>;
  },
) {
  const mdpp = options?.mdParsePipeline ?? mardownParserPipeline();
  for await (
    const ts of textSources(uniqueSources(sources(src)), options)
  ) {
    const mdastRoot = mdpp.parse(ts.text);
    await mdpp.run(mdastRoot);
    yield {
      ...ts,
      mdastRoot,
      mdText: {
        nodeOffsets: (node: RootContent) => nodeOffsetsInSource(ts.text, node),
        sliceForNode: (node: RootContent) => sliceSourceForNode(ts.text, node),
        sectionRangesForHeadings: (headings: Heading[]) =>
          computeSectionRangesForHeadings(mdastRoot, ts.text, headings),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Source acquisition
// ---------------------------------------------------------------------------

export function nodeOffsetsInSource(
  source: string,
  node: RootContent,
): [number, number] | undefined {
  const pos = node.position as Any;
  if (!pos || !pos.start || !pos.end) return undefined;

  const start = pos.start as Any;
  const end = pos.end as Any;

  if (
    typeof start.offset === "number" &&
    typeof end.offset === "number"
  ) {
    return [start.offset, end.offset];
  }

  const lines = source.split(/\r?\n/);

  const startLineIdx = (start.line as number ?? 1) - 1;
  const endLineIdx = (end.line as number ?? 1) - 1;
  const startCol = (start.column as number ?? 1) - 1;
  const endCol = (end.column as number ?? 1) - 1;

  if (
    startLineIdx < 0 || startLineIdx >= lines.length ||
    endLineIdx < 0 || endLineIdx >= lines.length
  ) {
    return undefined;
  }

  const indexFromLineCol = (lineIdx: number, col: number): number => {
    let idx = 0;
    for (let i = 0; i < lineIdx; i++) {
      // +1 for newline
      idx += lines[i].length + 1;
    }
    return idx + col;
  };

  const startOffset = indexFromLineCol(startLineIdx, startCol);
  const endOffset = indexFromLineCol(endLineIdx, endCol);
  return [startOffset, endOffset];
}

/**
 * Slice the original source text that corresponds to the given node.
 *
 * If offsets are unavailable, falls back to re-stringifying the node via remark.
 */
export function sliceSourceForNode(
  source: string,
  node: RootContent,
): string {
  const offsets = nodeOffsetsInSource(source, node);
  if (offsets) {
    const [start, end] = offsets;
    return source.slice(start, end);
  }

  // Fallback: as a last resort, re-stringify this node
  const root: Root = { type: "root", children: [node] };
  return remark().stringify(root);
}

// ---------------------------------------------------------------------------
// Section ranges
// ---------------------------------------------------------------------------

export interface SectionRange {
  start: number;
  end: number;
}

/**
 * Given the root, source, and a list of selected heading nodes that are
 * direct children of the root, compute non-overlapping section ranges:
 * each from a heading's start to the next heading of same or higher depth
 * (or end-of-file).
 */
export function computeSectionRangesForHeadings(
  root: Root,
  source: string,
  headings: Heading[],
): SectionRange[] {
  const children = root.children ?? [];
  if (children.length === 0 || headings.length === 0) return [];

  // Map heading node -> its index in root.children (only for direct children)
  const indexByNode = new Map<Heading, number>();
  children.forEach((child, idx) => {
    if (child.type === "heading") {
      indexByNode.set(child as Heading, idx);
    }
  });

  const indices: number[] = [];
  for (const h of headings) {
    const idx = indexByNode.get(h);
    if (idx !== undefined) indices.push(idx);
  }
  if (indices.length === 0) return [];

  indices.sort((a, b) => a - b);

  const ranges: SectionRange[] = [];

  for (const idx of indices) {
    const heading = children[idx] as Heading;
    const depth = heading.depth ?? 1;

    const offsets = nodeOffsetsInSource(source, heading as RootContent);
    if (!offsets) continue;
    const [startOffset] = offsets;

    // Find next heading of same or higher depth
    let endOffset = source.length;
    for (let j = idx + 1; j < children.length; j++) {
      const candidate = children[j];
      if (candidate.type === "heading") {
        const ch = candidate as Heading;
        const cDepth = ch.depth ?? 1;
        if (cDepth <= depth) {
          const nextOffsets = nodeOffsetsInSource(
            source,
            candidate as RootContent,
          );
          if (nextOffsets) {
            endOffset = nextOffsets[0];
          }
          break;
        }
      }
    }

    ranges.push({ start: startOffset, end: endOffset });
  }

  // Merge overlapping/adjacent ranges
  ranges.sort((a, b) => a.start - b.start);
  const merged: SectionRange[] = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1]!;
    if (r.start <= last.end) {
      // overlap or adjacency: extend the existing range
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}
