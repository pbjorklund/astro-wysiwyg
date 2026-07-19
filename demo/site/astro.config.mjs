import { defineConfig } from 'astro/config';

const integrationUrl = process.env.ASTRO_WYSIWYG_INTEGRATION
  ?? new URL('../../dist/index.js', import.meta.url).href;
const { default: wysiwyg } = await import(integrationUrl);

export default defineConfig({
  integrations: [wysiwyg({ saveDelay: 60_000 })],
});
