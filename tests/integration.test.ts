import assert from 'node:assert/strict';
import test from 'node:test';
import wysiwyg from '../src/index.ts';

test('registers source annotation and client only for the dev command', async () => {
  const integration = wysiwyg();
  const updates: unknown[] = [];
  const scripts: Array<[string, string]> = [];
  const toolbarApps: unknown[] = [];
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: { root: new URL('file:///project/') },
    updateConfig: (value: unknown) => { updates.push(value); return value; },
    injectScript: (stage: string, content: string) => scripts.push([stage, content]),
    addDevToolbarApp: (app: unknown) => toolbarApps.push(app),
  } as never);

  assert.equal(integration.name, 'astro-wysiwyg');
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /rehypePlugins/);
  assert.deepEqual(scripts.map(([stage]) => stage), ['page']);
  assert.match(scripts[0][1], /startEditor/);
  assert.equal(toolbarApps.length, 1);
  assert.match(JSON.stringify(toolbarApps[0]), /astro-wysiwyg/);
});

test('does not register editor code for build', async () => {
  const integration = wysiwyg();
  let updated = false;
  let injected = false;
  await integration.hooks['astro:config:setup']?.({
    command: 'build',
    config: { root: new URL('file:///project/') },
    updateConfig: () => { updated = true; return {}; },
    injectScript: () => { injected = true; },
  } as never);

  assert.equal(updated, false);
  assert.equal(injected, false);
});
