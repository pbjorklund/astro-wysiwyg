import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [tarballArgument, astroVersion] = process.argv.slice(2);
if (!tarballArgument || !astroVersion) {
  throw new Error('Usage: node tests/compatibility.mjs <package.tgz> <astro-version>');
}

const tarball = path.resolve(tarballArgument);
const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-compatibility-'));
const pageFile = path.join(root, 'src/pages/index.astro');
const markdownFile = path.join(root, 'src/pages/markdown.md');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let server;

try {
  await mkdir(path.dirname(pageFile), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        astro: astroVersion,
        'astro-wysiwyg': `file:${tarball}`,
      },
    }, null, 2)),
    writeFile(path.join(root, 'astro.config.mjs'), `
import { defineConfig } from 'astro/config';
import wysiwyg from 'astro-wysiwyg';

export default defineConfig({ integrations: [wysiwyg()] });
`),
    writeFile(pageFile, '<p>Compatibility smoke</p>\n'),
    writeFile(markdownFile, '# Markdown compatibility\n'),
  ]);

  await run(npm, ['install', '--no-audit', '--no-fund'], root);
  const astroPackageRoot = path.join(root, 'node_modules/astro');
  const astroPackage = JSON.parse(await readFile(path.join(astroPackageRoot, 'package.json'), 'utf8'));
  const astroCli = path.join(astroPackageRoot, astroPackage.bin.astro);
  server = spawn(process.execPath, [
    astroCli, 'dev', '--host', '127.0.0.1', '--port', '4329',
  ], {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(server);
  await waitForServer(server, output);

  const pageResponse = await fetch('http://127.0.0.1:4329/');
  assert.equal(pageResponse.status, 200);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Compatibility smoke/);
  assert.match(pageHtml, /data-astro-source-file=/);

  const markdownResponse = await fetch('http://127.0.0.1:4329/markdown');
  assert.equal(markdownResponse.status, 200);
  assert.match(await markdownResponse.text(), /<h1 data-astro-wysiwyg=/);

  const resolved = await post({
    sourceFile: pageFile,
    sourceLocation: '1:2',
  });
  assert.equal(resolved.response.status, 200, resolved.body.error);
  assert.equal(typeof resolved.body.marker, 'string');

  const saved = await post({
    marker: resolved.body.marker,
    html: 'Compatibility updated',
    tag: 'p',
  });
  assert.equal(saved.response.status, 200, saved.body.error);
  assert.equal(await readFile(pageFile, 'utf8'), '<p>Compatibility updated</p>\n');

  await stopServer(server);
  server = undefined;
  await run(process.execPath, [astroCli, 'build'], root);
} finally {
  if (server) await stopServer(server);
  await rm(root, { recursive: true, force: true });
}

async function post(payload) {
  const response = await fetch('http://127.0.0.1:4329/_astro-wysiwyg/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `${command} ${args.join(' ')} failed (${signal ?? code})\n${output.text}`);
}

function collectOutput(child) {
  const output = { text: '' };
  child.stdout?.on('data', (chunk) => { output.text += chunk; });
  child.stderr?.on('data', (chunk) => { output.text += chunk; });
  return output;
}

async function waitForServer(child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Astro dev exited early.\n${output.text}`);
    try {
      const response = await fetch('http://127.0.0.1:4329/');
      if (response.ok) return;
    } catch {
      // Wait for Astro to bind the development port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Astro dev did not start.\n${output.text}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  let forceTimer;
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => { forceTimer = setTimeout(resolve, 5_000); }),
  ]);
  clearTimeout(forceTimer);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}
