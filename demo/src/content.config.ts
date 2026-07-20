import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const generated = defineCollection({
  loader: {
    name: 'generated-demo',
    load: async () => undefined,
  },
  schema: z.object({ title: z.string() }),
});

const articles = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { articles, generated };
