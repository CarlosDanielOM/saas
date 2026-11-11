import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTextDelta } from './assistant-text';

test('appends at the expected offset', () => {
  assert.equal(applyTextDelta('Hello', ' world', 5), 'Hello world');
  assert.equal(applyTextDelta('', 'Hi', 0), 'Hi');
});

test('a replayed delta the text already contains changes nothing', () => {
  assert.equal(applyTextDelta('Hi there', 'Hi', 0), 'Hi there');
  assert.equal(applyTextDelta('Hello world', ' world', 5), 'Hello world');
});

test('a partly covered delta replaces the tail from its offset', () => {
  assert.equal(applyTextDelta('Hello wo', ' world', 5), 'Hello world');
});

test('text missing before the offset is a gap (resync)', () => {
  assert.equal(applyTextDelta('Hel', ' world', 5), null);
});

test('old servers without offsets still append', () => {
  assert.equal(applyTextDelta('a', 'b', undefined), 'ab');
});
