import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packagePath = new URL('../package.json', import.meta.url);
const releaseWorkflowPath = new URL('../.github/workflows/release.yml', import.meta.url);

test('package metadata qualifies the integration for Astro discovery', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    homepage?: string;
    repository?: { type?: string; url?: string };
    bugs?: { url?: string };
    keywords?: string[];
    publishConfig?: { access?: string };
  };

  assert.equal(packageJson.homepage, 'https://github.com/pbjorklund/astro-wysiwyg#readme');
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/pbjorklund/astro-wysiwyg.git',
  });
  assert.equal(packageJson.bugs?.url, 'https://github.com/pbjorklund/astro-wysiwyg/issues');
  assert.ok(packageJson.keywords?.includes('astro-integration'));
  assert.ok(packageJson.keywords?.includes('dev-toolbar'));
  assert.equal(packageJson.publishConfig?.access, 'public');
});

test('release tags publish only after CI passed for the tagged commit', async () => {
  const workflow = await readFile(releaseWorkflowPath, 'utf8');

  assert.match(workflow, /tags:\s*\['v\*'\]/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /gh run list --workflow CI --commit "\$GITHUB_SHA"/);
  assert.match(workflow, /npm view "\$package@\$version"/);
  assert.match(workflow, /npm publish/);
  assert.match(workflow, /gh release create/);
});
