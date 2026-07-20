import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareE2eSite } from './prepare-e2e.mjs';
import { resetE2eSource } from './reset-e2e-source.mjs';

async function createTestSite() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-wysiwyg-demo-'));
  const canonicalRoot = path.join(root, 'demo');
  const runtimeRoot = path.join(root, 'runtime');
  const coverageRoot = path.join(root, 'coverage');
  await mkdir(path.join(canonicalRoot, 'src', 'pages'), { recursive: true });
  await mkdir(path.join(canonicalRoot, 'public', 'assets'), { recursive: true });
  await writeFile(path.join(canonicalRoot, 'src', 'pages', 'index.astro'), '<p>Canonical page</p>\n');
  await writeFile(path.join(canonicalRoot, 'src', 'pages', 'second.md'), 'Canonical second page\n');
  await writeFile(path.join(canonicalRoot, 'public', 'assets', 'sample.txt'), 'Canonical asset\n');
  return {
    canonicalRoot,
    coverageRoot,
    root,
    runtimeRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('prepares a clean writable demo copy without changing the canonical site', async () => {
  const site = await createTestSite();
  try {
    await mkdir(site.runtimeRoot, { recursive: true });
    await mkdir(site.coverageRoot, { recursive: true });
    await writeFile(path.join(site.runtimeRoot, 'stale.txt'), 'stale');
    await writeFile(path.join(site.coverageRoot, 'stale.json'), '{}');

    await prepareE2eSite(site);
    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'src', 'pages', 'index.astro'), 'utf8'),
      '<p>Canonical page</p>\n',
    );
    await assert.rejects(readFile(path.join(site.runtimeRoot, 'stale.txt')));
    await assert.rejects(readFile(path.join(site.coverageRoot, 'stale.json')));

    await writeFile(path.join(site.runtimeRoot, 'src', 'pages', 'index.astro'), '<p>Changed runtime page</p>\n');
    await writeFile(path.join(site.runtimeRoot, 'public', 'assets', 'sample.txt'), 'Changed runtime asset\n');
    await prepareE2eSite(site);

    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'src', 'pages', 'index.astro'), 'utf8'),
      '<p>Canonical page</p>\n',
    );
    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'public', 'assets', 'sample.txt'), 'utf8'),
      'Canonical asset\n',
    );
    assert.equal(
      await readFile(path.join(site.canonicalRoot, 'src', 'pages', 'index.astro'), 'utf8'),
      '<p>Canonical page</p>\n',
    );
  } finally {
    await site.cleanup();
  }
});

test('rejects a missing canonical demo before removing an existing runtime copy', async () => {
  const site = await createTestSite();
  try {
    await mkdir(site.runtimeRoot, { recursive: true });
    await writeFile(path.join(site.runtimeRoot, 'sentinel.txt'), 'keep');
    await assert.rejects(prepareE2eSite({
      canonicalRoot: path.join(site.root, 'missing'),
      coverageRoot: site.coverageRoot,
      runtimeRoot: site.runtimeRoot,
    }));
    assert.equal(await readFile(path.join(site.runtimeRoot, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await site.cleanup();
  }
});

test('resets changed, missing, and extra source files and public assets', async () => {
  const site = await createTestSite();
  try {
    await prepareE2eSite(site);
    await writeFile(path.join(site.runtimeRoot, 'src', 'pages', 'index.astro'), '<p>Changed</p>\n');
    await rm(path.join(site.runtimeRoot, 'src', 'pages', 'second.md'));
    await writeFile(path.join(site.runtimeRoot, 'src', 'pages', 'extra.md'), 'Extra page\n');
    await writeFile(path.join(site.runtimeRoot, 'public', 'assets', 'sample.txt'), 'Changed asset\n');
    await writeFile(path.join(site.runtimeRoot, 'public', 'assets', 'extra.txt'), 'Extra asset\n');

    assert.equal(await resetE2eSource(site), true);
    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'src', 'pages', 'index.astro'), 'utf8'),
      '<p>Canonical page</p>\n',
    );
    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'src', 'pages', 'second.md'), 'utf8'),
      'Canonical second page\n',
    );
    assert.equal(
      await readFile(path.join(site.runtimeRoot, 'public', 'assets', 'sample.txt'), 'utf8'),
      'Canonical asset\n',
    );
    await assert.rejects(readFile(path.join(site.runtimeRoot, 'src', 'pages', 'extra.md')));
    await assert.rejects(readFile(path.join(site.runtimeRoot, 'public', 'assets', 'extra.txt')));
    assert.equal(await resetE2eSource(site), false);
  } finally {
    await site.cleanup();
  }
});
