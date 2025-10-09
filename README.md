# Spry: Markdown as a Programmable Medium

> Lightweight TypeScript library for executable, composable Markdown.

You’ve probably used Markdown to **document** code. Spry lets you use Markdown
to **be** the code.

Spry is a lightweight TypeScript library that treats Markdown as a
**programmable medium** — every fence, section, and directive in your `.md` file
can express behavior, not just formatting. Instead of building new DSLs or YAML
pipelines, you describe intent in plain Markdown and let Spry materialize it as
code, data, or execution.

## Why Spry?

Modern engineering workflows already blur the line between documentation and
automation:

- Jupyter notebooks run Python next to prose.
- `README.md` files show how to build but can’t actually _build_.
- DevOps playbooks, SQL scripts, and AI prompts live in separate silos.

Spry unifies them. It makes Markdown an **active medium** that:

- Executes embedded code blocks and captures their outputs.
- Composes multiple source types (SQL, HTML, JSON, shell, etc.) as executable
  “cells”.
- Treats sections as first-class programmable units with attributes, metadata,
  and dependency graphs.
- Uses TypeScript for all parsing, safety, and runtime orchestration — no Python
  or heavy kernel machinery.

## What it looks like

See [lib/notebook/mod_test-fixture-01.md](lib/notebook/mod_test-fixture-01.md).

Every fenced block becomes an executable “cell,” every attribute a typed
directive, and the whole Markdown file turns into a reproducible workflow.

## Key Ideas

- **Executable Markdown** – each fence can run, verify, or emit output.
- **Composable Materialization** – plug-in modules turn Markdown into SQL, HTML,
  JSON, or other artifacts.
- **Type-Safe by Design** – built with Zod + TypeScript generics for predictable
  DX.
- **Plugin-Native** – “emitters” and “interpreters” are just Deno modules that
  Spry can discover and wire automatically.
- **CLI + API** – use Spry as a command runner, CI step, or embedded library.

## Why not just use notebooks?

Spry is _non-interactive_ by default. Think of it as **Jupyter for build
systems**, **dbt for Markdown**, or **Makefiles written as prose**. It
emphasizes reproducibility and composability over visualization.

Markdown becomes your configuration, your source code, and your documentation —
all in one, all executable.

## Example Use Cases

- Self-verifying README files
- SQL migration notebooks
- Literate DevOps playbooks
- Data pipelines defined in Markdown
- AI prompt notebooks that emit structured JSON
- Documentation that proves its own examples work

### 🗣️ Philosophy

Markdown was never meant to be static. Spry reimagines it as a _live medium_ —
one that can describe, run, and document computation in the same breath.

Docs and code no longer drift apart because they’re now the same thing.
