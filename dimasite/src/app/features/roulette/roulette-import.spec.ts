import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseImport } from './roulette-import.ts';

test('reads a comma list as one slot each, weight 1', () => {
  const r = parseImport('prize1, prize2, prize3');
  assert.equal(r.format, 'list');
  assert.deepEqual(r.rows, [
    { label: 'prize1', weight: 1, count: 1 },
    { label: 'prize2', weight: 1, count: 1 },
    { label: 'prize3', weight: 1, count: 1 },
  ]);
  assert.equal(r.copies, 3);
});

test('repeated names become more slots of the same prize', () => {
  const r = parseImport('prize1, prize1, prize 2, prize 3');
  assert.deepEqual(r.rows, [
    { label: 'prize1', weight: 1, count: 2 },
    { label: 'prize 2', weight: 1, count: 1 },
    { label: 'prize 3', weight: 1, count: 1 },
  ]);
  assert.equal(r.copies, 4);
});

test('reads one name per line, mixed with commas, ignoring blanks', () => {
  const r = parseImport('﻿prize1\r\nprize2, prize3\n\n prize1 \n,');
  assert.equal(r.format, 'list');
  assert.deepEqual(
    r.rows.map((x) => [x.label, x.count]),
    [
      ['prize1', 2],
      ['prize2', 1],
      ['prize3', 1],
    ],
  );
});

test('one name per line only', () => {
  const r = parseImport('a\nb\na\n');
  assert.equal(r.format, 'list');
  assert.deepEqual(
    r.rows.map((x) => [x.label, x.count]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );
});

test('a single line of numbers stays a list', () => {
  assert.equal(detectFormat('1, 2, 3'), 'list');
  assert.equal(parseImport('1, 2, 3').copies, 3);
});

test('reads CSV name, weight, count with a header', () => {
  const r = parseImport('name,weight,count\nVIP,5,2\n"Pick, the game",1,3\nMystery,,\nHug');
  assert.equal(r.format, 'table');
  assert.deepEqual(r.rows, [
    { label: 'VIP', weight: 5, count: 2 },
    { label: 'Pick, the game', weight: 1, count: 3 },
    { label: 'Mystery', weight: 1, count: 1 },
    { label: 'Hug', weight: 1, count: 1 },
  ]);
  assert.equal(r.copies, 7);
});

test('reads CSV without a header and merges same name + weight', () => {
  const r = parseImport('VIP,2,1\nVIP,2,3\nVIP,4');
  assert.equal(r.format, 'table');
  assert.deepEqual(r.rows, [
    { label: 'VIP', weight: 2, count: 4 },
    { label: 'VIP', weight: 4, count: 1 },
  ]);
});

test('accepts semicolon CSV and Spanish headers', () => {
  const r = parseImport('nombre;peso;cantidad\nPremio;3;2');
  assert.deepEqual(r.rows, [{ label: 'Premio', weight: 3, count: 2 }]);
});

test('skips bad rows in table mode', () => {
  const r = parseImport('a,1,1\nb,0,1\nc,1.5,1\nd,1,20000', 'table');
  assert.deepEqual(
    r.rows.map((x) => x.label),
    ['a'],
  );
  assert.equal(r.skipped, 3);
});

test('can force list mode on CSV-looking text', () => {
  const r = parseImport('a,1\nb,2', 'list');
  assert.deepEqual(
    r.rows.map((x) => x.label),
    ['a', '1', 'b', '2'],
  );
});

test('skips names longer than 120 characters', () => {
  const r = parseImport(`ok, ${'x'.repeat(121)}`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped, 1);
});
