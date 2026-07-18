import { cp, mkdir, rm } from 'node:fs/promises';

await rm('.tmp/e2e-site', { recursive: true, force: true });
await mkdir('.tmp', { recursive: true });
await cp('tests/fixtures/basic', '.tmp/e2e-site', { recursive: true });
