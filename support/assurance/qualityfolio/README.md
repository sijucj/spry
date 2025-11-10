# Qualityfolio.md — Flexible Authoring Guide (works with `folio.ts`)

> Goal: Author plain, human-friendly Markdown for tests that can be parsed into
> structure later.\
> Principle: All headings are optional — use as few or as many levels as you
> need. The parser (`folio.ts`) is schema-free at parse time and schema-driven
> at query time.

## TL;DR

- Write Markdown the way you naturally would.
- Use headings to _suggest_ structure, but none are required.
- Use simple annotations (`@key value`) and fenced code blocks (YAML/JSON) for
  metadata anywhere.
- Use GFM tasks (`- [ ]`, `- [x]`) for steps and expectations.
- When querying/visualizing, apply a schema mapping depth→role (e.g.,
  `{ h1: "project", h2: "suite", h3: "plan", h4: "case" }`) or auto-discover it.

## Why headings are optional

Teams start simple and grow complexity over time. `folio.ts` supports all of
these equally:

| Project size | Typical content you write                                   | Example mapping (later at query time)                                    |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tiny         | Just cases with steps                                       | `{ h1: "case" }`                                                         |
| Small        | suite → case or plan → case                                 | `{ h1: "suite", h2: "case" }` or `{ h1: "plan", h2: "case" }`            |
| Medium       | project → suite → plan → case (+ steps/evidence)            | `{ h1: "project", h2: "suite", h3: "plan", h4: "case" }`                 |
| Large        | project → strategy → suite → plan → case (+ steps/evidence) | `{ h1: "project", h2: "strategy", h3: "suite", h4: "plan", h5: "case" }` |

> You decide the depth; `folio.ts` will parse headings, but role names are only
> applied later.

## Authoring patterns (pick one, mix & match later)

### 1) Minimal (only cases + steps)

```md
# Reset password works

Short narrative of the scenario.

Steps

- [ ] Open "Forgot Password"
- [ ] Submit email
- [x] Receive reset email
- [ ] Set a new password

Expected

- [x] Confirmation screen
- [ ] Login with new password succeeds
```

> Parse-time: only one heading. Query-time: map `{ h1: "case" }`.

### 2) Medium (suite → case)

```md
# Authentication Suite

## Valid login

Steps

- [ ] Enter valid credentials
- [x] Submit

Expected

- [ ] Redirect to dashboard

## Logout

Steps

- [ ] Click profile menu
- [ ] Click "Sign out"

Expected

- [ ] Return to sign-in
```

> Query-time mapping: `{ h1: "suite", h2: "case" }` or
> `{ h1: "plan", h2: "case" }` — your choice.

### 3) Full (project → suite → plan → case)

````md
# E2E Project Alpha

## Accounts & Auth Suite

### Account Creation Plan

@id acct-create-plan

```yaml
owner: riya@example.org
objective: Sign-up → login → profile bootstrap
```

#### New user can sign up and verify email

@id acct-signup-verify-case

Preconditions

- Mail sandbox configured in QA

Steps

- [x] Open `/signup`
- [x] Submit
- [x] Receive verification email
- [x] Click verification link
- [x] Login

Expected

- [x] User marked verified
- [x] Login succeeds

Evidence

- [Run log](./evidence/signup-run.md)
- [Verification email JSON](./evidence/signup-email.json)
````

> Query-time mapping commonly used for this depth:
> `{ h1: "project", h2: "suite", h3: "plan", h4: "case" }`.

## Metadata: annotations & code blocks

- Annotations: any line like `@key value` in a heading’s _own section_ (before
  child headings).
- Fenced code blocks: use `yaml`, `json`, or `json5` for structured metadata;
  captured with line numbers.

Examples:

````md
@id acct-lockout-case @severity critical @component auth

```yaml
owner: riya@example.org
env: qa
objective: Lockout policy & reset email
```

```json5
{
  notes: "Payment sandbox intermittently 502s",
  linked_issues: ["CHECKOUT-231"]
}
```

> Annotations do not inherit to children — add where you want them to apply.

## Steps & expectations (GFM tasks)

Use checkboxes to make steps and expected results machine-readable:

```md
Steps

- [x] Navigate to `/login`
- [x] Enter valid credentials
- [x] Provide MFA code
- [x] Redirect to `/home`

Expected

- [x] Session cookie set
- [x] CSRF token present
- [x] Home shows display name
```
````

`folio.ts` extracts each item with `checked` state, the text, and precise line
numbers.

## Frontmatter (optional)

If you like, top-of-file YAML frontmatter is parsed:

```md
---
owner: qa@team.example
version: 1
envs: [dev, qa, prod]
tags: [regression, e2e]
---
```

Frontmatter errors are recorded as issues (warning), not fatal.

## How `folio.ts` parses & how you query

### Parse

```ts
import { parseOne } from "./folio.ts";
const f = await parseOne(
  "qualityfolio.md",
  await Deno.readTextFile("Qualityfolio.md"),
);
// f.headings(), f.leaves(), f.frontmatter(), f.issues()
```

### Apply roles later (choose a schema or discover it)

```ts
// Explicit schema (example): project → suite → plan → case
const view = f.withSchema(
  { h1: "project", h2: "suite", h3: "plan", h4: "case" } as const,
);
// Or discover & apply last-k roles from your desired schema:
import { applyDiscoveredSchema } from "./folio.ts";
const { discovery, view: v2 } = applyDiscoveredSchema(
  f,
  { h1: "project", h2: "suite", h3: "plan", h4: "case", h5: "step" } as const,
);

// Query
view.atRole("case"); // all terminal leaves mapped as "case"
view.groupBy("suite"); // Map<suiteTitle, case[]>
```

### Find tags or code blocks anywhere

```ts
f.findHeadingsByAnnotation("id", "acct-create-plan"); // plan heading by @id
f.findLeavesByAnnotation("severity", "critical"); // case leaves with severity
f.findCodeInHeadings({ lang: "yaml", depth: 3, scope: "self" }); // plan YAML
```

### Render a TOC-like list for your schema

```ts
import { lsSchema } from "./folio.ts";
console.table(lsSchema(f, view));
// HL | Nature  | Title
// 1  | Project | E2E Project Alpha
// 2  | Suite   | Accounts & Auth Suite
// 3  | Plan    | Account Creation Plan
// 4  | Case    | New user can sign up and verify email
```

> `lsSchema` walks headings in document order and prints the heading level (HL),
> schema role (“Nature”), and the heading title.

## File & folder naming (recommended, not required)

- Use lowercase with hyphens: `account-creation-plan.md`,
  `mobile-auth-login.case.md`.
- Keep evidence near the doc for easy links: `./evidence/...`.
- Typical repo layout (optional; use what fits your team):

```
qualityfolio/
├── project.md
├── suites/
│   └── authentication-suite.md
├── plans/
│   └── account-creation-plan.md
├── cases/
│   ├── login-success.case.md
│   └── login-lockout.case.md
└── evidence/
    ├── login-success-results.json
    └── login-lockout-screenshot.png
```

> Remember: the parser does not require any folder layout. This is just for DX.

## A tiny starter you can copy

````md
# <Your Project or Suite Title>

@id <optional-stable-id>

Context One or two sentences that explain scope.

Steps

- [ ] Do something the system should allow
- [ ] Do another thing

Expected

- [ ] Outcome that proves behavior
- [ ] Another observable result

Evidence

- [Run log](./evidence/run-2025-11-01.md)
- [Response JSON](./evidence/resp-2025-11-01.json)

```yaml
owner: you@example.org
severity: medium
env: qa
tags: [regression, e2e]
```
````

## Quality-of-life helper (optional): `qualityfolio.ts`

A small Deno-based CLI (similar to `spry.ts`) could scaffold Markdown:

- `init` presets: minimal, standard, compliance-heavy
- Scaffold case/suite/plan files with frontmatter & section stubs
- Normalize file/folder names
- Inject YAML/JSON metadata blocks

Concept:

```bash
deno run -A https://qualityfolio.dev/qualityfolio.ts init --preset minimal
deno run -A https://qualityfolio.dev/qualityfolio.ts new case "Login works"
deno run -A https://qualityfolio.dev/qualityfolio.ts new plan "Account Creation"
```

## Checklist for authors

- [ ] Use whatever heading depth you need (none are required).
- [ ] Prefer GFM tasks for steps & expected results.
- [ ] Add `@id`, `@severity`, `@component`, etc. where useful.
- [ ] Use fenced YAML/JSON for richer metadata.
- [ ] Link evidence files close to the doc.
- [ ] Let schemas or discovery decide roles later.

## Troubleshooting

- “My case isn’t detected” → a case must be a leaf heading (no deeper headings
  beneath it).
- “My annotations don’t show up” → ensure `@key value` is not inside a code
  block and is in the heading’s own section.
- “Discovery chose odd roles” → either add minimal content to meaningful
  ancestors (so they’re “significant”) or apply an explicit schema when
  querying.

## License

Your docs are yours. `folio.ts` is designed to read Markdown respectfully and
safely.
