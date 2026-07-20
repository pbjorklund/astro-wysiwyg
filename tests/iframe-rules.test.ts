import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IframeRuleError,
  normalizeIframeOrigins,
  validateIframeFields,
  validateIframeUrl,
} from '../src/iframe-rules.ts';

const fields = {
  src: '/embed-preview',
  title: 'Project status embed',
  width: 640,
  height: 360,
  loading: 'lazy' as const,
  referrerPolicy: 'strict-origin-when-cross-origin' as const,
  allow: ['fullscreen', 'autoplay'],
  sandbox: ['allow-scripts'],
  allowFullscreen: true,
};

test('normalizes conservative self and exact HTTPS iframe origins', () => {
  assert.deepEqual(normalizeIframeOrigins(), ['self']);
  assert.deepEqual(
    normalizeIframeOrigins(['self', 'https://www.youtube-nocookie.com', 'self']),
    ['self', 'https://www.youtube-nocookie.com'],
  );
  for (const origins of [[], ['*'], ['http://example.com'], ['https://example.com/path'], ['not a url']]) {
    assert.throws(() => normalizeIframeOrigins(origins), IframeRuleError);
  }
});

test('validates iframe URLs, fields, dimensions, and deterministic token order', () => {
  assert.equal(validateIframeUrl('/embed-preview', ['self']), '/embed-preview');
  assert.equal(validateIframeUrl('/', ['self']), '/');
  assert.equal(
    validateIframeUrl('https://player.example.com/embed/1', ['https://player.example.com']),
    'https://player.example.com/embed/1',
  );
  assert.deepEqual(validateIframeFields(fields, ['self']), {
    ...fields,
    allow: ['autoplay', 'fullscreen'],
  });
});

test('rejects unsafe schemes, providers, attributes, and playback policies', () => {
  for (const src of [
    '', 'a'.repeat(2_001), '/embed\u0000preview', '/embed preview', '/embed\\preview',
    'javascript:alert(1)', 'data:text/html,test', 'http://example.com/embed', '//example.com/embed', ':bad',
    '/not/../safe', '/embed?token=x', '/embed%2fpreview', 'https://user:pass@example.com/embed', 'https://unapproved.example/embed',
  ]) assert.throws(() => validateIframeUrl(src, ['self', 'https://example.com']), IframeRuleError);

  for (const patch of [
    { title: '' }, { width: 0 }, { width: 4_097 }, { width: 1.5 }, { height: 0 },
    { loading: 'automatic' }, { referrerPolicy: 'unsafe-url' },
    { allow: ['payment'] }, { allow: ['camera'] },
    { sandbox: ['allow-top-navigation'] }, { sandbox: ['allow-popups-to-escape-sandbox'] },
    { sandbox: ['allow-scripts', 'allow-same-origin'] },
    { allow: 'fullscreen' },
  ]) assert.throws(
    () => validateIframeFields({ ...fields, ...patch } as never, ['self']),
    IframeRuleError,
  );
});
