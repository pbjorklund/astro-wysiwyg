import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtureRoot = path.resolve('tests/fixtures/basic/src');
const runtimeRoot = path.resolve('.tmp/e2e-site/src');

export async function resetE2eSource() {
  return resetDirectory('');
}

async function resetDirectory(relativeDirectory) {
  const fixtureDirectory = path.join(fixtureRoot, relativeDirectory);
  let changed = false;
  for (const entry of await readdir(fixtureDirectory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      changed = await resetDirectory(relative) || changed;
      continue;
    }
    if (!entry.isFile()) continue;
    changed = await resetFile(relative) || changed;
  }
  return changed;
}

async function resetFile(relative) {
  const fixtureFile = path.join(fixtureRoot, relative);
  const runtimeFile = path.join(runtimeRoot, relative);
  const expected = await readFile(fixtureFile);
  const current = await readFile(runtimeFile).catch(() => undefined);
  if (current?.equals(expected)) return false;

  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await writeFile(runtimeFile, expected);
  return true;
}
