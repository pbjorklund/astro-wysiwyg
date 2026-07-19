import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const contractPath = new URL('../demo/recording/contract.json', import.meta.url);
const storyboardPath = new URL('../demo/recording/storyboard.json', import.meta.url);
const fixturePath = new URL('../demo/site/src/pages/index.md', import.meta.url);
const layoutPath = new URL('../demo/site/src/layouts/DemoLayout.astro', import.meta.url);
const recorderPath = new URL('../demo/record.mjs', import.meta.url);
const videoPath = new URL('../artwork/demo/astro-wysiwyg-demo.mp4', import.meta.url);

test('demo contract and storyboard define one source-backed outcome', async () => {
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
    rubric: Record<string, string>;
    evidence: { level: string; real: string[]; presentationOnly: string[] };
  };
  const storyboard = JSON.parse(await readFile(storyboardPath, 'utf8')) as {
    canvas: { width: number; height: number; fps: number };
    events: Array<{ id: string; start: number; end: number }>;
    finalProofHoldSeconds: number;
  };

  assert.equal(contract.evidence.level, 'live automated flow');
  assert.equal(Object.keys(contract.rubric).length, 8);
  assert.ok(Object.values(contract.rubric).every((result) => result === 'pass'));
  assert.deepEqual(storyboard.canvas, { width: 1600, height: 900, fps: 30 });
  assert.equal(new Set(storyboard.events.map(({ id }) => id)).size, storyboard.events.length);
  assert.ok(storyboard.events.every(({ start, end }) => Number.isFinite(start) && end > start));
  assert.ok(storyboard.finalProofHoldSeconds >= 4);
});

test('demo fixture starts with safe synthetic launch copy', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  assert.match(fixture, /rough product updates/);
  assert.doesNotMatch(fixture, /(password|api[_-]?key|bearer|customer|@)/i);
});

test('demo renders Bold as heavier text without substituting underline', async () => {
  const layout = await readFile(layoutPath, 'utf8');
  assert.match(layout, /article :is\(strong, b\).*font-weight: 800/);
  assert.doesNotMatch(layout, /article :is\(strong, b\).*text-decoration: underline/);
});

test('recorder uses live-window capture without a simulated DOM pointer', async () => {
  const recorder = await readFile(recorderPath, 'utf8');
  assert.match(recorder, /x11grab/);
  assert.doesNotMatch(recorder, /demo-cursor/);
  assert.ok(recorder.indexOf("await showIntro(page") < recorder.indexOf('await startCapture()'));
});

test('recorder validates its safety, encoding, and outcome contract', () => {
  const result = spawnSync(process.execPath, ['demo/record.mjs', '--validate'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const validation = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(validation, {
    canvas: '1600x900@30',
    codec: 'h264',
    pixelFormat: 'yuv420p',
    fastStart: true,
    gif: '800x450@10:80',
    recording: 'live Chromium window via X11 display capture',
    nativePointer: true,
    stableFirstFrame: true,
    host: '127.0.0.1',
    temporaryWorkspace: true,
    sourcePathGate: true,
    browserOutcomeCheck: true,
    fileOutcomeCheck: true,
    modelUse: 'none',
  });
});

test('failed recording preserves published media and removes its workspace', async (t) => {
  const isolatedTemp = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-failure-test-'));
  t.after(() => rm(isolatedTemp, { recursive: true, force: true }));
  const before = createHash('sha256').update(await readFile(videoPath)).digest('hex');

  const result = spawnSync(process.execPath, ['demo/record.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: isolatedTemp,
      ASTRO_WYSIWYG_DEMO_FORCE_FAILURE: '1',
    },
    timeout: 120_000,
  });

  assert.notEqual(result.status, 0);
  const after = createHash('sha256').update(await readFile(videoPath)).digest('hex');
  assert.equal(after, before);
  assert.deepEqual(await readdir(isolatedTemp), []);
});
