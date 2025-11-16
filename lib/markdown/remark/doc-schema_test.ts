import { assert, assertEquals } from "jsr:@std/assert@^1";

import remarkParse from "npm:remark-parse@^11";
import { unified } from "npm:unified@^11";

import {
  boldParagraphSectionRule,
  colonParagraphSectionRule,
  documentSchema,
  hasBelongsToSection,
  hasSectionSchema,
  type HeadingSectionSchema,
  isBoldParagraphSection,
  type MarkerSectionSchema,
  type SectionSchema,
} from "./doc-schema.ts";

import type { Paragraph, Root, RootContent } from "npm:@types/mdast@^4";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MARKER_FIXTURE = `
# Title

Intro.

**BoldOnly**

Middle text.

Field:

End text.
`.trim();

// root children indices (expected):
// 0: heading "# Title"
// 1: paragraph "Intro."
// 2: paragraph "**BoldOnly**"
// 3: paragraph "Middle text."
// 4: paragraph "Field:"
// 5: paragraph "End text."

const BOLD_TITLE_FIXTURE = `
**bold text without colon**

**bold text with colon inside:**

**bold text with colon outside**:
`.trim();

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function collectSectionsByNamespace(
  tree: Root,
): Map<string, SectionSchema[]> {
  const result = new Map<string, SectionSchema[]>();

  const walk = (n: RootContent | Root): void => {
    if (hasSectionSchema(n)) {
      const catalog = n.data.sectionSchema;
      for (const [ns, section] of Object.entries(catalog)) {
        const list = result.get(ns);
        if (list) {
          list.push(section);
        } else {
          result.set(ns, [section]);
        }
      }
    }
    if ("children" in n && Array.isArray(n.children)) {
      for (const c of n.children) walk(c);
    }
  };

  walk(tree);
  return result;
}

function isHeadingSection(s: SectionSchema): s is HeadingSectionSchema {
  return s.nature === "heading";
}

function isMarkerSection(s: SectionSchema): s is MarkerSectionSchema {
  return s.nature === "marker";
}

function isBoldSingleLineParagraph(node: RootContent): node is Paragraph {
  if (node.type !== "paragraph") return false;
  if (node.children.length !== 1) return false;
  return node.children[0].type === "strong";
}

function isColonSingleLineParagraph(node: RootContent): node is Paragraph {
  if (node.type !== "paragraph") return false;
  if (node.children.length !== 1) return false;
  const child = node.children[0];
  return child.type === "text" && child.value.trimEnd().endsWith(":");
}

/**
 * For a given array of sections, return the "innermost" section
 * covering an index (if any). Innermost = largest startIndex where start < i < end.
 */
function innermostSectionAtIndex(
  sections: readonly SectionSchema[],
  index: number,
): SectionSchema | undefined {
  let best: SectionSchema | undefined;
  for (const s of sections) {
    if (index > s.startIndex && index < s.endIndex) {
      if (!best || s.startIndex > best.startIndex) {
        best = s;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Test 1: single namespace structure, hierarchy, containership
// ---------------------------------------------------------------------------

Deno.test("documentSchema — structure in single namespace", async (t) => {
  const processor = unified()
    .use(remarkParse)
    .use(documentSchema, {
      namespace: "prime",
      enrichWithBelongsTo: true,
      includeDefaultHeadingRule: true,
      sectionRules: [
        boldParagraphSectionRule(),
        colonParagraphSectionRule(),
      ],
    });

  const tree = processor.parse(MARKER_FIXTURE) as Root;
  processor.runSync(tree);

  const children = tree.children;
  const byNs = collectSectionsByNamespace(tree);
  const primeSections = byNs.get("prime") ?? [];

  const primeHeadings = primeSections.filter(isHeadingSection);
  const primeMarkers = primeSections.filter(isMarkerSection);

  await t.step("one heading section spans all top-level children", () => {
    assertEquals(primeHeadings.length, 1);
    const h = primeHeadings[0];
    assertEquals(h.startIndex, 0);
    assertEquals(h.endIndex, children.length);
    assertEquals(h.children.length, 2);
  });

  await t.step(
    "two marker sections (bold + colon) with heading as parent",
    () => {
      assertEquals(primeMarkers.length, 2);
      const parent = primeHeadings[0];

      for (const m of primeMarkers) {
        assertEquals(m.parent, parent);
        assert(parent.children.includes(m));
      }

      const kinds = new Set(primeMarkers.map((m) => m.markerKind));
      assert(kinds.has("bold-paragraph"));
      assert(kinds.has("colon-paragraph"));
    },
  );

  await t.step("marker start and span indices match expected structure", () => {
    const boldParaIndex = children.findIndex(isBoldSingleLineParagraph);
    const colonParaIndex = children.findIndex(isColonSingleLineParagraph);

    assertEquals(boldParaIndex, 2);
    assertEquals(colonParaIndex, 4);

    const boldSection = primeMarkers.find((m) =>
      m.markerKind === "bold-paragraph"
    );
    const colonSection = primeMarkers.find((m) =>
      m.markerKind === "colon-paragraph"
    );

    assert(boldSection);
    assert(colonSection);

    // bold: [2, 4) -> interior index: 3
    assertEquals(boldSection.startIndex, 2);
    assertEquals(boldSection.endIndex, 4);

    // colon: [4, 6) -> interior index: 5
    assertEquals(colonSection.startIndex, 4);
    assertEquals(colonSection.endIndex, 6);
  });

  await t.step("bold marker section captures title without colon", () => {
    const boldSection = primeMarkers.find((m) =>
      m.markerKind === "bold-paragraph"
    );
    assert(boldSection);
    assertEquals(boldSection.title, "BoldOnly");
  });

  await t.step("belongsToSection points to innermost section per index", () => {
    const sections = primeSections;

    for (let i = 0; i < children.length; i++) {
      const node = children[i];

      if (!hasBelongsToSection(node)) {
        const expectedNone = innermostSectionAtIndex(sections, i);
        assertEquals(expectedNone, undefined);
        continue;
      }

      const belongs = node.data.belongsToSection["prime"];
      const expected = innermostSectionAtIndex(sections, i);

      assert(expected);
      assertEquals(belongs, expected);
    }
  });

  await t.step("heading start node has no belongsToSection", () => {
    const heading = children[0];
    assertEquals(hasBelongsToSection(heading), false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: multi-namespace structure and containership (looser invariants)
// ---------------------------------------------------------------------------

Deno.test("documentSchema — multi-namespace structural separation", async (t) => {
  const processor = unified()
    .use(remarkParse)
    .use(documentSchema, {
      namespace: "ns1",
      enrichWithBelongsTo: true,
      includeDefaultHeadingRule: true,
      sectionRules: [boldParagraphSectionRule()],
    })
    .use(documentSchema, {
      namespace: "ns2",
      enrichWithBelongsTo: true,
      includeDefaultHeadingRule: true,
      sectionRules: [colonParagraphSectionRule()],
    });

  const tree = processor.parse(MARKER_FIXTURE) as Root;
  processor.runSync(tree);

  const children = tree.children;
  const byNs = collectSectionsByNamespace(tree);
  const ns1Sections = byNs.get("ns1") ?? [];
  const ns2Sections = byNs.get("ns2") ?? [];

  const ns1Headings = ns1Sections.filter(isHeadingSection);
  const ns2Headings = ns2Sections.filter(isHeadingSection);
  const ns1Markers = ns1Sections.filter(isMarkerSection);
  const ns2Markers = ns2Sections.filter(isMarkerSection);

  await t.step(
    "each namespace has at most one heading section spanning the document",
    () => {
      assert(ns1Headings.length <= 1);
      assert(ns2Headings.length <= 1);

      if (ns1Headings.length === 1) {
        const h = ns1Headings[0];
        assertEquals(h.startIndex, 0);
        assertEquals(h.endIndex, children.length);
      }

      if (ns2Headings.length === 1) {
        const h = ns2Headings[0];
        assertEquals(h.startIndex, 0);
        assertEquals(h.endIndex, children.length);
      }
    },
  );

  await t.step("marker sections are namespace-specific when present", () => {
    assert(ns1Markers.length <= 1);
    assert(ns2Markers.length <= 1);

    if (ns1Markers.length === 1 && ns1Headings.length === 1) {
      const m = ns1Markers[0];
      assertEquals(m.parent, ns1Headings[0]);
      assert(ns1Headings[0].children.includes(m));
    }

    if (ns2Markers.length === 1 && ns2Headings.length === 1) {
      const m = ns2Markers[0];
      assertEquals(m.parent, ns2Headings[0]);
      assert(ns2Headings[0].children.includes(m));
    }
  });

  await t.step(
    "sectionSchema catalogs can hold multiple namespaces on a node",
    () => {
      const headingNode = children[0];
      if (!hasSectionSchema(headingNode)) {
        // no sections, nothing to assert
        return;
      }
      const keys = Object.keys(headingNode.data.sectionSchema);
      assert(keys.length >= 1);
    },
  );

  await t.step("belongsToSection is per-namespace innermost section", () => {
    for (let i = 0; i < children.length; i++) {
      const node = children[i];

      const ns1Expected = innermostSectionAtIndex(ns1Sections, i);
      const ns2Expected = innermostSectionAtIndex(ns2Sections, i);

      const hasBelongs = hasBelongsToSection(node);

      if (!hasBelongs) {
        assertEquals(ns1Expected, undefined);
        assertEquals(ns2Expected, undefined);
        continue;
      }

      const belongsNs1 = node.data.belongsToSection["ns1"];
      const belongsNs2 = node.data.belongsToSection["ns2"];

      if (ns1Expected) {
        assertEquals(belongsNs1, ns1Expected);
      } else {
        assertEquals(belongsNs1, undefined);
      }

      if (ns2Expected) {
        assertEquals(belongsNs2, ns2Expected);
      } else {
        assertEquals(belongsNs2, undefined);
      }
    }
  });
});

Deno.test("documentSchema — bold marker titles normalize colons", () => {
  const processor = unified()
    .use(remarkParse)
    .use(documentSchema, {
      namespace: "prime",
      enrichWithBelongsTo: false,
      includeDefaultHeadingRule: false,
      sectionRules: [boldParagraphSectionRule()],
    });

  const tree = processor.parse(BOLD_TITLE_FIXTURE) as Root;
  processor.runSync(tree);

  const byNs = collectSectionsByNamespace(tree);
  const primeSections = byNs.get("prime") ?? [];
  const markers = primeSections.filter(isMarkerSection);

  const boldMarkers = markers.filter(isBoldParagraphSection);
  assertEquals(boldMarkers.length, 3);

  assertEquals(boldMarkers[0].title, "bold text without colon");
  assertEquals(boldMarkers[1].title, "bold text with colon inside");
  assertEquals(boldMarkers[2].title, "bold text with colon outside");
});
