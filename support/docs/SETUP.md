# Spry Documentation Setup Guide

This guide will help you set up and run the Spry documentation site built with Astro Starlight.

## Project Structure

```
support/docs/
├── .github/
│   └── workflows/
│       └── deploy.yml         # GitHub Pages deployment workflow
├── public/
│   └── favicon.svg            # Site favicon
├── src/
│   ├── assets/                # Static assets (images, etc.)
│   ├── content/
│   │   └── docs/             # Documentation content
│   │       ├── getting-started/
│   │       │   ├── introduction.md
│   │       │   ├── quick-start.md
│   │       │   └── installation.md
│   │       ├── guides/
│   │       │   ├── core-concepts.md
│   │       │   ├── configuration.md
│   │       │   └── usage-examples.md
│   │       ├── reference/
│   │       │   └── api.md
│   │       └── index.mdx      # Home page
│   ├── styles/
│   │   └── custom.css         # Custom styling
│   ├── content/
│   │   └── config.ts          # Content collection configuration
│   └── env.d.ts               # TypeScript environment definitions
├── .gitignore
├── .npmrc
├── astro.config.mjs           # Astro & Starlight configuration
├── netlify.toml               # Netlify deployment config
├── package.json               # Dependencies and scripts
├── README.md                  # Project documentation
├── tsconfig.json              # TypeScript configuration
└── vercel.json                # Vercel deployment config
```

## Installation

### Step 1: Install Dependencies

Navigate to the docs directory and install dependencies:

```bash
cd support/docs
pnpm install
```

### Step 2: Run Development Server

Start the local development server:

```bash
pnpm dev
```

The documentation site will be available at `http://localhost:4321`.

### Step 3: Build for Production

Build the static site:

```bash
pnpm build
```

The built site will be in the `dist/` directory.

### Step 4: Preview Production Build

Preview the production build locally:

```bash
pnpm preview
```

## Configuration

### Customizing Metadata

Edit `astro.config.mjs` to customize:

- **Title**: Site title displayed in header
- **Description**: Site description for SEO
- **Social Links**: GitHub, Twitter, etc.

```javascript
starlight({
  title: 'Spry Documentation',
  description: 'Official documentation for Spry',
  social: {
    github: 'https://github.com/programmablemd/spry',
  },
  // ...
})
```

### Customizing Navigation

The sidebar navigation is configured in `astro.config.mjs`:

```javascript
sidebar: [
  {
    label: 'Getting Started',
    items: [
      { label: 'Introduction', slug: 'getting-started/introduction' },
      { label: 'Quick Start', slug: 'getting-started/quick-start' },
      { label: 'Installation', slug: 'getting-started/installation' },
    ],
  },
  // Add more sections...
],
```

### Custom Styling

Modify `src/styles/custom.css` to customize the appearance:

- Color scheme (accent colors)
- Typography
- Component styling

## Deployment

### GitHub Pages

1. Ensure the `.github/workflows/deploy.yml` file is present
2. Enable GitHub Pages in your repository settings
3. Set the source to "GitHub Actions"
4. Push to the main branch to trigger deployment

**Note**: If deploying to a project path (e.g., `username.github.io/spry`), update `astro.config.mjs`:

```javascript
export default defineConfig({
  site: 'https://programmablemd.github.io',
  base: '/spry',
  // ...
});
```

### Vercel

1. Import your repository to Vercel
2. Vercel will auto-detect the Astro framework
3. Deploy with default settings

Or use the Vercel CLI:

```bash
pnpm add -g vercel
vercel
```

### Netlify

1. Connect your repository to Netlify
2. Netlify will use the settings from `netlify.toml`
3. Deploy

Or use the Netlify CLI:

```bash
pnpm add -g netlify-cli
netlify deploy --prod
```

## Adding Content

### Creating New Pages

1. Create a new `.md` or `.mdx` file in `src/content/docs/`
2. Add frontmatter with title and description:

```markdown
---
title: My Page Title
description: A brief description
---

# Content goes here
```

3. Add the page to the sidebar in `astro.config.mjs`

### Using MDX Components

You can use Starlight's built-in components:

```mdx
import { Card, CardGrid } from '@astrojs/starlight/components';

<CardGrid>
  <Card title="Feature 1" icon="star">
    Description here
  </Card>
</CardGrid>
```

### Code Blocks

Use fenced code blocks with syntax highlighting:

````markdown
```javascript
const example = "code";
```
````

## Best Practices

1. **Content Organization**: Keep related content in subdirectories
2. **Navigation Structure**: Use logical grouping in the sidebar
3. **Cross-linking**: Link between related pages
4. **SEO**: Always include meaningful titles and descriptions
5. **Images**: Store images in `src/assets/` or `public/`
6. **Search**: Starlight includes built-in search

## Troubleshooting

### Port Already in Use

If port 4321 is in use:

```bash
pnpm dev --port 3000
```

### Build Errors

Clear the Astro cache:

```bash
rm -rf .astro node_modules
pnpm install
pnpm build
```

### Missing Dependencies

Reinstall dependencies:

```bash
pnpm install --frozen-lockfile
```

## Resources

- [Astro Documentation](https://docs.astro.build/)
- [Starlight Documentation](https://starlight.astro.build/)
- [Spry GitHub Repository](https://github.com/programmablemd/spry)

## Support

For issues or questions:

- Open an issue on [GitHub](https://github.com/programmablemd/spry/issues)
- Check the Starlight docs for framework-specific questions
- Review the Astro Discord for community support
