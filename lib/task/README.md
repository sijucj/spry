# Spry Programmable Markdown for Task Orchestration

> Using Markdown as a programmable, type-safe command runner

Developers automate everyday tasks—formatting, building, testing,
releasing—using tools like `make`, `just`, `npm run`, or shell scripts. Each of
these introduces friction:

- Separate syntax and files (`Makefile`, `justfile`, `package.json` scripts).
- Weak typing—arguments are just strings.
- No unified place for code, documentation, and automation.

Spry changes that. It lets you keep documentation, code, and automation together
in a single `.md` file.

You write Markdown, but every fenced code block (`` ``` ``) becomes an
executable “recipe”. Spry reads these recipes, understands their structure, and
can list, plan, and run them—like a programmable `justfile` inside Markdown.

Think of each fenced code block as a task with a name, a description, and an
optional set of dependencies.

````md
## Example Project Tasks

```sh fmt -d "Format code"
deno fmt
```

```sh lint --dep fmt -d "Run the linter"
deno lint
```

```sh build --dep lint -d "Compile TypeScript"
deno task build
```
````

- **Task** is an _Executable_, a runnable fenced block that performs work. Tasks
  can depend on other tasks, consume args, produce outputs, and appear in DAG
  execution plans.
- **Directive** is a _Declarative / Configurational_ non-executable fenced block
  (or frontmatter section) that declares reusable expressions, constants,
  templates, or macros that other tasks can use.

### `task` — The runnable block

- Always has a **name** (first token in INFO).
- Optional flags like `--dep`, `--arg`, `--when`, etc.
- Body contains executable code (`sh`, `ts`, `python`, etc.).
- Appears in `spry list`, `spry plan`, and `spry run`.

Example:

````md
```sh build --dep lint -d "Compile TypeScript" --arg target:string=node
deno task build -- ${args.target}
```
````

### `directive` — The reusable declaration

- Does **not** execute; defines reusable expressions or configuration.
- Can define **partials**, **constants**, **templates**, or **helpers**.
- Referenced by tasks via `${partial()}`, `${directives.*}`, or `import`-like
  syntax.

### What happens when you run

```bash
spry.ts task run
```

Spry:

1. Finds this Markdown file (your Spry Notebook).
2. Parses the fenced blocks.
3. Builds a dependency graph (`fmt` → `lint` → `build`).
4. Runs them in order, showing logs and results.

### Listing available tasks

```bash
spry.ts task ls
```

Output:

```
fmt        Format code
lint       Run the linter     (depends on: fmt)
build      Compile TypeScript (depends on: lint)
```

## Anatomy of a recipe fence

A recipe is a fenced code block. Its header line contains three parts:

````md
```<language> <INFO> { <attrs> }
```
````

- `language` – the runner (sh, bash, pwsh, ts, python, sql…).
- `INFO` – a mini CLI line defining name and flags.
- `attrs` – optional JSON5 object for structured metadata.

Example:

````md
```sh build --dep lint -d "Compile sources" { cache: true, args: { target: "node" } }
deno task build -- ${args.target}
```
````

### INFO segment

Behaves like a tiny command line:

| Element                   | Meaning                         | Example                             |
| ------------------------- | ------------------------------- | ----------------------------------- |
| `build`                   | Recipe name (required)          | `lint`                              |
| `--dep <name>`            | Dependency                      | `--dep fmt`                         |
| `-d, --desc`              | Description                     | `-d "Run tests"`                    |
| `--arg name:type=default` | Define argument                 | `--arg version:string=patch`        |
| `-e KEY=VAL`              | Env var                         | `-e NODE_ENV=production`            |
| `--when <expr>`           | Guard condition (TS expression) | `--when 'runtime.os !== "windows"'` |

### Attrs section

Stores richer structured data. Attrs override flags if both are present.

```md
{ cache: true, env: { CI: "1" }, args: { target: { type: "string", default:
"node" } } }
```

## Arguments and Interpolation (`${...}`)

Spry evaluates expressions written as `${...}` before passing them to the shell.
You can reference:

| Context    | Example                       | Meaning                         |
| ---------- | ----------------------------- | ------------------------------- |
| `args`     | `${args.target}`              | user-supplied argument          |
| `env`      | `${env.PATH}`                 | environment variable            |
| `partials` | `${partials.dockerTag}`       | predefined reusable expressions |
| `runtime`  | `${runtime.os}`               | system information              |
| Any JS/TS  | `${new Date().toISOString()}` | computed values                 |

Spry’s `${...}` are _unsafe_ TypeScript expressions, not strings. They can call
functions, use conditionals, or import helpers.

### Avoiding shell confusion

Shells also use `$VAR` and `${VAR}`. Spry evaluates `${expr}` first and then
passes the output to shells. If you do not want default expression evaluation
just escape with `\$` and Spry leaves it alone.

Example:

````md
```sh mixed
echo "Home is \${HOME}"                   # Spry ignores
echo "Version: ${runtime.pkg.version}"    # Spry expands
echo "Keep literal \${NEEDS_RUNTIME_SUB}" # Spry ignores
```
````

## Using partials for reusable snippets

You can define reusable snippets ("partials") as `partial` fences then use them
in recipes:

````md
```sh PARTIAL partial-name
# This is a normal block but will execute.
```

```sh build --arg target:string=node
${partial("partial-name")} # include a complete block
deno task build --outDir ${partial("test")}
docker build -t ${partial("test2")} .
```
````

Got it. Here’s the same **Spry Task Runner Shebang Documentation**, rewritten
**without fenced code blocks**, using inline backticks so it stays clean and
readable inside your Markdown-based docs or generated HTML pages.

## Spry Task Runner Shebangs

> _Defining per-task interpreters inside Markdown fences_

In Spry, every **task** is a fenced Markdown block. The first word after the
opening triple backticks (`sh`) is the **interpreter**, or _shebang_. It tells
Spry _how_ to run the body of the task — whether as a shell script, Python,
TypeScript, SQL, or something else.

This idea is similar to Unix shebangs (`#!/usr/bin/env bash`) and to _shebang
recipes_ in `just`, but in Spry the shebang lives right inside the **fence
header**, not at the top of a file.

## TODO: Supported Shebangs

Spry includes several interpreters out of the box:

| Shebang              | Behavior                            | Default Runner                 |
| -------------------- | ----------------------------------- | ------------------------------ |
| `sh`, `bash`, `zsh`  | Run as POSIX shell script           | System shell                   |
| `pwsh`, `powershell` | PowerShell execution                | PowerShell                     |
| `python`, `py`       | Python script                       | `python3`                      |
| `ts`, `typescript`   | TypeScript block executed via Deno  | `deno run -`                   |
| `js`, `javascript`   | JavaScript block executed via Deno  | `deno run -`                   |
| `sql`                | Execute through database connection | `sqlite3`, `psql`, or `duckdb` |
| `json`, `yaml`       | Treated as directives, not run      | Spry internal parser           |
| `none`               | Documentation-only block            | Ignored at runtime             |

Each runner can be customized or extended through the `spry.runners` section of
your frontmatter.

### Customizing the Interpreter

You can override the interpreter at two levels: globally via **frontmatter**, or
locally via `#!shebang`.

**Example (frontmatter defaults):**

```yaml
---
spry:
  shell:
    unix: ["bash","-eu","-o","pipefail","-c"]
    win:  ["pwsh","-NoProfile","-Command"]
---
```

Sometimes a task needs _complete control_ of its interpreter. You can include a
real shebang line inside the fenced block:

````md
```sh docker-build
#!/usr/bin/env bash
set -euxo pipefail
docker build -t myimage .
```
````

### Behavior

- The first line beginning with `#!` inside the block overrides the fence
  shebang.
- The rest of the block is executed by that interpreter.
- Spry strips the shebang line before running.
- Works with any language (shell, Python, TS, etc.) if the interpreter exists.

### Shebang Resolution Order

When running a task, Spry determines the interpreter in this order:

1. Inline shebang (`#!` inside the block)
2. Fence shebang (`` ```bash ``, `` ```ts ``, etc.)
3. Frontmatter defaults (`spry.shell.*`)
4. System fallback (`/bin/sh` on Unix, `pwsh` or `cmd.exe` on Windows)

### Polyglot Pipelines

Spry supports multiple languages within the same notebook. Different tasks can
have different shebangs and pass data between them.

Spry automatically wires outputs between dependent tasks as STDOUT text, JSON or
JSONL streams, making cross-language workflows seamless.

### Best Practices

1. **Keep shebangs explicit.** Use `#!/usr/bin/env -S bash -eu -o pipefail -c`
   for consistent error handling.

2. **Stay portable.** Always prefer `#!/usr/bin/env` over absolute paths like
   `/usr/bin/bash`.

3. **Use fence shebangs by default.** Inline shebangs are powerful but harder to
   scan visually.

4. **Declare non-standard interpreters.** If you rely on tools like `duckdb` or
   `deno`, document them in frontmatter.

5. **Validate before execution.** You can guard tasks with
   `{ when: 'shell.which("deno")' }` to ensure tools exist.

### TODO Custom Runners

Define custom shebang interpreters in frontmatter:

```
---
spry:
  runners:
    node18: ["node", "--harmony"]
    duckdb: ["duckdb", ":memory:"]
---
```

Then use them in fences:

`` ```node18 script `` `console.log("Hello from Node 18");` `` ``` ``

`` ```duckdb query `` `SELECT 42 AS answer;` `` ``` ``

Spry runs these using the specified commands.

## TODO: CLI workflow for day-to-day use

| Command                           | Description                                        |
| --------------------------------- | -------------------------------------------------- |
| `spry task list`                  | List all recipes with descriptions                 |
| `spry task run <name>`            | Run a recipe and its dependencies                  |
| `spry task run <name> -- arg=val` | Run with argument overrides                        |
| `spry task plan <name>`           | Show the execution plan (dry run)                  |
| `spry task show <name>`           | Display resolved script with interpolation applied |
| `spry task fmt`                   | Format INFO flags and attrs consistently           |

Examples:

```bash
spry run build -- target=web
spry plan release
spry show lint
```

## TODO: Advanced features for intermediate engineers

Up to this point, you can think of Spry as a friendlier `justfile` written in
Markdown. But as soon as you understand dependencies and `${...}`, you can step
into more powerful features.

### TODO: Conditional execution

Use the `--when` flag or attr to restrict recipes by environment:

````md
```sh release --when 'runtime.os !== "windows"'
git push --tags
```
````

### TODO: Caching and idempotence

Enable caching so unchanged recipes are skipped:

````md
```sh build --cache --cache-keys "src/" --cache-keys "package-lock.json"
deno task build
```
````

Spry computes a content hash of the recipe code + declared keys.

### TODO: Concurrency

Independent recipes can run in parallel:

```yaml
---
spry:
  concurrency: 4
---
```

### TODO: Interactive tasks

Mark a recipe as interactive so it runs alone (TTY passthrough):

````md
```sh login --interactive
gh auth login
```
````

````
### TODO: Watch mode
Automatically re-run on file changes:

```md
```sh test:watch --watch "src//*.ts" --watch "lib//*.ts"
deno test
````

## Advanced topics

### Type-safe arguments with Zod

Spry integrates Zod schemas behind `args`.\
This lets recipes self-validate and auto-generate help messages.

````md
```sh deploy --arg env:enum(dev|staging|prod)=dev
{ args: { env: z.enum(["dev","staging","prod"]) } }
echo "Deploying to ${args.env}"
```
````

### TODO: Rich metadata and provenance

Each run can emit structured JSON logs for observability or compliance.\
Spry notebooks can self-document their dependency graph and provenance for
reproducible automation.

### Hybrid languages

Since every fence declares its language, a single notebook can coordinate:

- Shell commands (`sh`)
- TypeScript (`ts`) preprocessing
- SQL migrations (`sql`)
- JSON/HTTP definitions
- Python scripts (`python`)

Spry runs them deterministically in dependency order.

### Advanced orchestration

Recipes can pass structured outputs to downstream recipes:

`````md
````ts generate-data
export default () => ({ users: 42 });

```sh summarize --dep generate-data
echo "Users processed: ${deps['generate-data'].users}"
````
`````

### Discoverability

Spry automatically finds the nearest notebook file (`*.spry.md` or
`Spryfile.md`) in your directory tree—so you can run tasks from anywhere in the
project.

### Extending Spry

You can write your own emitters or runners (plugins) in TypeScript. These extend
how new fence languages or INFO flags behave.

## Design philosophy recap

| Principle                     | Explanation                                          |
| ----------------------------- | ---------------------------------------------------- |
| Markdown-first                | Everything—code, docs, automation—lives together.    |
| Type-safe and self-describing | Arguments and metadata validated by Zod.             |
| Programmable `${...}`         | TypeScript expressions with predictable precedence.  |
| Declarative + imperative      | INFO is declarative; body is imperative.             |
| Extensible by design          | New languages, new emitters, or runners can plug in. |
| Cross-language orchestration  | Mix shell, SQL, TypeScript, and Python in one flow.  |

## Comparison: Spry vs other task runners

| Feature                    | Spry                          | Just     | Make  | npm scripts |
| -------------------------- | ----------------------------- | -------- | ----- | ----------- |
| Syntax                     | Markdown fences               | DSL      | DSL   | JSON        |
| Language flexibility       | Any (`sh`, `ts`, `sql`, etc.) | Shell    | Shell | JS only     |
| Type-safe args             | ✅ via Zod                    | ❌       | ❌    | ❌          |
| Documentation in same file | ✅                            | ❌       | ❌    | ❌          |
| Interpolation engine       | TypeScript expressions        | Just DSL | None  | Shell       |
| Caching / provenance       | ✅                            | ❌       | ❌    | ❌          |
| Plugin architecture        | ✅                            | ❌       | ❌    | Limited     |

## Takeaway for new team members

If you can write Markdown, you can automate with Spry. Start simple:

````md
```sh hello -d "Say hello"
echo "Hello, world!"
```
````

Then gradually add dependencies, arguments, and expressions as you learn.\
You’ll never have to remember special DSL syntax again—just Markdown,
TypeScript, and shell.

## For advanced contributors

Spry’s orchestration layer is fully programmable.\
If you want to extend it:

- Add new INFO flags in the parser to support your workflow.
- Define partial generators to centralize computed paths.
- Build custom emitters that translate recipes to CI/CD YAML, SQLPage, or other
  pipelines.
- Use the `spry fmt`, `spry plan`, and `spry run` commands in your CI to make
  literate automation reproducible and self-verifying.

### Summary

Spry turns Markdown into a living orchestration surface.\
Each fence is a programmable, type-safe recipe that can:

- run like a CLI,
- depend on others,
- document itself,
- and emit reproducible results.

It’s the bridge between documentation, code, and execution.
