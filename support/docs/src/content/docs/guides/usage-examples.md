---
title: Usage Examples
description: Practical examples of using Spry
---

# Usage Examples

Learn Spry through practical examples covering common use cases.

## Basic File Processing

### Converting Excel to JSON

```javascript
import { Spry } from 'spry';

const spry = new Spry();
const data = await spry.process('data.xlsx', {
  output: {
    format: 'json',
    path: 'output.json'
  }
});

console.log('Conversion complete!');
```

### Processing Multiple Files

```javascript
import { Spry } from 'spry';
import { glob } from 'glob';

const files = await glob('input/*.xlsx');
const spry = new Spry();

for (const file of files) {
  await spry.process(file);
}
```

## Advanced Processing

### Using Pseudo Cells

```javascript
const spry = new Spry({
  options: {
    pseudoCells: true,
    pseudoCellRules: {
      // Define pseudo cell generation rules
      timestamp: () => new Date().toISOString(),
      rowId: (row, index) => `row_${index}`
    }
  }
});

const data = await spry.process('data.xlsx');
```

### Handling Binary Content

```javascript
const spry = new Spry({
  options: {
    binaryContent: true,
    binaryExtraction: './extracted'
  }
});

const data = await spry.process('document.xlsx');
// Binary content is extracted to ./extracted directory
```

## Data Transformation

### Custom Transformations

```javascript
const spry = new Spry({
  transform: (cell) => {
    // Transform cell values
    if (cell.type === 'number') {
      return cell.value * 1.1; // 10% increase
    }
    return cell.value;
  }
});
```

### Filtering Data

```javascript
const spry = new Spry({
  filter: (row) => {
    // Only process rows where status is 'active'
    return row.status === 'active';
  }
});
```

## Validation

### Data Validation

```javascript
const spry = new Spry({
  validation: {
    rules: {
      email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      age: (value) => value >= 0 && value <= 120
    },
    onError: 'warn' // 'warn', 'throw', or 'ignore'
  }
});

const data = await spry.process('users.xlsx');
```

## Using with Spryfile

### Spryfile.md Example

```markdown
# Data Processing Project

## Configuration

- Input: ./data/*.xlsx
- Output: ./processed
- Format: json

## Processing Rules

1. Validate email addresses
2. Generate pseudo cells for timestamps
3. Extract binary content

## Transformations

- Convert dates to ISO format
- Normalize phone numbers
```

Then in your code:

```javascript
import { Spry } from 'spry';

// Configuration is loaded from Spryfile.md automatically
const spry = new Spry();
await spry.processFromConfig();
```

## Batch Processing

### ETL Pipeline

```javascript
import { Spry } from 'spry';

async function etlPipeline() {
  const spry = new Spry();

  // Extract
  const data = await spry.extract('source.xlsx');

  // Transform
  const transformed = await spry.transform(data, {
    // transformation rules
  });

  // Load
  await spry.load(transformed, 'output.json');
}

etlPipeline();
```

## Error Handling

### Robust Error Handling

```javascript
import { Spry } from 'spry';

const spry = new Spry();

try {
  const data = await spry.process('data.xlsx');
  console.log('Success!', data);
} catch (error) {
  if (error.code === 'INVALID_FORMAT') {
    console.error('Invalid file format');
  } else if (error.code === 'FILE_NOT_FOUND') {
    console.error('File not found');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Next Steps

- Explore the [Reference documentation](/reference) for detailed API information
- Check out the [GitHub repository](https://github.com/programmablemd/spry) for more examples
