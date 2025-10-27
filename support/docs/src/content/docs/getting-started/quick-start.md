---
title: Quick Start
description: Get up and running with Spry in minutes
---

# Quick Start Guide

Get started with Spry in just a few minutes. This guide will walk you through installation and your first Spry project.

## Installation

Install Spry using pnpm:

```bash
pnpm add spry
```

## Your First Spry Project

### 1. Create a Spryfile

Create a `Spryfile` or `Spryfile.md` in your project root:

```markdown
# My Spry Project

## Configuration

Add your configuration here
```

### 2. Process a Spreadsheet

Create a simple script to process a spreadsheet:

```javascript
import { Spry } from 'spry';

const spry = new Spry();
const data = await spry.process('input.xlsx');

console.log(data);
```

### 3. Run Your Script

```bash
node your-script.js
```

## What's Next?

- Learn about [Core Concepts](/guides/core-concepts) to understand how Spry works
- Explore [Configuration](/guides/configuration) options to customize your workflow
- Check out [Usage Examples](/guides/usage-examples) for common patterns

## Getting Help

- Visit the [GitHub repository](https://github.com/programmablemd/spry) to report issues or contribute
- Read the [Reference documentation](/reference) for detailed API information
