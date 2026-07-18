import path from 'node:path';
import { defineConfig } from 'astro/config';
import wysiwyg from 'astro-wysiwyg';
import istanbul from 'vite-plugin-istanbul';

export default defineConfig({
  integrations: [wysiwyg({ saveDelay: 500 })],
  vite: {
    optimizeDeps: {
      exclude: ['astro-wysiwyg', 'astro-wysiwyg/client', 'astro-wysiwyg/toolbar-app'],
    },
    plugins: [istanbul({
      cwd: path.resolve('../..'),
      include: ['dist/client.js', 'dist/preferences.js', 'dist/toolbar-app.js'],
      exclude: [],
      requireEnv: false,
    })],
  },
});
