// lib/markdown/remark/document-frontmatter_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1";
import type { Root, RootContent } from "npm:@types/mdast@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import { remark } from "npm:remark@^15";
import type { Plugin } from "npm:unified@^11";
import type { VFile } from "npm:vfile@^6";
import { z } from "npm:zod@^4";

import {
  documentFrontmatter,
  isRootWithDocumentFrontmatter,
  isYamlWithParsedFrontmatter,
} from "./doc-frontmatter.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function ensureRoot(tree: Root | undefined): Root {
  if (!tree) {
    throw new Error("Expected a Root tree but got undefined");
  }
  return tree;
}

function ensureFile(file: VFile | undefined): VFile {
  if (!file) {
    throw new Error("Expected a VFile but got undefined");
  }
  return file;
}

function findYamlNode(root: Root): Extract<RootContent, { type: "yaml" }> {
  const node = root.children.find(
    (n: RootContent): n is Extract<RootContent, { type: "yaml" }> =>
      n.type === "yaml",
  );
  if (!node) {
    throw new Error("Expected a yaml node in the tree");
  }
  return node;
}

Deno.test("documentFrontmatter basic behaviors...", async (t) => {
  let lastTree: Root | undefined;
  let lastFile: VFile | undefined;

  const capture: Plugin<[], Root> = () => (tree: Any, file: Any) => {
    lastTree = tree as Root;
    lastFile = file as VFile;
  };

  await t.step(
    "parses YAML and attaches parsedFM to yaml node, root, and file",
    async () => {
      lastTree = undefined;
      lastFile = undefined;

      const src = `---
title: Test Doc
tags:
  - a
  - b
count: 3
---

# Heading
`;

      const processor = remark()
        .use(remarkFrontmatter, ["yaml"])
        .use(documentFrontmatter as Any)
        .use(capture);

      await processor.process(src);

      const tree = ensureRoot(lastTree);
      const file = ensureFile(lastFile);

      const yamlNode = findYamlNode(tree);

      // Node-level parsedFM
      assert(
        isYamlWithParsedFrontmatter(yamlNode),
        "yaml node should have parsedFM attached",
      );

      const nodeFM = yamlNode.data.parsedFM.fm;
      assertEquals(nodeFM, {
        title: "Test Doc",
        tags: ["a", "b"],
        count: 3,
      });

      // Root-level documentFrontmatter
      assert(
        isRootWithDocumentFrontmatter(tree),
        "root should have documentFrontmatter",
      );

      const dfm = tree.data.documentFrontmatter;
      assertEquals(dfm.node, yamlNode);
      assertEquals(dfm.parsed.fm, nodeFM);

      // VFile-level frontmatter convenience
      const fdata = file.data as Record<string, unknown>;
      assert("frontmatter" in fdata, "file.data.frontmatter should exist");
      assertEquals(
        fdata.frontmatter,
        nodeFM,
        "file frontmatter should match parsed fm",
      );
    },
  );

  await t.step(
    "handles invalid YAML with empty fm",
    async () => {
      lastTree = undefined;
      lastFile = undefined;

      // Deliberately broken YAML
      const src = `---
: bad: [ this is not valid
---

# Bad
`;

      const processor = remark()
        .use(remarkFrontmatter, ["yaml"])
        .use(documentFrontmatter as Any)
        .use(capture);

      await processor.process(src);

      const tree = ensureRoot(lastTree);
      const file = ensureFile(lastFile);

      const yamlNode = findYamlNode(tree);

      assert(
        isYamlWithParsedFrontmatter(yamlNode),
        "yaml node should have parsedFM even when YAML is invalid",
      );

      const parsed = yamlNode.data.parsedFM;
      assertEquals(parsed.fm, {}, "fm should be empty object on parse failure");

      assert(
        isRootWithDocumentFrontmatter(tree),
        "root should still get documentFrontmatter",
      );

      assertEquals(tree.data.documentFrontmatter.parsed.fm, {});

      const fdata = file.data as Record<string, unknown>;
      assertEquals(
        fdata.frontmatter,
        {},
        "file frontmatter should be empty object when YAML is invalid",
      );
    },
  );

  await t.step(
    "applies optional Zod schema with safeParse and exposes zodParseResult",
    async () => {
      lastTree = undefined;
      lastFile = undefined;

      const src = `---
title: Zod Doc
count: 42
extra: "ignore me"
---

# Heading
`;

      const schema = z.object({
        title: z.string(),
        count: z.number().int(),
      });

      const processor = remark()
        .use(remarkFrontmatter, ["yaml"])
        // Cast to Any here to avoid unified's strict generics getting in the way
        .use(documentFrontmatter as Any, { schema })
        .use(capture);

      await processor.process(src);

      const tree = ensureRoot(lastTree);
      const file = ensureFile(lastFile);

      const yamlNode = findYamlNode(tree);

      assert(
        isYamlWithParsedFrontmatter<{
          title: string;
          count: number;
        }>(yamlNode),
        "yaml node should have typed parsedFM after schema",
      );

      const parsed = yamlNode.data.parsedFM;

      // fm should be the schema-shaped object (extra key dropped)
      assertEquals(parsed.fm, {
        title: "Zod Doc",
        count: 42,
      });

      // zodParseResult should definitely be present and successful
      assert(parsed.zodParseResult, "zodParseResult should be present");
      assert(
        parsed.zodParseResult!.success === true,
        "zodParseResult should indicate success",
      );

      // Root-level mirror of fm
      assert(
        isRootWithDocumentFrontmatter(tree),
        "root should have documentFrontmatter even with schema",
      );
      assertEquals(tree.data.documentFrontmatter.parsed.fm, {
        title: "Zod Doc",
        count: 42,
      });

      // VFile frontmatter == fm
      const fdata = file.data as Record<string, unknown>;
      assert("frontmatter" in fdata, "file.data.frontmatter should exist");
      assertEquals(
        fdata.frontmatter,
        {
          title: "Zod Doc",
          count: 42,
        },
        "file frontmatter should match fm (schema-shaped)",
      );
    },
  );
});
