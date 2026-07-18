import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import coverageLibrary from 'istanbul-lib-coverage';
import reportLibrary from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const { createCoverageMap } = coverageLibrary;
const { createContext } = reportLibrary;
const root = process.cwd();
const mergedCoverage = createCoverageMap(JSON.parse(await readFile('.coverage/server/coverage-final.json', 'utf8')));
for (const file of await readdir('.coverage/browser')) {
  mergedCoverage.merge(JSON.parse(await readFile(path.join('.coverage/browser', file), 'utf8')));
}
const coverageMap = createCoverageMap({});
const duplicateBrowserFiles = new Set(['dist/preferences.js', 'dist/toolbar-app.js']);
for (const file of mergedCoverage.files()) {
  if (!duplicateBrowserFiles.has(path.relative(root, file))) coverageMap.addFileCoverage(mergedCoverage.fileCoverageFor(file));
}

const context = createContext({ dir: '.coverage/report', coverageMap });
reports.create('text', { maxCols: 180 }).execute(context);
reports.create('json-summary').execute(context);
reports.create('html').execute(context);

const failures = [];
const expectedBrowserFile = path.join(root, 'dist/client.js');
if (!coverageMap.files().includes(expectedBrowserFile)) {
  failures.push('dist/client.js: browser coverage was not collected');
}
for (const file of coverageMap.files()) {
  const summary = coverageMap.fileCoverageFor(file).toSummary();
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    if (summary[metric].pct !== 100) failures.push(`${path.relative(root, file)} ${metric}: ${summary[metric].pct}%`);
  }
}
if (failures.length) {
  console.error('\nCoverage must be 100% for every file and metric:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
}
