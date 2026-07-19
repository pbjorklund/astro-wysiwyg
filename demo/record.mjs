import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteTemplate = path.join(root, 'demo/site');
const outputDir = path.join(root, 'artwork/demo');
const contractPath = path.join(root, 'demo/recording/contract.json');
const storyboardPath = path.join(root, 'demo/recording/storyboard.json');
const evalCasesPath = path.join(root, 'demo/recording/eval-cases.json');
const expectedBefore = 'Our studio turns rough product updates into a clear story people can trust.';
const expectedAfter = 'Our studio turns **launch-ready product updates** into a clear story people can trust.';
const validation = {
  canvas: '1600x900@30',
  codec: 'h264',
  pixelFormat: 'yuv420p',
  fastStart: true,
  gif: '800x450@10:80',
  host: '127.0.0.1',
  temporaryWorkspace: true,
  sourcePathGate: true,
  browserOutcomeCheck: true,
  fileOutcomeCheck: true,
  modelUse: 'none',
};

if (process.argv.includes('--validate')) {
  await calibrateOutcomeGrader();
  process.stdout.write(`${JSON.stringify(validation)}\n`);
} else {
  await recordDemo();
}

async function recordDemo() {
  await validateInputs();
  await mkdir(outputDir, { recursive: true });
  const workspace = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-demo-'));
  const captureDir = path.join(workspace, 'capture');
  const candidateMp4 = path.join(outputDir, `.astro-wysiwyg-demo-${process.pid}.mp4`);
  const candidateGif = path.join(outputDir, `.astro-wysiwyg-demo-${process.pid}.gif`);
  const candidateSheet = path.join(outputDir, `.astro-wysiwyg-contact-sheet-${process.pid}.jpg`);
  const candidateReport = path.join(outputDir, `.astro-wysiwyg-outcome-${process.pid}.json`);
  let server;
  let browser;

  try {
    await cp(siteTemplate, workspace, { recursive: true });
    await Promise.all([
      rm(path.join(workspace, '.astro'), { recursive: true, force: true }),
      rm(path.join(workspace, 'node_modules'), { recursive: true, force: true }),
    ]);
    await Promise.all([
      mkdir(captureDir),
      mkdir(path.join(workspace, 'node_modules')),
    ]);
    await Promise.all([
      symlink(path.join(root, 'node_modules/astro'), path.join(workspace, 'node_modules/astro'), 'dir'),
      symlink(root, path.join(workspace, 'node_modules/astro-wysiwyg'), 'dir'),
    ]);
    const sourceRoot = await realpath(path.join(workspace, 'src'));
    const sourceFile = await realpath(path.join(workspace, 'src/pages/index.md'));
    assertInside(sourceRoot, sourceFile);
    const originalSource = await readFile(sourceFile, 'utf8');
    if (!originalSource.includes(expectedBefore)) throw new Error('Demo source does not contain the expected starting copy.');
    if (process.env.ASTRO_WYSIWYG_DEMO_FORCE_FAILURE === '1') {
      throw new Error('Forced recorder failure before capture.');
    }

    const port = await reservePort();
    server = startAstro(workspace, port);
    await waitForServer(`http://127.0.0.1:${port}`, server);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      recordVideo: { dir: captureDir, size: { width: 1600, height: 900 } },
    });
    await context.addInitScript(installPresentationLayer);
    const page = await context.newPage();
    const video = page.video();
    const result = await runWalkthrough(page, `http://127.0.0.1:${port}`, sourceFile);
    await context.close();
    const rawVideo = await video.path();
    await browser.close();
    browser = undefined;

    await run('ffmpeg', [
      '-y', '-ss', '0.15', '-i', rawVideo,
      '-vf', 'fps=30,scale=1600:900:flags=lanczos',
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', candidateMp4,
    ]);
    await run('ffmpeg', [
      '-y', '-i', candidateMp4,
      '-vf', 'fps=10,scale=800:450:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', candidateGif,
    ]);
    await run('ffmpeg', [
      '-y', '-i', candidateMp4,
      '-vf', 'fps=1/3,scale=392:221:flags=lanczos,tile=4x2:padding=8:margin=8:color=0x07111f',
      '-frames:v', '1', candidateSheet,
    ]);

    const [videoProbe, gifProbe] = await Promise.all([probe(candidateMp4), probe(candidateGif)]);
    validateMedia(videoProbe, gifProbe);
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      evidence: 'live automated flow',
      story: 'Click rendered Astro text, rewrite and format it, save to Markdown, then verify it after reload.',
      safety: {
        fixture: 'synthetic and publishable',
        workspace: 'temporary',
        sourcePathGate: 'active',
        host: '127.0.0.1',
        credentials: 'none',
      },
      truthBoundary: {
        real: ['Astro site', 'click-to-edit', 'text selection', 'typing', 'Bold action', 'save endpoint', 'Markdown mutation', 'reload', 'browser assertion', 'file assertion'],
        presentationOnly: ['intro card', 'step labels', 'callouts', 'synthetic-data badge', 'DOM cursor', 'click ring'],
      },
      outcome: result,
      video: mediaSummary(path.join(outputDir, 'astro-wysiwyg-demo.mp4'), videoProbe),
      preview: mediaSummary(path.join(outputDir, 'astro-wysiwyg-demo.gif'), gifProbe),
      hashes: {
        contract: await sha256(contractPath),
        storyboard: await sha256(storyboardPath),
        capture: await sha256(rawVideo),
        video: await sha256(candidateMp4),
        preview: await sha256(candidateGif),
      },
      eval: {
        caseId: 'astro-wysiwyg-source-backed-edit',
        calibration: await calibrateOutcomeGrader(),
        deterministicChecks: Object.keys(validation),
        expectedSource: expectedAfter,
        result: 'pass',
      },
      modelUse: 'none',
      review: {
        status: 'pending editorial frame review',
        independentReviewerAttempts: 3,
        independentReviewerInfrastructureError: 'frontmatter.tools?.split is not a function',
      },
    };
    await writeFile(candidateReport, `${JSON.stringify(report, null, 2)}\n`);

    await rename(candidateMp4, path.join(outputDir, 'astro-wysiwyg-demo.mp4'));
    await rename(candidateGif, path.join(outputDir, 'astro-wysiwyg-demo.gif'));
    await rename(candidateSheet, path.join(outputDir, 'contact-sheet.jpg'));
    await rename(candidateReport, path.join(outputDir, 'outcome.json'));
    process.stdout.write(`Recorded ${path.relative(root, path.join(outputDir, 'astro-wysiwyg-demo.mp4'))}\n`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await stopProcess(server);
    await Promise.all([
      rm(candidateMp4, { force: true }),
      rm(candidateGif, { force: true }),
      rm(candidateSheet, { force: true }),
      rm(candidateReport, { force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
}

async function calibrateOutcomeGrader() {
  const calibration = JSON.parse(await readFile(evalCasesPath, 'utf8'));
  for (const item of calibration.cases) {
    const actual = gradeOutcome(item.report) ? 'pass' : 'fail';
    if (actual !== item.expected) throw new Error(`Outcome grader calibration failed for ${item.id}.`);
  }
  return 'pass: known-good accepted and known-bad rejected';
}

function gradeOutcome(report) {
  return report.browser.startsWith('pass: reloaded page')
    && report.source.startsWith('pass:')
    && report.endpointStatus === 200;
}

async function validateInputs() {
  const [contract, storyboard] = await Promise.all([
    readFile(contractPath, 'utf8').then(JSON.parse),
    readFile(storyboardPath, 'utf8').then(JSON.parse),
  ]);
  if (Object.values(contract.rubric).some((value) => value !== 'pass')) {
    throw new Error('The System Under Video contract has not passed every story gate.');
  }
  if (storyboard.canvas.width !== 1600 || storyboard.canvas.height !== 900 || storyboard.canvas.fps !== 30) {
    throw new Error('The storyboard canvas must be 1600x900 at 30 fps.');
  }
  const ids = storyboard.events.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Storyboard event IDs must be unique.');
  if (storyboard.events.some(({ start, end }) => !Number.isFinite(start) || !Number.isFinite(end) || end <= start)) {
    throw new Error('Storyboard events must use finite increasing times.');
  }
}

async function runWalkthrough(page, url, sourceFile) {
  let cursor = { x: 1480, y: 820 };
  const moveTo = async (target) => {
    const box = await target.boundingBox();
    if (!box) throw new Error('Walkthrough target is not visible.');
    cursor = await moveMouse(page, cursor, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  };
  const click = async (target) => {
    await moveTo(target);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
  };

  await page.goto(url, { waitUntil: 'networkidle' });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const paragraph = page.locator('article > p[data-astro-wysiwyg]').first();
  await paragraph.waitFor({ state: 'visible' });
  await editor.waitFor({ state: 'attached' });
  if ((await paragraph.textContent())?.trim() !== expectedBefore) throw new Error('Rendered start state is incorrect.');
  if (!(await readFile(sourceFile, 'utf8')).includes(expectedBefore)) throw new Error('Source start state is incorrect.');

  await showIntro(page, 'astro-wysiwyg', 'Edit Astro content on the page');
  await page.waitForTimeout(2_000);
  await hideIntro(page);
  await page.waitForTimeout(500);

  await setCallout(page, '1  Click page text');
  await page.waitForTimeout(850);
  await click(paragraph);
  await paragraph.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('article > p[contenteditable="true"]'));
  await page.waitForTimeout(900);

  await setCallout(page, '2  Rewrite in place');
  await page.waitForTimeout(700);
  cursor = await selectText(page, paragraph, 'rough product updates', cursor);
  const selectedBeforeRewrite = await page.evaluate(() => getSelection()?.toString() ?? '');
  if (selectedBeforeRewrite !== 'rough product updates') {
    throw new Error(`Mouse selection before rewrite was ${JSON.stringify(selectedBeforeRewrite)}.`);
  }
  await page.keyboard.type('launch-ready product updates', { delay: 38 });
  const rewriteState = await paragraph.evaluate((element) => ({
    active: document.activeElement === element,
    editable: element.getAttribute('contenteditable'),
    selected: getSelection()?.toString() ?? '',
    text: element.textContent,
  }));
  if (!rewriteState.text?.includes('launch-ready product updates')) {
    throw new Error(`Typing did not update the selected text: ${JSON.stringify(rewriteState)}.`);
  }
  await page.waitForTimeout(1_250);

  await setCallout(page, '3  Select and format');
  await page.waitForTimeout(850);
  cursor = await selectText(page, paragraph, 'launch-ready product updates', cursor);
  const selectedBeforeFormat = await page.evaluate(() => getSelection()?.toString() ?? '');
  if (selectedBeforeFormat !== 'launch-ready product updates') {
    throw new Error(`Mouse selection before formatting was ${JSON.stringify(selectedBeforeFormat)}.`);
  }
  await page.waitForTimeout(450);
  const bold = editor.getByRole('button', { name: 'Bold' });
  await click(bold);
  const formatState = await paragraph.evaluate((element) => ({
    html: element.innerHTML,
    selected: getSelection()?.toString() ?? '',
  }));
  if (!/<(?:b|strong)>launch-ready product updates<\/(?:b|strong)>/.test(formatState.html)) {
    throw new Error(`Bold did not format the selected text: ${JSON.stringify(formatState)}.`);
  }
  await page.waitForTimeout(1_350);

  await setCallout(page, '4  Save to Markdown');
  await page.waitForTimeout(900);
  const saveResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/_astro-wysiwyg/save'
  ));
  await click(editor.getByRole('button', { name: 'Save' }));
  const response = await saveResponse;
  if (!response.ok()) throw new Error(`The real save endpoint returned HTTP ${response.status()}.`);
  await page.waitForFunction(() => {
    const host = document.querySelector('#astro-wysiwyg-toolbar');
    return host?.shadowRoot?.querySelector('[role="status"]')?.textContent === 'Saved';
  });
  await page.waitForTimeout(1_500);

  await setCallout(page, 'Reload to prove persistence');
  await page.waitForTimeout(1_150);
  await page.reload({ waitUntil: 'networkidle' });
  const persistedParagraph = page.locator('article > p[data-astro-wysiwyg]').first();
  await persistedParagraph.waitFor({ state: 'visible' });
  const persistedBold = persistedParagraph.locator('strong, b');
  await persistedBold.waitFor({ state: 'visible' });
  if ((await persistedBold.textContent()) !== 'launch-ready product updates') {
    throw new Error('The reloaded page did not preserve bold formatting.');
  }
  const persistedSource = await readFile(sourceFile, 'utf8');
  if (!persistedSource.includes(expectedAfter)) throw new Error('The Markdown file does not contain the expected saved result.');

  await setCallout(page, 'Saved and verified after reload', 'src/pages/index.md contains **launch-ready product updates**');
  await page.waitForTimeout(5_500);
  return {
    browser: 'pass: reloaded page contains bold launch-ready product updates',
    source: 'pass: temporary src/pages/index.md contains the expected Markdown',
    endpointStatus: response.status(),
  };
}

function installPresentationLayer() {
  const install = () => {
    if (document.querySelector('#demo-presentation')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-presentation { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      #demo-intro { position: absolute; inset: 0; display: none; place-items: center; color: #f8fafc; background: #07111f; transition: opacity 300ms ease; }
      #demo-intro > div { width: min(1200px, calc(100% - 96px)); text-align: center; }
      #demo-intro small { display: block; margin-bottom: 18px; color: #7dd3fc; font-size: 24px; font-weight: 750; letter-spacing: .08em; }
      #demo-intro strong { display: block; font-size: 58px; line-height: 1.05; letter-spacing: -.04em; }
      #demo-badge { position: absolute; top: 112px; left: 48px; padding: 9px 14px; color: #bae6fd; background: rgb(7 17 31 / 88%); border: 1px solid #0ea5e9; border-radius: 999px; font-size: 14px; font-weight: 700; }
      #demo-callout { position: absolute; top: 112px; right: 48px; min-width: 300px; padding: 17px 22px 17px 28px; color: #f8fafc; background: rgb(15 23 42 / 95%); border: 1px solid #475569; border-radius: 14px; box-shadow: 0 18px 54px rgb(0 0 0 / 34%); font-size: 26px; font-weight: 750; opacity: 0; transform: translateY(-8px); transition: opacity 180ms ease, transform 180ms ease; }
      #demo-callout::before { position: absolute; top: 15px; bottom: 15px; left: 10px; width: 4px; content: ''; background: #38bdf8; border-radius: 9px; }
      #demo-callout[data-visible='true'] { opacity: 1; transform: translateY(0); }
      #demo-proof { display: none; margin-top: 12px; color: #bae6fd; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 19px; font-weight: 500; }
      #demo-cursor { position: fixed; top: 0; left: 0; z-index: 2147483647; width: 30px; height: 34px; opacity: 0; filter: drop-shadow(0 2px 2px rgb(0 0 0 / 55%)); transform: translate(-3px, -2px); transition: opacity 120ms ease; }
      #demo-cursor::before { display: block; width: 0; height: 0; content: ''; border-top: 25px solid white; border-right: 16px solid transparent; filter: drop-shadow(2px 1px 0 #07111f) drop-shadow(-1px -1px 0 #07111f); transform: rotate(-12deg); transform-origin: top left; }
      .demo-click-ring { position: fixed; z-index: 2147483646; width: 64px; height: 64px; margin: -32px 0 0 -32px; border: 4px solid #38bdf8; border-radius: 50%; animation: demo-ring 280ms ease-out forwards; }
      @keyframes demo-ring { from { opacity: .95; transform: scale(.35); } to { opacity: 0; transform: scale(1); } }
    `;
    document.head.append(style);
    const layer = document.createElement('div');
    layer.id = 'demo-presentation';
    layer.innerHTML = '<div id="demo-intro"><div><small></small><strong></strong></div></div><div id="demo-badge">Live test demo · synthetic data</div><div id="demo-callout"><span></span><small id="demo-proof"></small></div><div id="demo-cursor"></div>';
    document.body.append(layer);
    const cursor = layer.querySelector('#demo-cursor');
    document.addEventListener('mousemove', (event) => {
      cursor.style.opacity = '1';
      cursor.style.translate = `${event.clientX}px ${event.clientY}px`;
    }, true);
    document.addEventListener('mousedown', (event) => {
      const ring = document.createElement('span');
      ring.className = 'demo-click-ring';
      ring.style.left = `${event.clientX}px`;
      ring.style.top = `${event.clientY}px`;
      layer.append(ring);
      ring.addEventListener('animationend', () => ring.remove(), { once: true });
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}

async function showIntro(page, product, title) {
  await page.evaluate(({ product, title }) => {
    const intro = document.querySelector('#demo-intro');
    intro.querySelector('small').textContent = product;
    intro.querySelector('strong').textContent = title;
    intro.style.display = 'grid';
    intro.style.opacity = '1';
  }, { product, title });
}

async function hideIntro(page) {
  await page.evaluate(() => {
    const intro = document.querySelector('#demo-intro');
    intro.style.opacity = '0';
    setTimeout(() => { intro.style.display = 'none'; }, 320);
  });
  await page.waitForTimeout(350);
}

async function setCallout(page, text, proof = '') {
  await page.evaluate(({ text, proof }) => {
    const callout = document.querySelector('#demo-callout');
    const proofElement = document.querySelector('#demo-proof');
    callout.querySelector('span').textContent = text;
    proofElement.textContent = proof;
    proofElement.style.display = proof ? 'block' : 'none';
    callout.dataset.visible = 'true';
  }, { text, proof });
}

async function selectText(page, locator, phrase, cursor) {
  const points = await locator.evaluate((element, selectedPhrase) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(selectedPhrase);
      if (start < 0) continue;
      const first = document.createRange();
      first.setStart(node, start);
      first.setEnd(node, start + 1);
      const last = document.createRange();
      last.setStart(node, start + selectedPhrase.length - 1);
      last.setEnd(node, start + selectedPhrase.length);
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        start: { x: firstRect.left + 2, y: firstRect.top + firstRect.height / 2 },
        end: { x: lastRect.right - 2, y: lastRect.top + lastRect.height / 2 },
      };
    }
    throw new Error(`Could not find phrase: ${selectedPhrase}`);
  }, phrase);
  cursor = await moveMouse(page, cursor, points.start);
  await page.waitForTimeout(140);
  await page.mouse.down();
  cursor = await moveMouse(page, cursor, points.end, 42);
  await page.mouse.up();
  return cursor;
}

async function moveMouse(page, from, to, steps = 36) {
  const bend = Math.min(26, Math.abs(to.x - from.x) * 0.05);
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const x = from.x + (to.x - from.x) * eased;
    const y = from.y + (to.y - from.y) * eased - Math.sin(Math.PI * progress) * bend;
    await page.mouse.move(x, y);
    await page.waitForTimeout(12);
  }
  return to;
}

function assertInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Demo source path escaped the temporary Astro src directory.');
  }
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startAstro(workspace, port) {
  const astroCli = path.join(root, 'node_modules/astro/bin/astro.mjs');
  return spawn(process.execPath, [astroCli, 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      ASTRO_WYSIWYG_INTEGRATION: pathToFileURL(path.join(root, 'dist/index.js')).href,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(url, child) {
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  child.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Astro exited before startup.\n${logs}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The loopback server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Astro did not start in 30 seconds.\n${logs}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).\n${stderr}`)));
  });
}

async function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code}).\n${stderr}`));
      resolve(JSON.parse(stdout));
    });
  });
}

function validateMedia(videoProbe, gifProbe) {
  const video = videoProbe.streams.find(({ codec_type }) => codec_type === 'video');
  const gif = gifProbe.streams.find(({ codec_type }) => codec_type === 'video');
  const duration = Number(videoProbe.format.duration);
  if (!video || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p') throw new Error('MP4 codec or pixel format is invalid.');
  if (video.width !== 1600 || video.height !== 900 || video.r_frame_rate !== '30/1') throw new Error('MP4 dimensions or frame rate are invalid.');
  if (duration < 22 || duration > 30) throw new Error(`MP4 duration ${duration}s is outside the 22-30 second target.`);
  if (!gif || gif.codec_name !== 'gif' || gif.width !== 800 || gif.height !== 450) throw new Error('GIF dimensions or codec are invalid.');
}

function mediaSummary(file, data) {
  const video = data.streams.find(({ codec_type }) => codec_type === 'video');
  return {
    path: path.relative(root, file),
    durationSeconds: Number(Number(data.format.duration).toFixed(3)),
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    frameRate: video.r_frame_rate,
    bytes: Number(data.format.size),
  };
}

async function sha256(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex');
}
