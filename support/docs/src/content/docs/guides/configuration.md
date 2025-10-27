---
title: Configuration
description: Learn how to configure Spry for your needs
---

# Configuration

Spry offers flexible configuration options to adapt to your workflow.

## Configuration Methods

### 1. Spryfile Configuration

The primary way to configure Spry is through a Spryfile or Spryfile.md:

```markdown
# Spry Configuration

## Input Settings
- Format: xlsx
- Path: ./input

## Output Settings
- Format: json
- Path: ./output

## Processing Options
- Binary content: enabled
- Pseudo cells: enabled
```

### 2. Programmatic Configuration

Configure Spry directly in your code:

```javascript
import { Spry } from 'spry';

const spry = new Spry({
  input: {
    format: 'xlsx',
    path: './input'
  },
  output: {
    format: 'json',
    path: './output'
  },
  options: {
    binaryContent: true,
    pseudoCells: true
  }
});
```

### 3. Command-Line Arguments

Override configuration via CLI:

```bash
spry process --format xlsx --output ./output input.xlsx
```

## Configuration Options

### Input Options

- `format`: Input file format (xlsx, xls, csv)
- `path`: Path to input files
- `encoding`: File encoding (default: utf-8)

### Output Options

- `format`: Output format (json, csv, xlsx)
- `path`: Output directory or file
- `pretty`: Pretty-print output (for JSON)

### Processing Options

- `binaryContent`: Enable binary content support
- `pseudoCells`: Generate pseudo cells
- `validation`: Enable data validation
- `transform`: Custom transformation rules

## Environment Variables

Spry respects the following environment variables:

- `SPRY_CONFIG`: Path to configuration file
- `SPRY_OUTPUT`: Default output directory
- `SPRY_FORMAT`: Default output format

## Configuration Precedence

Configuration is applied in this order (later overrides earlier):

1. Default values
2. Spryfile configuration
3. Environment variables
4. Programmatic configuration
5. Command-line arguments

## Best Practices

1. Use Spryfile for project-specific configuration
2. Use environment variables for deployment-specific settings
3. Use command-line arguments for one-off operations
4. Document your configuration choices

## Next Steps

See [Usage Examples](./usage-examples) for practical configuration scenarios.
