import { expect, test as base } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, unknown>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

declare global {
  interface Window {
    __coverage__?: IstanbulCoverage;
  }
}

function mergeCoverage(target: IstanbulCoverage, source: IstanbulCoverage | undefined): IstanbulCoverage {
  if (!source) return target;
  for (const [file, incoming] of Object.entries(source)) {
    const current = target[file];
    if (!current) {
      target[file] = structuredClone(incoming);
      continue;
    }
    for (const [key, count] of Object.entries(incoming.s)) current.s[key] = (current.s[key] ?? 0) + count;
    for (const [key, count] of Object.entries(incoming.f)) current.f[key] = (current.f[key] ?? 0) + count;
    for (const [key, counts] of Object.entries(incoming.b)) {
      const values = current.b[key] ?? [];
      current.b[key] = counts.map((count, index) => (values[index] ?? 0) + count);
    }
  }
  return target;
}

export const test = base.extend<{ coverageCollector: void }>({
  coverageCollector: [async ({ page }, use, testInfo) => {
    await page.addInitScript(() => {
      const merge = (target: IstanbulCoverage, source: IstanbulCoverage | undefined): IstanbulCoverage => {
        if (!source) return target;
        for (const [file, incoming] of Object.entries(source)) {
          const current = target[file];
          if (!current) {
            target[file] = incoming;
            continue;
          }
          for (const [key, count] of Object.entries(incoming.s)) current.s[key] = (current.s[key] ?? 0) + count;
          for (const [key, count] of Object.entries(incoming.f)) current.f[key] = (current.f[key] ?? 0) + count;
          for (const [key, counts] of Object.entries(incoming.b)) {
            const values = current.b[key] ?? [];
            current.b[key] = counts.map((count, index) => (values[index] ?? 0) + count);
          }
        }
        return target;
      };
      addEventListener('pagehide', () => {
        const previous = JSON.parse(localStorage.getItem('__astro_wysiwyg_coverage__') ?? '{}') as IstanbulCoverage;
        localStorage.setItem(
          '__astro_wysiwyg_coverage__',
          JSON.stringify(merge(previous, window.__coverage__)),
        );
      });
    });

    await use();

    const merged: IstanbulCoverage = {};
    for (const frame of page.frames()) {
      const coverage = await frame.evaluate(() => {
        const previous = JSON.parse(localStorage.getItem('__astro_wysiwyg_coverage__') ?? '{}') as IstanbulCoverage;
        return { previous, current: window.__coverage__ };
      }).catch(() => ({ previous: {}, current: undefined }));
      mergeCoverage(merged, coverage.previous);
      mergeCoverage(merged, coverage.current);
    }
    if (Object.keys(merged).length === 0) return;
    const directory = path.resolve('.coverage/browser');
    await mkdir(directory, { recursive: true });
    const safeTitle = testInfo.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    await writeFile(path.join(directory, `${testInfo.workerIndex}-${safeTitle}.json`), JSON.stringify(merged));
  }, { auto: true }],
});

export { expect };
