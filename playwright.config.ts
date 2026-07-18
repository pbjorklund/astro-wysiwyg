import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4328',
    headless: true,
  },
  webServer: {
    command: 'node tests/prepare-e2e.mjs && cd .tmp/e2e-site && VITE_COVERAGE=true ../../node_modules/.bin/astro dev --host 127.0.0.1 --port 4328',
    url: 'http://127.0.0.1:4328',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
