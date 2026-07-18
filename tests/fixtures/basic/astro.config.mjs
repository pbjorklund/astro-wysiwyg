import { defineConfig } from 'astro/config';
import wysiwyg from 'astro-wysiwyg';

export default defineConfig({
  integrations: [wysiwyg({ saveDelay: 500 })],
});
