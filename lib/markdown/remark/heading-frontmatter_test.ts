// lib/markdown/remark/heading-frontmatter_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1";
import type { Heading, Root, RootContent } from "npm:@types/mdast@^4";
import { remark } from "npm:remark@^15";

import {
  headingFrontmatter,
  type HeadingFrontmatterOptions,
  isHeadingWithFrontmatter,
} from "./heading-frontmatter.ts";

// Shared FM shape used in these tests
interface TestFrontmatter {
  parent?: boolean;
  child?: boolean;
  shared?: string;
  title?: string;
  tags?: string[];
  nested?: { value: number };
  foo?: string;
}

// Helper to parse + run the plugin and return the mutated AST
async function runWithPlugin(
  markdown: string,
  opts?: HeadingFrontmatterOptions,
): Promise<Root> {
  const processor = remark().use(headingFrontmatter, opts as never);
  const tree = processor.parse(markdown) as Root;
  const result = (await processor.run(tree)) as Root;
  return result;
}

Deno.test("headingFrontmatter basic behaviors", async (t) => {
  await t.step(
    "attaches local frontmatter and keeps code fence by default",
    async () => {
      const md = `
# Root Heading

\`\`\`yaml
# HFM
title: Root Title
tags:
  - a
  - b
nested:
  value: 1
\`\`\`

Some prose under root.
`;

      const tree = await runWithPlugin(md);
      const [h1, code, para] = tree.children;

      // Sanity: AST shape
      assert(h1 && h1.type === "heading");
      assert(code && code.type === "code");
      assert(para && para.type === "paragraph");

      // Use type guard to refine h1
      assert(
        isHeadingWithFrontmatter<TestFrontmatter, TestFrontmatter>(h1),
      );

      const local = h1.data.hFrontmatter;
      const inherited = h1.data.hFrontmatterInherited!;

      assertEquals(local, {
        title: "Root Title",
        tags: ["a", "b"],
        nested: { value: 1 },
      });

      // For top-level heading, inherited === local
      assertEquals(inherited, local);
    },
  );

  await t.step(
    "computes inherited frontmatter for nested headings with overrides",
    async () => {
      const md = `
# Parent

\`\`\`yaml
# HFM
parent: true
shared: parent
\`\`\`

## Child

\`\`\`yaml
# HFM
child: true
shared: child
\`\`\`

### Grandchild

Just some text.
`;

      const tree = await runWithPlugin(md);
      const children = tree.children;

      // Collect only headings that have their OWN frontmatter
      const headingsWithFm = children.filter((n): n is Heading & {
        data: {
          hFrontmatter: TestFrontmatter;
          hFrontmatterInherited?: TestFrontmatter;
        };
      } =>
        isHeadingWithFrontmatter<TestFrontmatter, TestFrontmatter>(
          n as RootContent,
        )
      );

      const h1 = headingsWithFm.find((h) => h.depth === 1)!;
      const h2 = headingsWithFm.find((h) => h.depth === 2)!;

      // Grandchild has no own frontmatter, so we still grab it the old way
      const h3 = children.find((n) =>
        n.type === "heading" && (n as Heading).depth === 3
      ) as Heading;

      // Parent: only its own frontmatter
      assertEquals(h1.data.hFrontmatter, {
        parent: true,
        shared: "parent",
      });
      assertEquals(h1.data.hFrontmatterInherited, h1.data.hFrontmatter);

      // Child: has its own local frontmatter plus inherited merge
      assertEquals(h2.data.hFrontmatter, {
        child: true,
        shared: "child",
      });

      assertEquals(h2.data.hFrontmatterInherited, {
        parent: true,
        // shared overridden by child
        shared: "child",
        child: true,
      });

      // Grandchild: no local frontmatter, but inherits child's merged object
      const d3 = h3.data as Record<string, unknown> | undefined;
      assertEquals(d3?.hFrontmatter, undefined);
      assertEquals(d3?.hFrontmatterInherited, h2.data.hFrontmatterInherited);
    },
  );

  await t.step(
    "optionally strips consumed frontmatter code fences from the AST",
    async () => {
      const md = `
## Section

\`\`\`yml
# META
foo: bar
\`\`\`

Paragraph text.
`;

      const tree = await runWithPlugin(md, {
        // Override to mark frontmatter blocks as "remove-before-consume"
        isFrontmatterCode(node: RootContent | undefined) {
          if (
            node &&
            node.type === "code" &&
            node.lang &&
            ["yaml", "yml", "json", "json5"].includes(
              node.lang.toLowerCase().trim(),
            ) &&
            typeof node.value === "string" &&
            node.value.includes("META")
          ) {
            return "remove-before-consume";
          }
          return false;
        },
      });

      const children = tree.children;

      // Expect only heading + paragraph (code removed)
      assertEquals(children.length, 2);
      assert(children[0].type === "heading");
      assert(children[1].type === "paragraph");

      const h2Node = children[0] as RootContent;

      // Use the type guard for this heading as well
      assert(
        isHeadingWithFrontmatter<TestFrontmatter, TestFrontmatter>(
          h2Node,
        ),
      );

      const h2 = h2Node; // now typed as Heading with frontmatter

      assertEquals(h2.data.hFrontmatter, { foo: "bar" });
      assertEquals(h2.data.hFrontmatterInherited, { foo: "bar" });
    },
  );
});
