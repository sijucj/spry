# Spry Documentation

Official documentation site for [Spry](https://github.com/programmablemd/spry), built with [Astro Starlight](https://starlight.astro.build/).

## Getting Started

### Prerequisites

- Node.js 18 or higher
- pnpm

### Installation

```bash
pnpm install
```

### Development

Start the development server:

```bash
pnpm dev
```

The site will be available at `http://localhost:4321`.

### Building

Build the documentation site:

```bash
pnpm build
```

The built site will be in the `dist/` directory.

### Preview

Preview the built site:

```bash
pnpm preview
```

## Project Structure

```
.
├── public/           # Static assets
├── src/
│   ├── content/
│   │   └── docs/    # Documentation markdown files
│   │       ├── getting-started/
│   │       ├── guides/
│   │       └── reference/
│   └── styles/      # Custom CSS
├── astro.config.mjs # Astro configuration
├── package.json
└── tsconfig.json
```

## Customization

### Navigation

Edit the `sidebar` configuration in `astro.config.mjs` to modify the navigation structure.

### Metadata

Update the `title`, `description`, and `social` links in `astro.config.mjs`.

### Styling

Customize the appearance by editing `src/styles/custom.css`.

## Deployment

### GitHub Pages

1. Update the `site` option in `astro.config.mjs`:

```javascript
export default defineConfig({
  site: 'https://programmablemd.github.io',
  base: '/spry',
  // ... rest of config
});
```

2. Build and deploy:

```bash
pnpm build
# Deploy the dist/ directory to GitHub Pages
```

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/programmablemd/spry)

### Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/programmablemd/spry)

## Contributing

Contributions to the documentation are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

This documentation is part of the Spry project. See the main repository for license information.
