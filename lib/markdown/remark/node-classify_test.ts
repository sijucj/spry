import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1";
import type {
  Code,
  Heading,
  Paragraph,
  Root,
  RootContent,
} from "npm:@types/mdast@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import { remark } from "npm:remark@^15";

import {
  catalogToRootData,
  type ClassifierCatalog,
  classifiersFromFrontmatter,
  hasNodeClass,
  nodeClassifier,
  type NodeClassifierRule,
} from "./node-classify.ts";
import { documentFrontmatter } from "./doc-frontmatter.ts";

/**
 * Helper: parse markdown into an mdast Root using the full pipeline:
 * - remark-frontmatter (extract yaml node)
 * - documentFrontmatter (parse YAML → documentFrontmatter)
 * - nodeClassifier (apply classifications)
 */
async function parseMarkdown(
  md: string,
  options: Parameters<typeof nodeClassifier>[0],
): Promise<Root> {
  const processor = remark()
    .use(remarkFrontmatter, ["yaml"])
    .use(documentFrontmatter)
    .use(nodeClassifier, options as never);

  const tree = processor.parse(md) as Root;
  await processor.run(tree);
  return tree;
}

const SAMPLE_MD = `
# Title

Intro paragraph

## Section A

Paragraph A1

\`\`\`sql
select 1;
\`\`\`

## Section B

Paragraph B1

### Subsection B1

Paragraph B1.1
`.trim() + "\n";

const FRONTMATTER_MD = `
---
doc-classify:
  - select: h1
    role: project
  - select: h2
    role: test-strategy
  - select: h3
    role: test-plan
  - select: h4
    role: test-case
---
# Project Title
## Strategy Heading
### Plan Heading
#### Case Heading
`.trim() + "\n";

Deno.test("nodeClassifier remark plugin", async (t) => {
  await t.step(
    "classifies nodes and builds catalog via callback stored on root.data",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          // Mark the main title
          {
            mdastSelectors: ["h1"],
            classify: (nodes) => {
              assertEquals(nodes.length, 1);
              return { key: "role", value: "title" };
            },
          },
          // Mark all h2 headings as sections
          {
            mdastSelectors: ["h2"],
            classify: () => ({ key: "role", value: "section" }),
          },
          // Mark all paragraphs as "body"
          {
            mdastSelectors: ["paragraph"],
            classify: (nodes) =>
              nodes.length > 0 ? { key: "kind", value: "body" } : false,
          },
          // Mark SQL code blocks with two tags to exercise array merging
          {
            mdastSelectors: ["code[lang=sql]"],
            classify: () => ({ key: "tag", value: ["sql", "example"] }),
          },
          // Second classifier for the same SQL code on the same key (merge)
          {
            mdastSelectors: ["code[lang=sql]"],
            classify: () => ({ key: "tag", value: "snippet" }),
          },
        ],
        // store the catalog on root.data.classifierCatalog like the old behavior.
        catalog: (catalog, root) => {
          catalogSeen = catalog;

          const anyRoot = root as Root & {
            data?: Record<string, unknown> & {
              classifierCatalog?: ClassifierCatalog;
            };
          };
          if (!anyRoot.data) anyRoot.data = {};
          anyRoot.data.classifierCatalog = catalog;
        },
      });

      const children = root.children;

      const h1 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 1,
      );
      const pIntro = children.find(
        (n): n is Paragraph => n.type === "paragraph",
      );
      const h2A = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 2,
      );
      const sqlCode = children.find(
        (n): n is Code => n.type === "code" && (n as Code).lang === "sql",
      );

      assert(h1);
      assertEquals(h1.type, "heading");
      assertEquals(h1.depth, 1);

      assert(pIntro);
      assertEquals(pIntro.type, "paragraph");

      assert(h2A);
      assertEquals(h2A.type, "heading");
      assertEquals(h2A.depth, 2);

      assert(sqlCode);
      assertEquals(sqlCode.type, "code");
      assertEquals(sqlCode.lang, "sql");

      // h1 classification
      assert(hasNodeClass(h1));
      assertEquals(h1.data!.class["role"], "title");

      // h2 classification
      assert(hasNodeClass(h2A));
      assertEquals(h2A.data!.class["role"], "section");

      // paragraph classification (at least intro paragraph)
      assert(hasNodeClass(pIntro));
      assertEquals(pIntro.data!.class["kind"], "body");

      // SQL code: ensure merging of multiple classifications on same key
      assert(hasNodeClass(sqlCode));
      const tagValue = sqlCode.data!.class["tag"];
      assert(Array.isArray(tagValue));
      const sorted = [...tagValue].sort();
      assertEquals(sorted, ["example", "snippet", "sql"].sort());

      // Catalog callback should have received a populated catalog.
      assert(catalogSeen);
      const catalog = catalogSeen!;

      // And we also stored it on root.data.classifierCatalog via the callback.
      const anyRoot = root as Root & {
        data?: {
          classifierCatalog?: ClassifierCatalog;
        };
      };
      assert(anyRoot.data && anyRoot.data.classifierCatalog);
      const storedCatalog = anyRoot.data.classifierCatalog!;
      assertEquals(storedCatalog, catalog);

      // Catalog should include entries for role + kind + tag
      assert("role" in catalog);
      assert("kind" in catalog);
      assert("tag" in catalog);

      // Verify that catalog.role.title contains the h1
      const roleTitle = catalog.role["title"] ?? [];
      assert(roleTitle.length >= 1);
      assert(roleTitle.includes(h1));

      // Verify that catalog.role.section contains at least one h2
      const roleSection = catalog.role["section"] ?? [];
      assert(roleSection.length >= 1);
      assert(roleSection.includes(h2A));

      // Verify that catalog.tag has "sql", "example", "snippet"
      const tagSql = catalog.tag["sql"] ?? [];
      const tagExample = catalog.tag["example"] ?? [];
      const tagSnippet = catalog.tag["snippet"] ?? [];
      assert(tagSql.includes(sqlCode));
      assert(tagExample.includes(sqlCode));
      assert(tagSnippet.includes(sqlCode));
    },
  );

  await t.step(
    "does not create or store catalog when catalog callback is omitted",
    async () => {
      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            mdastSelectors: ["h1"],
            classify: () => ({ key: "role", value: "title" }),
          },
        ],
        // no catalog callback
      });

      const h1 = root.children[0] as RootContent;
      assert(h1.type === "heading");

      // Node still gets classification
      assert(hasNodeClass(h1));
      assertEquals(h1.data.class["role"], "title");

      // But root has no classifierCatalog (we never set it)
      const anyRoot = root as Root & { data?: Record<string, unknown> };
      assertFalse(
        !!anyRoot.data && "classifierCatalog" in (anyRoot.data as Record<
              string,
              unknown
            >),
      );
    },
  );

  await t.step(
    "catalog callback is invoked with empty catalog when there are no classifiers",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [], // no rules
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      // Root should be untouched except for normal remark behavior.
      assert(root.children.length > 0);

      // We still build an empty catalog and invoke the callback.
      assert(catalogSeen);
      assertEquals(Object.keys(catalogSeen!).length, 0);
    },
  );

  await t.step(
    "catalog callback receives empty catalog when classifier returns false",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            mdastSelectors: ["paragraph"],
            classify: (nodes) => {
              // simulate early exit: skip applying any class
              if (nodes.length > 0) return false;
              return { key: "kind", value: "body" };
            },
          },
        ],
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      // We know SAMPLE_MD has paragraphs, but our classifier returned false.
      // So no paragraph should have a class map.
      const paragraphs = root.children.filter(
        (n) => n.type === "paragraph",
      ) as RootContent[];

      assert(paragraphs.length > 0);
      for (const p of paragraphs) {
        assertFalse(hasNodeClass(p));
      }

      // Catalog callback should have been invoked with an empty catalog.
      assert(catalogSeen);
      assertEquals(Object.keys(catalogSeen!).length, 0);
    },
  );

  await t.step(
    "hasNodeClass returns false for unclassified nodes",
    async () => {
      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            mdastSelectors: ["h1"],
            classify: () => ({ key: "role", value: "title" }),
          },
        ],
        // no catalog needed here
      });

      const h1 = root.children[0] as RootContent;
      const someParagraph = root.children.find(
        (n) => n.type === "paragraph",
      ) as RootContent | undefined;

      assert(h1.type === "heading");
      assert(someParagraph && someParagraph.type === "paragraph");

      assert(hasNodeClass(h1)); // classified
      assertFalse(hasNodeClass(someParagraph)); // not classified
    },
  );

  await t.step(
    "supports generator-based classifiers (Iterable, not just arrays)",
    async () => {
      function* generatorClassifiers(
        _root: Root,
      ): IterableIterator<NodeClassifierRule> {
        // yield one simple rule for h1
        yield {
          mdastSelectors: ["h1"],
          classify: (nodes) => ({
            key: "role",
            value: nodes.length === 1 ? "title" : "heading",
          }),
        };
      }

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (root: Root) => generatorClassifiers(root),
        catalog: catalogToRootData("classifierCatalogViaHelper"),
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as RootContent | undefined;

      assert(h1);
      assert(hasNodeClass(h1));
      assertEquals(h1.data.class["role"], "title");

      // Using catalogToRootData helper, catalog is stored on root.data
      const anyRoot = root as Root & {
        data?: {
          classifierCatalogViaHelper?: ClassifierCatalog;
        };
      };
      const catalog = anyRoot.data?.classifierCatalogViaHelper;
      assert(catalog);

      // Catalog should reflect the generator rule
      const titles = catalog!.role?.["title"] ?? [];
      assert(titles.includes(h1));
    },
  );

  await t.step(
    "classify can return an Iterator to apply multiple classifications",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            mdastSelectors: ["h1"],
            classify: (_nodes) => {
              // Multiple class entries for the same selection
              function* entries() {
                yield { key: "role", value: "title" as const };
                yield { key: "kind", value: "heading" as const };
              }
              return entries();
            },
          },
        ],
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as RootContent | undefined;

      assert(h1);
      assert(hasNodeClass(h1));

      // Both classifications from the iterator should be present
      assertEquals(h1.data.class["role"], "title");
      assertEquals(h1.data.class["kind"], "heading");

      // Catalog should have both keys and include the h1 under both.
      assert(catalogSeen);
      const catalog = catalogSeen!;
      const roleTitle = catalog.role?.["title"] ?? [];
      const kindHeading = catalog.kind?.["heading"] ?? [];
      assert(roleTitle.includes(h1));
      assert(kindHeading.includes(h1));
    },
  );

  await t.step(
    "builds classifiers from document frontmatter DSL via classifiersFromFrontmatter",
    async () => {
      const root = await parseMarkdown(FRONTMATTER_MD, {
        classifiers: classifiersFromFrontmatter(), // default key = "doc-classify"
        catalog: catalogToRootData("classifierCatalogFromFM"),
      });

      const children = root.children;

      const h1 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 1,
      );
      const h2 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 2,
      );
      const h3 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 3,
      );
      const h4 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 4,
      );

      assert(h1 && h2 && h3 && h4);

      assert(hasNodeClass(h1));
      assertEquals(h1.data.class["role"], "project");

      assert(hasNodeClass(h2));
      assertEquals(h2.data.class["role"], "test-strategy");

      assert(hasNodeClass(h3));
      assertEquals(h3.data.class["role"], "test-plan");

      assert(hasNodeClass(h4));
      assertEquals(h4.data.class["role"], "test-case");

      // Catalog should show all these roles too via catalogToRootData
      const anyRoot = root as Root & {
        data?: { classifierCatalogFromFM?: ClassifierCatalog };
      };
      const catalog = anyRoot.data?.classifierCatalogFromFM;
      assert(catalog);

      const proj = catalog.role?.["project"] ?? [];
      const strat = catalog.role?.["test-strategy"] ?? [];
      const plan = catalog.role?.["test-plan"] ?? [];
      const tcase = catalog.role?.["test-case"] ?? [];

      assert(proj.includes(h1));
      assert(strat.includes(h2));
      assert(plan.includes(h3));
      assert(tcase.includes(h4));
    },
  );
});
