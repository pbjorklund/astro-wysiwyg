import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaultOptions = {
  canonicalRoot: path.resolve('demo'),
  runtimeRoot: path.resolve('.tmp/e2e-site'),
};

export async function resetE2eSource(options = {}) {
  const { canonicalRoot, runtimeRoot } = { ...defaultOptions, ...options };
  let changed = false;
  for (const relative of ['src', 'public']) {
    changed = await syncPath(
      path.join(canonicalRoot, relative),
      path.join(runtimeRoot, relative),
    ) || changed;
  }
  return changed;
}

async function syncPath(canonicalPath, runtimePath) {
  const canonical = await lstat(canonicalPath).catch(() => undefined);
  const runtime = await lstat(runtimePath).catch(() => undefined);

  if (!canonical) {
    if (!runtime) return false;
    await rm(runtimePath, { recursive: true, force: true });
    return true;
  }

  if (canonical.isDirectory()) {
    let changed = false;
    if (runtime && !runtime.isDirectory()) {
      await rm(runtimePath, { recursive: true, force: true });
      changed = true;
    }
    if (!runtime?.isDirectory()) {
      await mkdir(runtimePath, { recursive: true });
      changed = true;
    }
    const canonicalEntries = new Set(await readdir(canonicalPath));
    const runtimeEntries = new Set(await readdir(runtimePath));
    for (const entry of new Set([...canonicalEntries, ...runtimeEntries])) {
      changed = await syncPath(
        path.join(canonicalPath, entry),
        path.join(runtimePath, entry),
      ) || changed;
    }
    return changed;
  }

  if (!canonical.isFile()) throw new Error(`Unsupported canonical demo entry: ${canonicalPath}`);
  const expected = await readFile(canonicalPath);
  const current = runtime?.isFile() ? await readFile(runtimePath) : undefined;
  if (current?.equals(expected)) return false;

  if (runtime) await rm(runtimePath, { recursive: true, force: true });
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, expected);
  return true;
}
