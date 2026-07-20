import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addVideoMarkerAttributes,
  inspectSourceVideoFigure,
  replaceSourceVideoFigure,
} from '../src/video-markup.ts';

const figure = `<figure class="media">
  <video controls preload="metadata" aria-label="Original tour" poster="/assets/old.png" muted loop playsinline class="player">
    <source src="/assets/old.mp4" type="video/mp4" data-quality="main" />
    <track kind="captions" src="/assets/captions.vtt" srclang="en" label="English" default />
    <a href="/assets/old.mp4" download>Keep this fallback label</a>.
  </video>
  <figcaption class="caption">Original visible description.</figcaption>
</figure>`;

test('recognizes one static accessible native video figure', () => {
  assert.deepEqual(inspectSourceVideoFigure(figure), {
    src: '/assets/old.mp4',
    label: 'Original tour',
    description: 'Original visible description.',
    poster: '/assets/old.png',
    controls: true,
    preload: 'metadata',
    muted: true,
    loop: true,
    autoplay: false,
  });
  assert.match(addVideoMarkerAttributes(figure, 'safe-token')!, /^<figure class="media" data-astro-wysiwyg="safe-token" data-astro-wysiwyg-video>/);
  const spaced = '<figure><video controls preload = "metadata" aria-label = "Tour"><source src = "/a.mp4" type = "video/mp4" /></video><figcaption>Tour</figcaption></figure>';
  assert.equal(inspectSourceVideoFigure(spaced)?.src, '/a.mp4');
});

test('replaces supported fields while preserving tracks, fallback content, and compatible attributes', () => {
  const replaced = replaceSourceVideoFigure(figure, {
    src: '/media/new.mp4',
    label: 'New & improved tour',
    description: 'A new <silent> tour.',
    controls: true,
    preload: 'none',
    muted: true,
    loop: false,
    autoplay: true,
  });

  assert.ok(replaced);
  assert.match(replaced, /<figure class="media">/);
  assert.match(replaced, /<video controls preload="none" aria-label="New &amp; improved tour" muted playsinline class="player" autoplay>/);
  assert.match(replaced, /<source src="\/media\/new\.mp4" type="video\/mp4" data-quality="main" \/>/);
  assert.match(replaced, /<track kind="captions" src="\/assets\/captions\.vtt" srclang="en" label="English" default \/>/);
  assert.match(replaced, /<a href="\/media\/new\.mp4" download>Keep this fallback label<\/a>/);
  assert.match(replaced, /<figcaption class="caption">A new &lt;silent&gt; tour\.<\/figcaption>/);
  assert.doesNotMatch(replaced, /poster=/);
  assert.doesNotMatch(replaced, /\sloop(?:\s|>)/);
  assert.equal(replaceSourceVideoFigure(figure, {
    src: '/media/new.mp4',
    label: 'Invalid autoplay',
    description: 'Autoplay without muted playback.',
    controls: true,
    preload: 'metadata',
    muted: false,
    loop: false,
    autoplay: true,
  }), undefined);
});

test('rejects ambiguous, dynamic, inaccessible, remote, and incompatible video figures', () => {
  const invalid = [
    '<video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video></figure>',
    '<figure><video preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="https://example.com/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src={clip} type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.webm" type="video/webm" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /><source src="/b.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour" autoplay><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption><strong>Nested</strong></figcaption></figure>',
    '<figure class="one" class="two"><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /><video controls preload="metadata" aria-label="Other"><source src="/b.mp4" type="video/mp4" /></video></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="eager" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour" poster="https://example.com/poster.png"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption></figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source {bad} /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload = "metadata" aria-label = "Tour"><source src = "/a.mp4" type = "video/mp4" /></video><figcaption>Tour</figcaption></figure',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4 type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour',
    '<figure><video controls preload="metadata" aria-label="Tour"><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figure>',
    '<figure><video controls preload="metadata" aria-label="Tour" data-note="unterminated><source src="/a.mp4" type="video/mp4" /></video><figcaption>Tour</figcaption></figure>',
    '<figure',
    '<figure   ',
    '<figure x',
    '<figure x=   ',
    '<figure x="abc',
  ];
  for (const source of invalid) {
    assert.equal(inspectSourceVideoFigure(source), undefined, source);
    assert.equal(addVideoMarkerAttributes(source, 'token'), undefined, source);
  }
});
