import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  applyDiscoveredSchema,
  discoverSchema,
  lsSchema,
  parseOne,
} from "./folio.ts";

const FIXTURE_URL = new URL("./folio_test-fixture-01.md", import.meta.url);

Deno.test("fixture-01: parse and basic shape", async (t) => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const h = await parseOne("fixture-01", md);

  await t.step("has headings and leaves", () => {
    assert(h.headings().length > 0, "no headings detected");
    assert(h.leaves().length > 0, "no terminal leaves detected");
  });

  await t.step("leaf count equals number of case headings", () => {
    // In fixture-01 there are 9 case-level leaves (h4).
    assertEquals(h.leaves().length, 9);
  });

  await t.step("each leaf has a sensible range and trail", () => {
    for (const leaf of h.leaves()) {
      assert(leaf.heading.startLine >= 0);
      assert(leaf.heading.endLine >= leaf.heading.startLine);
      // trail depths must be strictly increasing and shallower than leaf
      let prev = 0 as number;
      for (const anc of leaf.trail) {
        assert(anc.depth < leaf.heading.depth);
        assert(anc.depth > prev);
        prev = anc.depth;
      }
    }
  });
});

Deno.test("fixture-01: schema-later projection & grouping", async (t) => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const h = await parseOne("fixture-01", md);

  const v = h.withSchema(
    {
      h1: "project",
      h2: "suite",
      h3: "plan",
      h4: "case",
    } as const,
  );

  await t.step("atRole('case') returns all 9 cases", () => {
    assertEquals(v.atRole("case").length, 9);
  });

  await t.step("roles are projected correctly for a known case", () => {
    const anyCase = v.atRole("case")[0];
    assert(
      anyCase.roles.project && anyCase.roles.suite && anyCase.roles.plan &&
        anyCase.roles.case,
    );
    // leaf heading depth should match deepest role depth (h4)
    assertEquals(anyCase.leaf.heading.depth, 4);
  });

  await t.step("groupBy('suite') has expected suite buckets and sizes", () => {
    const grouped = v.groupBy("suite");
    const suites = Array.from(grouped.keys());
    // expected suite names as written in fixture-01
    assert(suites.includes("Accounts & Auth E2E Suite"));
    assert(suites.includes("Checkout E2E Suite"));
    assert(suites.includes("Notifications & Integrations E2E Suite"));
    assert(suites.includes("Operational Observability E2E Suite"));

    assertEquals(grouped.get("Accounts & Auth E2E Suite")?.length ?? 0, 3);
    assertEquals(grouped.get("Checkout E2E Suite")?.length ?? 0, 3);
    assertEquals(
      grouped.get("Notifications & Integrations E2E Suite")?.length ?? 0,
      2,
    );
    assertEquals(
      grouped.get("Operational Observability E2E Suite")?.length ?? 0,
      1,
    );
  });
});

Deno.test("fixture-01: annotations across hierarchy", async (t) => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const h = await parseOne("fixture-01", md);

  await t.step("plan-level @id appears on headings but not on leaves", () => {
    const planHeadings = h.findHeadingsByAnnotation("id", "acct-create-plan");
    const planLeaves = h.findLeavesByAnnotation("id", "acct-create-plan");
    assertEquals(planHeadings.length, 1);
    assertEquals(planLeaves.length, 0);
  });

  await t.step("case-level @id appears on the leaf (and its heading)", () => {
    const caseLeaves = h.findLeavesByAnnotation(
      "id",
      "acct-signup-verify-case",
    );
    const caseHeadings = h.findHeadingsByAnnotation(
      "id",
      "acct-signup-verify-case",
    );
    assertEquals(caseLeaves.length, 1);
    assertEquals(caseHeadings.length, 1);
  });

  await t.step(
    "non-leaf annotation example: @objective on a plan heading",
    () => {
      const objs = h.findHeadingsByAnnotation("objective");
      assert(objs.length >= 1);
      const hasGolden = objs.some((hh) =>
        typeof hh.annotations["objective"] === "string" &&
        hh.annotations["objective"].toLowerCase().includes("golden path")
      );
      assert(hasGolden, "expected a plan-level @objective annotation");
    },
  );

  await t.step("annotations do not implicitly inherit to children", () => {
    const wrong = h.findLeavesByAnnotation("id", "acct-create-plan");
    assertEquals(wrong.length, 0);
  });
});

Deno.test("fixture-01: code cells at multiple levels", async (t) => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const h = await parseOne("fixture-01", md);

  await t.step(
    "plan-level YAML code blocks are discoverable in self scope",
    () => {
      // We expect at least two plan-level YAML blocks (two plans in the fixture).
      const plansYaml = h.findCodeInHeadings({
        lang: "yaml",
        depth: 3,
        scope: "self",
      });
      assert(plansYaml.length >= 2);
      // One of them should include "owner:" and "objective:"
      const hasOwnerObjective = plansYaml.some((cb) =>
        cb.value.includes("owner:") && cb.value.includes("objective:")
      );
      assert(
        hasOwnerObjective,
        "expected plan-level YAML with owner/objective",
      );
    },
  );

  await t.step("case-level YAML code blocks exist where defined", () => {
    // There are case-level YAML blocks (e.g., lockout case, guest checkout case).
    const casesYaml = h.findCodeInHeadings({
      lang: "yaml",
      depth: 4,
      scope: "self",
    });
    assert(casesYaml.length >= 2);
    // At least one should include severity/env; another might include issue/notes.
    const hasSeverityEnv = casesYaml.some((cb) =>
      cb.value.includes("severity:") && cb.value.includes("env:")
    );
    const hasIssueNotes = casesYaml.some((cb) =>
      cb.value.includes("issue:") || cb.value.includes("notes:")
    );
    assert(hasSeverityEnv, "expected a case-level YAML with severity/env");
    assert(hasIssueNotes, "expected a case-level YAML with issue/notes");
  });

  await t.step("JSON5 code blocks are captured and typed", () => {
    // The fixture contains a JSON5 block under a case.
    const json5Blocks = h.findCodeInHeadings({
      lang: "json5",
      depth: 4,
      scope: "self",
    });
    assert(json5Blocks.length >= 1);
    const hasLinkedIssues = json5Blocks.some((cb) =>
      cb.value.includes(`"linked_issues"`) || cb.value.includes("linked_issues")
    );
    assert(hasLinkedIssues, "expected json5 code with linked_issues");
  });

  await t.step("section-scope includes descendant code when present", () => {
    // Choose an h2 suite and confirm that searching in 'section' scope
    // returns more/equal code blocks than its self-only content.
    const suiteSelf = h.findCodeInHeadings({ depth: 2, scope: "self" });
    const suiteSection = h.findCodeInHeadings({ depth: 2, scope: "section" });
    assert(suiteSection.length >= suiteSelf.length);
  });
});

Deno.test("fixture-01: leaf mdast and GFM tasks", async (t) => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const h = await parseOne("fixture-01", md);

  const v = h.withSchema(
    {
      h1: "project",
      h2: "suite",
      h3: "plan",
      h4: "case",
    } as const,
  );

  // Pick a well-known case: "New user can sign up and verify email"
  const signupCase = v.atRole("case").find(
    (x) => x.leaf.heading.text.toLowerCase().includes("new user can sign"),
  );
  assert(signupCase, "expected to find the signup+verify case");

  await t.step("leaf carries mdast nodes and a root", () => {
    const leaf = signupCase!.leaf;
    assert(Array.isArray(leaf.nodes), "leaf.nodes should be an array");
    assert(leaf.nodes.length >= 1, "leaf.nodes should not be empty");
    assert(leaf.root && leaf.root.type === "root", "leaf.root should exist");
  });

  await t.step("extracts GFM tasks from leaf content", () => {
    const leaf = signupCase!.leaf;
    // This case has several Steps and Expected checkboxes; ensure we captured some.
    assert(leaf.tasks.length >= 5, "expected at least 5 GFM task items");
    // Ensure tasks carry checked state and text
    const anyChecked = leaf.tasks.some((ti) => ti.checked === true);
    const anyUnchecked = leaf.tasks.some((ti) => ti.checked === false);
    assert(anyChecked, "expected at least one checked task");
    // Some leaves include unchecked expectations or steps in the fixture
    assert(
      anyUnchecked || leaf.tasks.length > 5,
      "expected at least one unchecked or many tasks",
    );
  });

  await t.step("task line numbers are reasonable", () => {
    const leaf = signupCase!.leaf;
    for (const ti of leaf.tasks) {
      assert(ti.startLine >= leaf.heading.startLine, "task before leaf start");
      assert(ti.endLine <= leaf.heading.endLine, "task after leaf end");
      assert(ti.text.length > 0, "task text should not be empty");
    }
  });
});

/**
 * These tests serve as live documentation:
 * - The parser is schema-free and detects *leaves* as the deepest headings.
 * - You can apply *any* role mapping at query time with withSchema(... as const).
 * - Works with shallow docs (just a case) and deep docs (project→suite→plan→case).
 */

/* -------------------------------------------------------------------------- */
/* Sample A: "Just a Case" (single heading level with steps)                  */
/* -------------------------------------------------------------------------- */

const SIMPLE_CASE_MD = String.raw`
# Reset password works

User can request password reset and complete flow.

**Steps**
- [ ] Open "Forgot Password"
- [ ] Submit email
- [x] Receive reset email
- [ ] Set a new password

**Expected**
- [x] Confirmation screen
- [ ] Login with new password succeeds
`;

Deno.test("doc-samples: A) Just a Case (deepest = h1)", async (t) => {
  const h = await parseOne("sample-A", SIMPLE_CASE_MD);

  await t.step("auto-detects a single leaf", () => {
    assertEquals(h.leaves().length, 1);
    assertEquals(h.leaves()[0].heading.text, "Reset password works");
    // h1 is deepest here, so it is the leaf
    assertEquals(h.leaves()[0].heading.depth, 1);
  });

  await t.step("schema can treat h1 as 'case'", () => {
    const v = h.withSchema({ h1: "case" } as const);
    assertEquals(v.atRole("case").length, 1);
    assertEquals(v.atRole("case")[0].roles.case, "Reset password works");
  });

  await t.step("GFM tasks captured in leaf", () => {
    const leaf = h.leaves()[0];
    assert(leaf.tasks.length >= 4, "expected several task items");
    const checked = leaf.tasks.filter((ti) => ti.checked === true).length;
    const unchecked = leaf.tasks.filter((ti) => ti.checked === false).length;
    assert(
      checked >= 1 && unchecked >= 1,
      "expect some checked and some unchecked",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Sample B: "Suite with Cases" (h1=h1 suite, h2 cases)                       */
/* -------------------------------------------------------------------------- */

const SUITE_CASES_MD = String.raw`
# Authentication Suite

High-level tests around sign-in/out.

## Valid login
**Steps**
- [ ] Enter valid credentials
- [x] Submit

**Expected**
- [ ] Redirect to dashboard

## Logout
**Steps**
- [ ] Click profile menu
- [ ] Click "Sign out"

**Expected**
- [ ] Return to sign-in
`;

Deno.test("doc-samples: B) Suite (h1) with two Cases (h2)", async (t) => {
  const h = await parseOne("sample-B", SUITE_CASES_MD);

  await t.step("deepest headings (h2) are leaves", () => {
    assertEquals(h.leaves().length, 2);
    assertEquals(h.leaves()[0].heading.depth, 2);
    assertEquals(h.leaves()[1].heading.depth, 2);
  });

  await t.step("schema: h1 as suite, h2 as case", () => {
    const v = h.withSchema({ h1: "suite", h2: "case" } as const);
    assertEquals(v.atRole("case").length, 2);
    const grouped = v.groupBy("suite");
    assertEquals(grouped.size, 1);
    assertEquals(grouped.get("Authentication Suite")?.length ?? 0, 2);
  });

  await t.step(
    "alternately: treat h2 as *plan* (different semantics, same parse)",
    () => {
      const v = h.withSchema({ h1: "suite", h2: "plan" } as const);
      assertEquals(v.atRole("plan").length, 2);
      assert(v.atRole("plan")[0].roles.suite === "Authentication Suite");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Smart schema discovery (terminal-first) — executable docs                   */
/* -------------------------------------------------------------------------- */

const SCH = {
  h1: "project",
  h2: "strategy",
  h3: "plan",
  h4: "suite",
  h5: "case",
  // (steps implied; not a heading)
} as const;

/** A) One depth only → treat as terminal ("case"). */
const ONE_LEVEL_MD = String.raw`
## Single Thing To Test

**Steps**
- [ ] do a
- [x] do b
`;

/** B) Two depths → last two roles ("suite" → "case"). */
const TWO_LEVELS_MD = String.raw`
# Auth Suite

## Valid login
- [ ] enter creds
- [x] submit
`;

/** C) Three depths, irregular (h1, h3, h4) → last three roles ("plan","suite","case"). */
const THREE_LEVELS_IRREGULAR_MD = String.raw`
# Root Heading (intro)

Some intro text only.

### Plan: Account Creation
- [ ] story

#### Case: New signup
- [ ] fill form
- [x] confirm
`;

/** D) Stray headings not in any leaf path are ignored for structure. */
const WITH_STRAYS_MD = String.raw`
# Top Project

## Stray H2 (no children)

### Real Plan
- [ ] something

#### Real Case
- [x] inner
`;

Deno.test("schema discovery: A) one depth → terminal only ('case')", async (t) => {
  const h = await parseOne("A", ONE_LEVEL_MD);
  const d = discoverSchema(h, SCH);

  await t.step("depths & structural", () => {
    assertEquals(d.leafDepths, [2]);
    assertEquals(d.structuralDepths, [2]);
  });

  await t.step("recommended mapping", () => {
    // One depth present → map to the last role: "case"
    assertEquals(d.recommended.availableRoles, ["case"]);
    assertEquals(d.recommended.missingRoles, [
      "project",
      "strategy",
      "plan",
      "suite",
    ]);
    assertEquals(d.recommended.depthToRole["h2"], "case");
    assertEquals(d.recommended.roleToDepth["case"], 2);
    assertEquals(d.recommended.terminalRole, "case");
  });

  await t.step("applyDiscoveredSchema projection", () => {
    const { view } = applyDiscoveredSchema(h, SCH);
    // All leaves should be at terminal role "case"
    assertEquals(view.atRole("case").length, h.leaves().length);
  });
});

Deno.test("schema discovery: B) two depths → 'suite' → 'case'", async (t) => {
  const h = await parseOne("B", TWO_LEVELS_MD);
  const d = discoverSchema(h, SCH);

  await t.step("depths & structural", () => {
    assertEquals(d.structuralDepths, [1, 2]); // h1 suite ancestor, h2 case leaves
    assertEquals(d.leafDepths, [2]);
  });

  await t.step("recommended mapping", () => {
    // Two depths → map to last two roles: "suite","case"
    assertEquals(d.recommended.availableRoles, ["suite", "case"]);
    assertEquals(d.recommended.missingRoles, ["project", "strategy", "plan"]);
    assertEquals(d.recommended.depthToRole["h1"], "suite");
    assertEquals(d.recommended.depthToRole["h2"], "case");
    assertEquals(d.recommended.terminalRole, "case");
  });

  await t.step("applyDiscoveredSchema projection", () => {
    const { view } = applyDiscoveredSchema(h, SCH);
    const grouped = view.groupBy("suite");
    assertEquals(grouped.get("Auth Suite")?.length ?? 0, 1);
    assertEquals(view.atRole("case").length, 1);
  });
});

Deno.test("schema discovery: C) three depths irregular → last three ('plan','suite','case')", async (t) => {
  const h = await parseOne("C", THREE_LEVELS_IRREGULAR_MD);
  const d = discoverSchema(h, SCH);

  await t.step("depths & structural", () => {
    // structural depths = ancestor + leaf depths only (h1, h3, h4)
    assertEquals(d.structuralDepths, [1, 3, 4]);
    assertEquals(d.leafDepths, [4]);
  });

  await t.step("recommended mapping order", () => {
    // We align the LAST 3 roles to these depths shallow→deep:
    // depths [1,3,4] → roles ["plan","suite","case"]
    assertEquals(d.recommended.availableRoles, ["plan", "suite", "case"]);
    assertEquals(d.recommended.depthToRole["h1"], "plan");
    assertEquals(d.recommended.depthToRole["h3"], "suite");
    assertEquals(d.recommended.depthToRole["h4"], "case");
    assertEquals(d.recommended.terminalRole, "case");
  });

  await t.step("applyDiscoveredSchema projection", () => {
    const { view } = applyDiscoveredSchema(h, SCH);
    // Deepest role is "case" at h4
    assertEquals(view.atRole("case").length, 1);
    // Group by "plan" which was assigned to h1
    const byPlan = view.groupBy("plan");
    assertEquals(byPlan.size, 1);
    assertEquals(byPlan.get("Root Heading (intro)")?.length ?? 0, 1);
  });
});

Deno.test("schema discovery: D) stray headings are ignored for structure", async (t) => {
  const h = await parseOne("D", WITH_STRAYS_MD);
  const d = discoverSchema(h, SCH);

  await t.step("depths & structural", () => {
    // Stray H2 has no descendant leaf; structural depths should be [1,3,4]
    assertEquals(d.structuralDepths, [1, 3, 4]);
    assertEquals(d.leafDepths, [4]);
  });

  await t.step("recommended & apply", () => {
    assertEquals(d.recommended.availableRoles, ["plan", "suite", "case"]);
    const { view } = applyDiscoveredSchema(h, SCH);
    assertEquals(view.atRole("case").length, 1);
  });
});

Deno.test("lsSchema (explicit schema): deterministic structure for fixture-01", async () => {
  const md = await Deno.readTextFile(FIXTURE_URL);
  const folio = await parseOne("fixture-01", md);

  // Use the explicit schema implied by the fixture:
  const view = folio.withSchema(
    {
      h1: "project",
      h2: "suite",
      h3: "plan",
      h4: "case",
    } as const,
  );

  const rows = lsSchema(folio, view);

  // Deterministic expected (natural Markdown order)
  const expected = [
    { HL: 1, Nature: "Project", Title: "E2E1 End-to-End Qualityfolio" },

    { HL: 2, Nature: "Suite", Title: "Accounts & Auth E2E Suite" },
    { HL: 3, Nature: "Plan", Title: "E2E Account Creation Plan" },
    { HL: 4, Nature: "Case", Title: "New user can sign up and verify email" },
    { HL: 4, Nature: "Case", Title: "Returning user can login with MFA" },
    { HL: 3, Nature: "Plan", Title: "Password Recovery Plan" },
    { HL: 4, Nature: "Case", Title: "Lockout after repeated failures" },

    { HL: 2, Nature: "Suite", Title: "Checkout E2E Suite" },
    { HL: 3, Nature: "Plan", Title: "E2E Happy Path Checkout Plan" },
    {
      HL: 4,
      Nature: "Case",
      Title: "Signed-in user can complete checkout with saved card",
    },
    {
      HL: 4,
      Nature: "Case",
      Title: "Guest user can checkout with credit card",
    },
    { HL: 3, Nature: "Plan", Title: "E2E Edge Cases & Resilience Plan" },
    {
      HL: 4,
      Nature: "Case",
      Title: "Payment gateway transient failure triggers retry",
    },

    { HL: 2, Nature: "Suite", Title: "Notifications & Integrations E2E Suite" },
    { HL: 3, Nature: "Plan", Title: "E2E Notifications Plan" },
    { HL: 4, Nature: "Case", Title: "Confirmation email sent to customer" },
    {
      HL: 4,
      Nature: "Case",
      Title: "Webhook is delivered to partner system exactly once",
    },

    { HL: 2, Nature: "Suite", Title: "Operational Observability E2E Suite" },
    { HL: 3, Nature: "Plan", Title: "E2E Latency & Error Budget Plan" },
    { HL: 4, Nature: "Case", Title: "Golden path latency under 3s P95" },
  ] as const;

  assertEquals(rows, expected);
});
