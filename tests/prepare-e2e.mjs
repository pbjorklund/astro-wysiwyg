import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultOptions = {
  canonicalRoot: path.resolve('demo'),
  coverageRoot: path.resolve('.coverage/browser'),
  runtimeRoot: path.resolve('.tmp/e2e-site'),
};

export async function prepareE2eSite(options = {}) {
  const { canonicalRoot, coverageRoot, runtimeRoot } = { ...defaultOptions, ...options };
  await access(canonicalRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(coverageRoot, { recursive: true, force: true });
  await mkdir(path.dirname(runtimeRoot), { recursive: true });
  await cp(canonicalRoot, runtimeRoot, { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareE2eSite();
}
