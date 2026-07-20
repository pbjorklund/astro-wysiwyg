import assert from 'node:assert/strict';
import test from 'node:test';
import { addIframeMarkerAttributes, inspectSourceIframe, serializeIframe } from '../src/iframe-markup.ts';

const source = '<iframe src="/embed-preview" title="Project status" width="640" height="360" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin" allow="autoplay; fullscreen" allowfullscreen></iframe>';

test('recognizes and marks one static iframe with the supported schema', () => {
  assert.deepEqual(inspectSourceIframe(source), {
    src: '/embed-preview',
    title: 'Project status',
    width: 640,
    height: 360,
    loading: 'lazy',
    referrerPolicy: 'strict-origin-when-cross-origin',
    allow: ['autoplay', 'fullscreen'],
    sandbox: ['allow-scripts', 'allow-same-origin'],
    allowFullscreen: true,
  });
  assert.match(
    addIframeMarkerAttributes(source, 'safe-token')!,
    /^<iframe data-astro-wysiwyg="safe-token" data-astro-wysiwyg-iframe /,
  );
  assert.equal(inspectSourceIframe(source.replace('/embed-preview', '/'))?.src, '/');
  assert.equal(
    inspectSourceIframe(source.replace('/embed-preview', 'https://player.example.com/embed/1'))?.src,
    'https://player.example.com/embed/1',
  );
  assert.ok(inspectSourceIframe(source.replace(' allowfullscreen></iframe>', '   ></iframe>')));
  assert.ok(inspectSourceIframe(source.replace('sandbox="allow-scripts allow-same-origin"', 'sandbox =  \'allow-scripts\'')));
});

test('serializes transparent native iframe markup with escaped values and conservative fields', () => {
  assert.equal(serializeIframe({
    src: '/embed-preview',
    title: 'Status & details',
    width: 560,
    height: 315,
    loading: 'lazy',
    referrerPolicy: 'no-referrer',
    allow: [],
    sandbox: [],
    allowFullscreen: false,
  }), '<iframe src="/embed-preview" title="Status &amp; details" width="560" height="315" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>');
});

test('rejects dynamic, ambiguous, malformed, and unsupported iframe source forms', () => {
  for (const value of [
    '<iframe src="/embed-preview"></iframe>',
    '<iframe src={url} title="Dynamic" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="javascript:alert(1)" title="Unsafe" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="Duplicate" title="Again" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="Unknown" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox="" onload="alert(1)"></iframe>',
    '<iframe src="/embed-preview" title="Bad allow" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox="" allow="camera https://example.com"></iframe>',
    '<iframe src="/embed-preview" title="Bad fullscreen" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox="" allowfullscreen="true"></iframe>',
    '<iframe src="/embed-preview" title="Open" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox="">',
    'not an iframe',
    '<iframe @bad="value" src="/embed-preview" title="Bad name" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src=/embed-preview title="Unquoted" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview title="Unclosed" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="" title="No source" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="No width" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="No height" width="640" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="Bad loading" width="640" height="360" loading="auto" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="Bad policy" width="640" height="360" loading="lazy" referrerpolicy="unsafe-url" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="No policy" width="640" height="360" loading="lazy" sandbox=""></iframe>',
    '<iframe src="/embed-preview" title="No sandbox" width="640" height="360" loading="lazy" referrerpolicy="no-referrer"></iframe>',
    '<iframe src="/embed-preview" title="Bad equals" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=></iframe>',
    '<iframe src="/embed-preview" title="Unclosed single quote" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=\'allow-scripts></iframe>',
    '<iframe src="/embed-preview" title="Bad sandbox" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox="ALLOW-SCRIPTS"></iframe>',
    '<iframe src="/path/../embed" title="Traversal" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src=":bad" title="Invalid URL" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="http://example.com/embed" title="HTTP" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
    '<iframe src="https://user:pass@example.com/embed" title="Credentials" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>',
  ]) {
    assert.equal(inspectSourceIframe(value), undefined, value);
    assert.equal(addIframeMarkerAttributes(value, 'token'), undefined, value);
  }
});
