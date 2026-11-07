import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ImportFileError, decodeText, detectFormat, parseImport, planImport, toCsv } from './roulette-import.ts';

const simple = (r: ReturnType<typeof parseImport>) => r.rows.map(({ label, weight, count, action }) => ({ label, weight, count, ...(action ? { action } : {}) }));

test('comma list: one slot each, weight 1', () => {
  const r = parseImport('prize1, prize2, prize3');
  assert.equal(r.format, 'list');
  assert.deepEqual(simple(r), [
    { label: 'prize1', weight: 1, count: 1 },
    { label: 'prize2', weight: 1, count: 1 },
    { label: 'prize3', weight: 1, count: 1 },
  ]);
  assert.equal(r.copies, 3);
});

test('list: repeated names become more slots of the same prize', () => {
  const r = parseImport('prize1, prize1, prize 2, prize 3');
  assert.deepEqual(simple(r), [
    { label: 'prize1', weight: 1, count: 2 },
    { label: 'prize 2', weight: 1, count: 1 },
    { label: 'prize 3', weight: 1, count: 1 },
  ]);
  assert.equal(r.copies, 4);
});

test('list: new lines, commas, blanks and CRLF mixed', () => {
  const r = parseImport('﻿prize1\r\nprize2, prize3\n\n prize1 \n,');
  assert.equal(r.format, 'list');
  assert.deepEqual(r.rows.map((x) => [x.label, x.count, x.line]), [
    ['prize1', 2, 1],
    ['prize2', 1, 2],
    ['prize3', 1, 2],
  ]);
  const lines = parseImport('a\nb\na\n');
  assert.deepEqual(lines.rows.map((x) => [x.label, x.count]), [['a', 2], ['b', 1]]);
});

test('list: quoted names keep their commas; numbers-only line stays a list', () => {
  assert.deepEqual(parseImport('"Pick, the game", Hug').rows.map((x) => x.label), ['Pick, the game', 'Hug']);
  assert.equal(detectFormat('1, 2, 3'), 'list');
  assert.equal(parseImport('1, 2, 3').copies, 3);
  assert.equal(detectFormat('a, b\nc, d'), 'list');
});

test('CSV with header: name, weight, count; every line is its own prize', () => {
  const r = parseImport('name,weight,count\nVIP,5,2\n"Pick, the game",1,3\nMystery,,\nHug\nVIP,5,1');
  assert.equal(r.format, 'table');
  assert.deepEqual(simple(r), [
    { label: 'VIP', weight: 5, count: 2 },
    { label: 'Pick, the game', weight: 1, count: 3 },
    { label: 'Mystery', weight: 1, count: 1 },
    { label: 'Hug', weight: 1, count: 1 },
    { label: 'VIP', weight: 5, count: 1 },
  ]);
  assert.deepEqual(r.rows.map((x) => x.line), [2, 3, 4, 5, 6]);
  assert.equal(r.copies, 8);
});

test('CSV header in any order, Spanish with accents, extra columns ignored', () => {
  const r = parseImport('Cantidad;Premio;Notas;Peso;Acción\n2;Premio único;x;3;$(user) ganó\n;Otro;;;');
  assert.equal(r.format, 'table');
  assert.equal(r.separator, ';');
  assert.equal(r.hasActionColumn, true);
  assert.deepEqual(simple(r), [
    { label: 'Premio único', weight: 3, count: 2, action: '$(user) ganó' },
    { label: 'Otro', weight: 1, count: 1 },
  ]);
});

test('CSV without header, 4th column is the command; tab-separated works', () => {
  const r = parseImport('VIP,2,1,$(timeout $(user) 60)\nHug,1,3');
  assert.equal(r.format, 'table');
  assert.equal(r.hasActionColumn, true);
  assert.deepEqual(simple(r), [
    { label: 'VIP', weight: 2, count: 1, action: '$(timeout $(user) 60)' },
    { label: 'Hug', weight: 1, count: 3 },
  ]);
  const tabs = parseImport('Premio, grande\t3\t2\nOtro\t1\t1');
  assert.equal(tabs.separator, '\t');
  assert.deepEqual(simple(tabs)[0], { label: 'Premio, grande', weight: 3, count: 2 });
});

test('quoted fields may span lines; line numbers follow the record start', () => {
  const r = parseImport('name,weight,count,action\n"Two\nlines",1,1,"say ""hi""\nthen bye"\nNext,2,2');
  assert.deepEqual(simple(r), [
    { label: 'Two\nlines', weight: 1, count: 1, action: 'say "hi"\nthen bye' },
    { label: 'Next', weight: 2, count: 2 },
  ]);
  assert.deepEqual(r.rows.map((x) => x.line), [2, 5]);
});

test('an unclosed quote is reported and quotes are read as text', () => {
  const r = parseImport('a, "b, c\nd');
  assert.equal(r.unclosedQuote, 1);
  assert.deepEqual(r.rows.map((x) => x.label), ['a', '"b', 'c', 'd']);
});

test('bad rows are listed with line and reason; nothing is clamped silently', () => {
  const r = parseImport('name,weight,count\na,1,1\nb,0,1\nc,1.5,1\nd,1,20000\n,4,4\n' + 'x'.repeat(121) + ',1,1', 'table');
  assert.deepEqual(r.rows.map((x) => x.label), ['a']);
  assert.deepEqual(r.issues.map((i) => [i.line, i.reason]), [
    [3, 'weight'],
    [4, 'weight'],
    [5, 'count'],
    [6, 'name'],
    [7, 'long'],
  ]);
  const many = parseImport(Array(10001).fill('same').join(','));
  assert.equal(many.rows.length, 0);
  assert.equal(many.issues[0].reason, 'count');
});

test('forced list mode on CSV-looking text', () => {
  assert.deepEqual(parseImport('a,1\nb,2', 'list').rows.map((x) => x.label), ['a', '1', 'b', '2']);
  assert.equal(parseImport('a,2\nb,3').format, 'table');
});

test('export round-trips, guards spreadsheet formulas, keeps real apostrophes', () => {
  const items = [
    { label: 'VIP, gold', weight: 5, multiplier: 2, action: '' },
    { label: '=HYPERLINK("x")', weight: 1, multiplier: 1, action: '-1 point' },
    { label: "'Tis the season", weight: 1, multiplier: 3, action: '$(user) says "hi"\nbye' },
    { label: '@here', weight: 2, multiplier: 1 },
  ];
  const csv = toCsv(items);
  assert.match(csv, /^name,weight,count,action\r\n/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'-1 point/);
  const back = parseImport(csv);
  assert.equal(back.format, 'table');
  assert.deepEqual(simple(back), [
    { label: 'VIP, gold', weight: 5, count: 2 },
    { label: '=HYPERLINK("x")', weight: 1, count: 1, action: '-1 point' },
    { label: "'Tis the season", weight: 1, count: 3, action: '$(user) says "hi"\nbye' },
    { label: '@here', weight: 2, count: 1 },
  ]);
  assert.equal(toCsv([{ label: 'A', weight: 1, multiplier: 1 }]), 'name,weight,count\r\nA,1,1\r\n');
});

test('decoding: UTF-8 (BOM or not), UTF-16 with BOM, Windows-1252 fallback, xlsx refused', () => {
  const enc = new TextEncoder();
  assert.deepEqual(decodeText(enc.encode('Premio único')), { text: 'Premio único', encoding: 'utf-8' });
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('ñ')])).text, 'ñ');
  const utf16 = new Uint8Array([0xff, 0xfe, 0xf1, 0x00, 0x61, 0x00]);
  assert.deepEqual(decodeText(utf16), { text: 'ña', encoding: 'utf-16le' });
  assert.deepEqual(decodeText(new Uint8Array([0x50, 0x72, 0x65, 0x6d, 0x69, 0x6f, 0x20, 0xfa, 0x6e, 0x69, 0x63, 0x6f])), {
    text: 'Premio único',
    encoding: 'windows-1252',
  });
  assert.throws(() => decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), (e: ImportFileError) => e.reason === 'spreadsheet');
  assert.throws(() => decodeText(new Uint8Array([0x61, 0x00, 0x62])), (e: ImportFileError) => e.reason === 'binary');
  assert.throws(() => decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0xd8])), (e: ImportFileError) => e.reason === 'encoding');
});

test('plan: separate vs increase, clashes, chance and replace counts', () => {
  const items = [
    { label: 'VIP', weight: 5, multiplier: 2, action: '' },
    { label: 'Hug', weight: 1, multiplier: 1, action: '$(user) hug' },
  ];
  const rows = parseImport('name,weight,count\nVIP,5,1\nNew,1,2\nNew,1,1\nVIP,2,1').rows;
  const sep = planImport(rows, items, 'separate', false);
  assert.deepEqual(sep.rows.map((r) => r.status), ['sameName', 'new', 'new', 'sameName']);
  assert.equal(sep.slots, 3 + 5);
  assert.equal(sep.clashes, 0);
  const inc = planImport(rows, items, 'increase', false);
  assert.deepEqual(inc.rows.map((r) => [r.status, r.joinsLine]), [['joins', null], ['new', null], ['joins', 3], ['weightClash', null]]);
  assert.equal(inc.rows[3].existingWeight, 5);
  assert.equal(inc.clashes, 1);
  // VIP 5×3=15, Hug 1, New 1×3=3 → 19
  assert.equal(inc.rows[0].chance, 15 / 19);
  assert.equal(inc.rows[3].chance, 0);
  const act = planImport(parseImport('name,count,action\nHug,1,$(other)').rows, items, 'increase', false);
  assert.equal(act.rows[0].status, 'actionClash');
  assert.equal(planImport(parseImport('name,count\nHug,2').rows, items, 'increase', false).rows[0].status, 'joins');
  const rep = planImport(rows, items, 'increase', true);
  assert.deepEqual(rep.rows.map((r) => r.status), ['new', 'new', 'joins', 'weightClash']);
  assert.deepEqual([rep.removed, rep.removedCommands, rep.slots], [2, 1, 4]);
});

test('plan: an existing duplicate name joins the first prize, like the server', () => {
  const items = [
    { label: 'VIP', weight: 1, multiplier: 1 },
    { label: 'VIP', weight: 2, multiplier: 1 },
  ];
  const plan = planImport(parseImport('name,weight\nVIP,1').rows, items, 'increase', false);
  assert.equal(plan.rows[0].status, 'joins');
  assert.equal(plan.clashes, 0);
});

test('an action column keeps blank cells as "no command"; extra values are reported', () => {
  const r = parseImport('name,weight,count,action\nHug,1,1,\nVIP,1,1,$(user)');
  assert.deepEqual(r.rows.map((x) => x.action), ['', '$(user)']);
  const noColumn = parseImport('name,weight,count\nVIP,1,1\nTimeout,1,1,$(timeout $(user) 60)\nX,1,1,a,b');
  assert.deepEqual(noColumn.rows.map((x) => x.action), [undefined, undefined, undefined]);
  assert.deepEqual(noColumn.extraCells, { count: 2, line: 3 });
  assert.equal(parseImport('VIP,1,1\nHug,2,2').extraCells, null);
  // In 'increase' mode a blank command clashes with a prize that has one, like the server.
  const items = [{ label: 'Hug', weight: 1, multiplier: 1, action: '$(user) hug' }];
  assert.equal(planImport(r.rows, items, 'increase', false).rows[0].status, 'actionClash');
});

test('the CSV examples shown in the dialog import their command', () => {
  for (const lang of ['en', 'es']) {
    const i18n = JSON.parse(readFileSync(new URL(`../../../assets/i18n/${lang}.json`, import.meta.url), 'utf8'));
    const r = parseImport(i18n.roulette.import.exampleTable);
    assert.equal(r.format, 'table', lang);
    assert.equal(r.extraCells, null, lang);
    assert.equal(r.rows.at(-1)?.action, '$(timeout $(user) 60)', lang);
    assert.equal(parseImport(i18n.roulette.import.exampleList).copies, 4, lang);
  }
});
