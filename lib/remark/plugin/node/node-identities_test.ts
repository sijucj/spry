// node-identities_test.ts

import { assert, assertArrayIncludes, assertEquals } from "@std/assert";
import remarkParse from "remark-parse";
import type { Heading, Node, Paragraph, Root } from "types/mdast";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import {
  hasNodeIdentities,
  type NodeIdentities,
  nodeIdentities,
} from "./node-identities.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function textOf(node: Heading | Paragraph): string {
  return (node.children as Any[])
    .map((child) => {
      if (typeof child.value === "string") return child.value;
      return "";
    })
    .join("");
}

/**
 * Minimal synthetic plugin that pretends a headingFrontmatter-style plugin
 * has already run by attaching `data.headingFM` to each heading.
 *
 * The IDs are intentionally simple and deterministic so tests can assert
 * on them without needing a full YAML frontmatter parser.
 */
function attachSyntheticHeadingFM() {
  return (tree: Root) => {
    let idx = 0;
    visit(tree, "heading", (node: Heading) => {
      const data = (node.data ??= {});
      (data as Any).headingFM = { id: `h${++idx}` };
    });
    return tree;
  };
}

/**
 * Minimal synthetic documentSchema-like plugin that attaches `sectionSchema`
 * to all paragraphs that appear under the second heading. This simulates
 * section-aware identity suppliers without needing the full doc-schema
 * machinery.
 */
function attachSyntheticSectionSchema() {
  return (tree: Root) => {
    let inMarkerSection = false;
    let encounteredHeadings = 0;

    visit(tree, (node: Node) => {
      if (node.type === "heading") {
        encounteredHeadings += 1;
        inMarkerSection = encounteredHeadings === 2;
        return;
      }

      if (node.type === "paragraph" && inMarkerSection) {
        const data = (node.data ??= {});
        (data as Any).sectionSchema = {
          id: "sec-marker",
          nature: "marker",
        };
      }
    });

    return tree;
  };
}

Deno.test(
  "nodeIdentities: multi-supplier identities, hooks, and catalog",
  async () => {
    const markdown = String.raw`
# Intro

Top-level paragraph.

## Marker

Paragraph in marker section.

\`\`\`ts
console.log("hi");
\`\`\`
`.trim();

    type Supplier = "content" | "fm" | "schema";

    const identifiedEvents: {
      type: string;
      text?: string;
      suppliers: string[];
    }[] = [];

    let capturedCatalog:
      | Record<Supplier, Record<string, Node>>
      | undefined;

    const processor = unified()
      .use(remarkParse)
      .use(attachSyntheticHeadingFM)
      .use(attachSyntheticSectionSchema)
      .use(nodeIdentities, {
        // Purely node-based identities: paragraphs.
        identityFromNode: (node, _root) => {
          if (node.type === "paragraph") {
            const text = textOf(node as Paragraph);
            const isMarker = text.toLowerCase().includes("marker");
            return {
              supplier: "content",
              identity: isMarker ? "marker-body" : "body",
            };
          }
          return false;
        },

        // Frontmatter-based identities for headings only.
        identityFromHeadingFM: (fm, node, _root) => {
          if (!fm?.id || node.type !== "heading") return false as const;
          return {
            supplier: "fm",
            identity: String(fm.id),
          };
        },

        // Section-aware identities: paragraphs belonging to a "marker" section.
        identityFromSection: (sectionInfo, node, _root) => {
          if (node.type !== "paragraph") return false as const;
          if (!sectionInfo || (sectionInfo as Any).nature !== "marker") {
            return false as const;
          }

          const s = sectionInfo as { id: string; nature: string };
          return {
            supplier: "schema",
            identity: [`section:${s.id}`, s.nature],
          };
        },

        identifiedAs: (node, ids) => {
          if (node.type !== "heading" && node.type !== "paragraph") {
            return;
          }
          identifiedEvents.push({
            type: node.type,
            text: textOf(node as Heading | Paragraph),
            suppliers: Object.keys(ids),
          });
        },

        catalog: (catalog) => {
          capturedCatalog = catalog;
        },
      });

    const tree = processor.parse(markdown) as Root;
    const result = (await processor.run(tree)) as Root;

    const headings: {
      text: string;
      identities: NodeIdentities<Supplier>;
    }[] = [];
    const paragraphs: {
      text: string;
      identities: NodeIdentities<Supplier>;
    }[] = [];

    visit(result, (node: Node) => {
      if (!hasNodeIdentities<Supplier>(node)) return;

      if (node.type === "heading") {
        headings.push({
          text: textOf(node as Heading),
          identities: (node as Any).data.identities,
        });
      } else if (node.type === "paragraph") {
        paragraphs.push({
          text: textOf(node as Paragraph),
          identities: (node as Any).data.identities,
        });
      }
    });

    // We care that *at least* our two headings are identified correctly.
    assert(headings.length >= 2);

    const introHeading = headings.find((h) => h.text === "Intro");
    const markerHeading = headings.find((h) => h.text === "Marker");
    assert(introHeading);
    assert(markerHeading);

    assertEquals(introHeading.identities, { fm: ["h1"] });
    assertEquals(markerHeading.identities, { fm: ["h2"] });

    // Paragraphs: same idea — assert our known paragraphs exist with identities.
    assert(paragraphs.length >= 2);

    const topParagraph = paragraphs.find(
      (p) => p.text === "Top-level paragraph.",
    );
    const markerParagraph = paragraphs.find(
      (p) => p.text === "Paragraph in marker section.",
    );

    assert(topParagraph);
    assert(markerParagraph);

    assertEquals(topParagraph.identities, {
      content: ["body"],
    });

    assertEquals(markerParagraph.identities, {
      content: ["marker-body"],
      schema: ["section:sec-marker", "marker"],
    });

    // identifiedAs hook fired for each identified heading/paragraph.
    assertArrayIncludes(
      identifiedEvents.map((e) => ({
        type: e.type,
        suppliers: e.suppliers.sort(),
      })),
      [
        { type: "heading", suppliers: ["fm"] },
        { type: "paragraph", suppliers: ["content"] },
        { type: "paragraph", suppliers: ["content", "schema"] },
      ],
    );

    // Catalog was emitted and contains supplier → identity → node mappings.
    assert(capturedCatalog);
    const catalogSuppliers = Object.keys(capturedCatalog as Any).sort();
    assertArrayIncludes(catalogSuppliers, ["content", "fm", "schema"]);

    const fmCatalog = (capturedCatalog as Any).fm as Record<string, Node>;
    const contentCatalog = (capturedCatalog as Any).content as Record<
      string,
      Node
    >;

    // At least these IDs must be present; other IDs are allowed.
    assertArrayIncludes(Object.keys(fmCatalog).sort(), ["h1", "h2"]);
    assertArrayIncludes(
      Object.keys(contentCatalog).sort(),
      ["body", "marker-body"],
    );
  },
);

Deno.test(
  "nodeIdentities: falsy suppliers, duplicate identities, and lightweight DX",
  async () => {
    const markdown = String.raw`
First paragraph should be identified.

Second paragraph should be skipped.

Third paragraph has multi multi identities.
`.trim();

    type Supplier = "demo";

    let catalogResult:
      | Record<Supplier, Record<string, Node>>
      | undefined;

    const processor = unified()
      .use(remarkParse)
      .use(nodeIdentities, {
        identityFromNode: (node, _root) => {
          if (node.type !== "paragraph") return false as const;

          const text = textOf(node as Paragraph);

          if (text.toLowerCase().includes("skipped")) {
            // Explicitly signal “no identity” with a falsy value.
            return false;
          }

          if (text.toLowerCase().includes("multi")) {
            // Duplicate identities in the same supplier should be de-duplicated
            // by the plugin before they land on `data.identities`.
            return {
              supplier: "demo",
              identity: ["multi", "multi", "extra"],
            };
          }

          // Simple, single-ID case for DX.
          return {
            supplier: "demo",
            identity: "single",
          };
        },

        // No headingFM / section suppliers here — this test focuses on
        // ergonomics, falsy handling, and duplicate suppression.
        catalog: (catalog) => {
          catalogResult = catalog;
        },
      });

    const tree = processor.parse(markdown) as Root;
    const result = (await processor.run(tree)) as Root;

    const paragraphs: {
      text: string;
      identities?: NodeIdentities<Supplier>;
    }[] = [];

    visit(result, "paragraph", (node: Paragraph) => {
      if (hasNodeIdentities<Supplier>(node as Any)) {
        paragraphs.push({
          text: textOf(node),
          identities: (node as Any).data.identities,
        });
      } else {
        paragraphs.push({
          text: textOf(node),
        });
      }
    });

    // Three paragraphs in source → three entries in summaries.
    assertEquals(paragraphs.length, 3);

    // First paragraph: simple single identity.
    assertEquals(paragraphs[0].identities, {
      demo: ["single"],
    });

    // Second paragraph: explicitly skipped via `false` → no identities attached.
    assertEquals(paragraphs[1].identities, undefined);

    // Third paragraph: duplicate IDs from supplier → de-duplicated on node.
    assertEquals(paragraphs[2].identities, {
      demo: ["multi", "extra"],
    });

    // Catalog exists and its keys reflect de-duplicated identities.
    assert(catalogResult);
    const demoCatalog = (catalogResult as Any).demo as Record<string, Node>;
    const catalogKeys = Object.keys(demoCatalog).sort();

    // Even though "multi" appeared twice in the supplier list and multiple
    // nodes can share the same ID, the catalog is identity-unique.
    assertEquals(catalogKeys, ["extra", "multi", "single"]);
  },
);
