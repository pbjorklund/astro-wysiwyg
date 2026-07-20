import path from 'node:path';
import mdx from '@astrojs/mdx';
import { defineConfig } from 'astro/config';
import istanbul from 'vite-plugin-istanbul';

const isE2e = process.env.ASTRO_WYSIWYG_E2E === 'true';
const coverage = process.env.VITE_COVERAGE === 'true';
const { default: wysiwyg } = isE2e
  ? await import('astro-wysiwyg')
  : await import('../src/index.ts');

export default defineConfig({
  integrations: [mdx(), wysiwyg({ saveDelay: 500 })],
  vite: {
    optimizeDeps: {
      exclude: ['astro-wysiwyg', 'astro-wysiwyg/client', 'astro-wysiwyg/toolbar-app'],
    },
    plugins: coverage ? [istanbul({
      cwd: path.resolve('../..'),
      include: ['dist/client.js', 'dist/preferences.js', 'dist/toolbar-app.js'],
      exclude: [],
      requireEnv: false,
    })] : [],
  },
});
