/**
 * CodeAnnotations is a structured enrichment type for remark `code` nodes.
 * It parses fenced code blocks' content for Spry `@` annotations.
 *
 * The output is stored on each **mdast** `code` node at:
 *
 *   `node.data[codeAnns] = [{ language, annotations, annsCatalog }]`
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import codeAnnotations from "./code-annotations.ts";
 *
 * const md = [
 *   "```bash --env prod -L 9 tag tag { priority: 3, note: 'ok' }",
 *   "# @description 'test'",
 *   "echo hi",
 *   "```",
 * ].join("\n");
 *
 * const tree = remark().use(codeAnnotations).parse(md);
 *
 * // Walk to a code node and inspect:
 * const code = (tree.children.find(n => n.type === "code") as any);
 * const { codeFM } = code.data;
 *
 * console.log(codeFM.lang);            // "bash"
 * console.log(codeFM.pi.pos);          // ["env","L","tag","tag","level","key"]
 * console.log(codeFM.pi.flags.env);    // "prod"
 * console.log(codeFM.pi.flags.level);  // 9  (coerced)
 * console.log(codeFM.attrs.priority);  // 3  (from JSON5)
 * ```
 *
 * @remarks
 * - This plugin is **idempotent**; running it more than once will reuse
 *   node data and not duplicate work.
 * - Designed to be used standalone or as a helper for selector engines
 *   and Markdown-driven execution/orchestration engines.
 * - Does not mutate the code content; only attaches metadata on `node.data`.
 */

import { z } from "jsr:@zod/zod@4";
import type { Code, Root, RootContent } from "npm:@types/mdast@^4";
import { visit } from "npm:unist-util-visit@^5";
import {
  AnnotationCatalog,
  extractAnnotationsFromTextSync,
} from "../../universal/code-comments.ts";
import { LanguageSpec } from "../../universal/code.ts";

/** The structured enrichment attached to a code node by this plugin. */
export type CodeAnnotations<Anns extends Record<string, unknown>> = {
  readonly annotations?: Anns;
  readonly annsCatalog: AnnotationCatalog<Anns>;
  readonly factory: ReturnType<typeof annotationsFactory<Anns>>;
};

export const CODEANNS_KEY = "codeAnns" as const;
export type CodeWithAnnotationsData<Anns extends Record<string, unknown>> = {
  readonly codeAnns: CodeAnnotations<Anns>;
  [key: string]: unknown;
};

export type CodeWithAnnotationsNode<Anns extends Record<string, unknown>> =
  & Code
  & {
    data: CodeWithAnnotationsData<Anns>;
  };

/**
 * Type guard: returns true if a `RootContent` node is a `code` node
 * that already carries CodeWithAnnotationsNode at the default store key.
 */
export function isCodeWithAnnotationsNode<Anns extends Record<string, unknown>>(
  node: RootContent,
): node is CodeWithAnnotationsNode<Anns> {
  if (node.type === "code" && node.data && CODEANNS_KEY in node.data) {
    return true;
  }
  return false;
}

/** Configuration options for the CodeAnnotations plugin. */
export interface CodeAnnotationsOptions<Anns extends Record<string, unknown>> {
  /** If defined, checks whether to ingest annotations from code value (`source`) */
  ingest?: (code: Code) => false | {
    language: LanguageSpec;
    prefix?: string; // TODO: should we just introduce a `normalize: () => string` for more flexibility?
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  };
  /**
   * If defined, this callback is called whenever code cells are enriched
   */
  collect?: (node: CodeWithAnnotationsNode<Anns>) => void;
}

/**
 * CodeAnnotations remark plugin.
 *
 * @param options - See {@link CodeAnnotationsOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link CodeAnnotations}.
 *
 * @example
 * ```ts
 * import { remark } from "npm:remark@^15";
 * import codeAnnotations from "./code-annotations.ts";
 *
 * const processor = remark().use(codeAnnotations);
 */
export default function codeAnnotations<Anns extends Record<string, unknown>>(
  options: CodeAnnotationsOptions<Anns> = {},
) {
  const { ingest, collect } = options;

  return function transformer(tree: Root) {
    if (!ingest) return;
    visit(tree, "code", (node) => {
      // deno-lint-ignore no-explicit-any
      const untypedNode = node as any;
      const data = (untypedNode.data ??= {});
      if (!data[CODEANNS_KEY]) {
        const answer = ingest(node);
        if (answer) {
          const factory = annotationsFactory(answer);
          const annsCatalog = factory.catalog(node.value);
          const annotations = factory.transform(annsCatalog);
          data[CODEANNS_KEY] = {
            annotations,
            annsCatalog,
            factory,
          } satisfies CodeAnnotations<Anns>;
        }
      }
      collect?.(node as CodeWithAnnotationsNode<Anns>);
    });
  };
}

export function annotationsFactory<Anns extends Record<string, unknown>>(
  init: {
    language: LanguageSpec;
    prefix?: string;
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  },
) {
  function transform(
    catalog: Awaited<
      ReturnType<typeof extractAnnotationsFromTextSync<unknown>>
    >,
    opts?: { prefix?: string; defaults?: Partial<Anns> },
  ) {
    const { prefix, defaults } = opts ?? init;
    const annotations = prefix
      ? (catalog.items
        .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix))
        .map((it) =>
          [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        ))
      : catalog.items.map((it) => [it.key!, it.value ?? it.raw] as const);
    const found = annotations.length;
    if (found == 0) {
      if (!defaults) return undefined;
      if (Object.keys(defaults).length == 0) return undefined;
    }
    return { ...defaults, ...Object.fromEntries(annotations) } as Anns;
  }

  function catalog(source: string, language?: LanguageSpec) {
    return extractAnnotationsFromTextSync<Anns>(
      source,
      language ?? init?.language,
      {
        tags: { multi: true, valueMode: "json" },
        kv: false,
        yaml: false,
        json: false,
      },
    );
  }

  return { ...init, catalog, transform };
}
