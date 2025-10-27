---
title: API Reference
description: Complete API reference for Spry
---

# API Reference

Complete reference for the Spry API.

## Spry Class

### Constructor

```typescript
new Spry(config?: SpryConfig)
```

Creates a new Spry instance with optional configuration.

**Parameters:**
- `config` (optional): Configuration object

**Example:**
```javascript
const spry = new Spry({
  input: { format: 'xlsx' },
  output: { format: 'json' }
});
```

### Methods

#### process()

```typescript
async process(input: string, options?: ProcessOptions): Promise<SpryResult>
```

Process a spreadsheet file.

**Parameters:**
- `input`: Path to the input file
- `options` (optional): Processing options

**Returns:** Promise resolving to processed data

**Example:**
```javascript
const data = await spry.process('data.xlsx');
```

#### extract()

```typescript
async extract(input: string): Promise<RawData>
```

Extract raw data from a spreadsheet.

**Parameters:**
- `input`: Path to the input file

**Returns:** Promise resolving to raw data

#### transform()

```typescript
async transform(data: RawData, rules?: TransformRules): Promise<TransformedData>
```

Transform data according to rules.

**Parameters:**
- `data`: Raw data to transform
- `rules` (optional): Transformation rules

**Returns:** Promise resolving to transformed data

#### load()

```typescript
async load(data: TransformedData, output: string): Promise<void>
```

Load transformed data to output.

**Parameters:**
- `data`: Data to save
- `output`: Output file path

## Type Definitions

### SpryConfig

```typescript
interface SpryConfig {
  input?: {
    format?: 'xlsx' | 'xls' | 'csv';
    path?: string;
    encoding?: string;
  };
  output?: {
    format?: 'json' | 'csv' | 'xlsx';
    path?: string;
    pretty?: boolean;
  };
  options?: {
    binaryContent?: boolean;
    pseudoCells?: boolean;
    validation?: boolean;
  };
}
```

### ProcessOptions

```typescript
interface ProcessOptions {
  format?: string;
  output?: string;
  transform?: TransformFunction;
  filter?: FilterFunction;
}
```

### SpryResult

```typescript
interface SpryResult {
  data: any;
  metadata: {
    rows: number;
    columns: number;
    sheets?: string[];
  };
  errors?: Error[];
}
```

## CLI Reference

### Commands

#### process

```bash
spry process [options] <file>
```

Process a spreadsheet file.

**Options:**
- `-f, --format <format>`: Output format
- `-o, --output <path>`: Output path
- `--binary`: Enable binary content support
- `--pseudo`: Enable pseudo cells

**Example:**
```bash
spry process --format json data.xlsx
```

#### validate

```bash
spry validate [options] <file>
```

Validate a spreadsheet file.

#### convert

```bash
spry convert [options] <input> <output>
```

Convert between formats.

## Events

### Processing Events

```javascript
spry.on('start', (file) => {
  console.log(`Processing ${file}`);
});

spry.on('progress', (percent) => {
  console.log(`Progress: ${percent}%`);
});

spry.on('complete', (result) => {
  console.log('Complete!', result);
});

spry.on('error', (error) => {
  console.error('Error:', error);
});
```

## Error Codes

- `INVALID_FORMAT`: Invalid file format
- `FILE_NOT_FOUND`: File not found
- `PARSE_ERROR`: Error parsing file
- `VALIDATION_ERROR`: Validation failed
- `TRANSFORM_ERROR`: Transformation error

## Next Steps

- See [Usage Examples](/guides/usage-examples) for practical examples
- Visit the [GitHub repository](https://github.com/programmablemd/spry) for source code
