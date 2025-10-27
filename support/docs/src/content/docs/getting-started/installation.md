---
title: Installation
description: Detailed installation instructions for Spry
---

# Installation

This guide covers various ways to install and set up Spry in your project.

## Prerequisites

Before installing Spry, ensure you have:

- Node.js 18 or higher
- pnpm package manager

## Package Manager Installation

Install Spry using pnpm:

```bash
pnpm add spry
```

## Development Installation

If you want to contribute to Spry or use the latest development version:

```bash
# Clone the repository
git clone https://github.com/programmablemd/spry.git

# Navigate to the project directory
cd spry

# Install dependencies
pnpm install

# Build the project
pnpm build
```

## Verification

Verify your installation by checking the version:

```bash
npx spry --version
```

## Configuration

After installation, you can create a `Spryfile` or `Spryfile.md` in your project root to configure Spry for your specific needs.

Example `Spryfile.md`:

```markdown
# Spry Configuration

## Settings

- Format: xlsx
- Output: ./output
```

## Next Steps

Now that you have Spry installed, head over to the [Quick Start guide](./quick-start) to begin using it in your projects.

## Troubleshooting

### Common Issues

**Node version mismatch**: Ensure you're using Node.js 18 or higher

```bash
node --version
```

**Permission errors**: On Unix-based systems, you might need to use sudo or configure pnpm properly

**Package not found**: Make sure you have a stable internet connection and try clearing your package manager cache

```bash
pnpm store prune
```
