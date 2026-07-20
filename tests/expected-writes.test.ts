import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpectedTextFileWrites } from '../src/expected-writes.ts';

test('keeps repeated matching file notifications suppressible until an external change', () => {
  const writes = new ExpectedTextFileWrites();
  assert.equal(writes.has('/site/page.md'), false);
  writes.add('/site/page.md', 'Same source');
  writes.add('/site/page.md', 'Same source');
  assert.equal(writes.has('/site/page.md'), true);

  assert.equal(writes.match('/site/page.md', 'Same source'), true);
  writes.add('/site/page.md', 'Same source');
  assert.equal(writes.match('/site/page.md', 'Same source'), true);
  assert.equal(writes.match('/site/page.md', 'Same source'), true);
  assert.equal(writes.match('/site/page.md', 'External source'), false);
  assert.equal(writes.match('/site/page.md', 'Same source'), false);
});

test('matches a coalesced final write and consumes skipped intermediate sources', () => {
  const writes = new ExpectedTextFileWrites();
  writes.add('/site/page.md', 'First source');
  writes.add('/site/page.md', 'Second source');
  writes.add('/site/page.md', 'Final source');

  assert.equal(writes.match('/site/page.md', 'Final source'), true);
  assert.equal(writes.match('/site/page.md', 'Final source'), true);
  assert.equal(writes.match('/site/page.md', 'External source'), false);
});

test('discards expected writes after a read failure', () => {
  const writes = new ExpectedTextFileWrites();
  writes.add('/site/page.md', 'Editor source');

  writes.discard('/site/page.md');

  assert.equal(writes.match('/site/page.md', 'Editor source'), false);
});

test('releases the queue when an external source does not match', () => {
  const writes = new ExpectedTextFileWrites();
  writes.add('/site/page.md', 'Editor source');

  assert.equal(writes.match('/site/page.md', 'External source'), false);
  assert.equal(writes.match('/site/page.md', 'Editor source'), false);
});

test('tracks expected writes independently by canonical file path', () => {
  const writes = new ExpectedTextFileWrites();
  writes.add('/site/first.md', 'First source');
  writes.add('/site/second.md', 'Second source');

  assert.equal(writes.match('/site/first.md', 'First source'), true);
  assert.equal(writes.match('/site/second.md', 'Second source'), true);
});
