// Run only in an isolated container with the pinned Node runtime and tzdata.
// Date.parse itself is the oracle; each timezone uses a fresh process so Node
// and libc do not retain timezone state from another case.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const zones = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Apia'];
const cases = [];
function add(group, values) {
  for (const value of values) cases.push({ group, units: Array.from(value, ch => ch.codePointAt(0)).flatMap(cp => cp <= 0xffff ? [cp] : [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023)]) });
}
add('iso', [
  '1970', '1970-01', '1970-01-01', '1970-01-01T00:00', '1970-01-01T00:00Z',
  '2020-02-29T23:59:59.123456789Z', '2021-02-29', '2020-02-30', '2020-04-31',
  '2020-00-01', '2020-13-01', '2020-01-00', '2020-01-32',
  '0000-01-01', '0099-01-01', '+000000-01-01', '-000000-01-01',
  '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z',
  '2020-01-01T24:00:00Z', '2020-01-01T24:00:00.0001Z', '2020-01-01T24:01Z',
  '2020-01-01t00:00:00z', '2020-01-01T00:00:00+01:30', '2020-01-01T00:00:00-0130',
  '2020-01-01T00:00:00+24:00', '2020-01-01T00:00:00+01:60',
  '2020-01-01T00:00:00.', '2020-01-01T00:00:00Zjunk', '2020-01-01T00:00:00 Z',
  '2020-1-1', '2020-01-01T1:00Z', '2020-01-01T00:00:60Z', '2020-01-01T00:00Z+00:00',
]);
add('legacy', [
  '', '0', '1', '12', '13', '31', '32', '49', '50', '99', '100', '999', '0001',
  '1/2/03', '01-02-49', '01-02-50', '31/12/2000', '2000/12/31',
  'Jan 1 2020', '1 January 2020', '2020 Jan 1', 'janUARY 1 2020', 'Janx 1 2020',
  'Mon, 25 Dec 1995 13:30:00 GMT', 'December 25, 1995 1:30 PM EST',
  'May 1 2000 12:00 AM', 'May 1 2000 12:00 PM', 'May 1 2000 13:00 PM',
  'May 1 2000 12:00 GMT+5', 'May 1 2000 12:00 GMT+0530', 'May 1 2000 12:00 GMT+05:30',
  'May 1 2000 12:00 PST', 'May 1 2000 12:00 UTC', 'May 1 2000 12:00 XYZ',
  'garbage 2020-01-01', '2020-01-01 garbage', 'Jan 1 2000 (comment)',
  'Jan 1 2000 (outer (inner))', 'Jan 1 2000 (unclosed', 'Jan 1 2000 )',
  '2020-01-01\u0000garbage', '\u00a02020-01-01\u00a0', '\ufeff2020-01-01',
]);
add('local-dst', [
  '2024-03-10T01:59:59', '2024-03-10T02:30:00', '2024-03-10T03:00:00',
  '2024-11-03T01:30:00', '2024-03-31T02:30:00', '2024-10-27T02:30:00',
  '2024-10-06T02:15:00', '2024-04-07T01:45:00', '2011-12-30T12:00:00',
  '2024-03-10', 'March 10 2024 02:30:00',
  '1918-03-31T02:30:00', '1945-08-14T19:00:00', '1969-12-31T23:59:59',
  '1883-11-18T12:00:00', '1893-04-01T00:00:00', '1900-01-01T00:00:00',
  '2011-12-29T23:59:59', '2011-12-30T00:00:00', '2011-12-31T00:00:00',
  '2038-01-19T03:14:07', '2100-03-14T02:30:00', '0001-01-01T00:00:00',
  '+010000-01-01T00:00:00', '-000001-01-01T00:00:00',
]);
for (const units of [[0xd800], [0xdc00], [0x31,0xd800], [0xd800,0x31], [0x31,0,0x32], [0xd800,0xd800], [0xdc00,0xdc00], [0xdc00,0xd800], [0xd83d,0xde00], [0x32,0x30,0x32,0x30,0x2d,0x30,0x31,0x2d,0x30,0x31,0xd800], [0x31,0x20,0xdc00,0x20,0x32]]) cases.push({group:'utf16', units});
add('extended-years', [
  '+275760-09-12T23:59:59.999Z', '+275760-09-13', '+275760-09-14',
  '-271821-04-20', '-271821-04-19', '-000001-12-31T23:59:59.999Z',
  '+010000-01-01', '+100000-01-01T00:00:00Z', '-100000-01-01T00:00:00Z',
  '+275760-09-13T01:00:00+01:00', '-271821-04-19T23:00:00-01:00',
  '+275760-09-13T00:00:00', '-271821-04-20T00:00:00',
]);
add('v8-edge-cases', [
  'Jan 1', '1 Jan', 'Jan 2', 'Feb 29', 'Jan 01', 'January 1',
  'Jan 1 00', 'Jan 1 99', 'Jan 1 100', 'Jan 1 2147483647', 'Jan 1 2147483648',
  '2147483647', '2147483648', '4294967295', '4294967296', '999999999999999999999',
  '2000-01-01T00:00:00.000000000000000000000000001Z',
  '2000-01-01T00:00:00.000000000000000000000123456789123Z',
  '2000-01-01T00:00:00.000000000000000000001000000000000Z',
  '2000-01-01T00:00:00.0000000001Z', '2000-01-01T00:00:00.000000001Z',
  '2000-01-01T24:00:00.0000000001Z',
  'Jan 1 2000 00:00:00.000000000000000000000000001 GMT',
  'Jan 1 2000 12::30', 'Jan 1 2000 12:00 GMT+999999999:00',
  'Jan 1 2000 00:00 GMT+2147483647', 'Jan 1 2000 00:00 GMT+2147483648',
  'Jan 1 2000 00:00 GMT+4294967295', 'Jan 1 2000 00:00 GMT+4294967296',
  'Jan 1 2000 00:00 GMT+999999999999999999999',
  'Jan\u2028uary 1 2000', 'Jan\u2029uary 1 2000', 'Jan 1 2000 GMT\u0000suffix',
  '0000-01-01T00:00:00', '0099-01-01T00:00:00', '1800-01-01T00:00:00',
  '1880-01-01T00:00:00', '+100000-07-01T12:00:00', '-100000-07-01T12:00:00',
]);
// Systematic boundary and malformed suffix coverage without random seeds.
for (const month of ['00','01','02','12','13']) for (const day of ['00','01','28','29','30','31','32']) {
  add('calendar-boundary', [`2024-${month}-${day}`, `2023-${month}-${day}T12:00:00Z`]);
}
for (const suffix of ['', 'Z', 'z', '+0000', '+00:00', '+00', '+0:00', '-00:00', ' UTC', 'x', ' ', '\n']) {
  add('suffix', [`2001-09-09T01:46:40${suffix}`, `2001-09-09${suffix}`]);
}

if (process.argv.includes('--child')) {
  const output = cases.map(({units}) => {
    const value = Date.parse(String.fromCharCode(...units));
    return Number.isNaN(value) ? null : value;
  });
  process.stdout.write(JSON.stringify(output));
} else {
  assert(process.argv.includes('--write') !== process.argv.includes('--check'), 'choose --write or --check');
  assert.equal(process.versions.node, '24.22.1', 'oracle must use pinned Node');
  assert.equal(process.versions.v8, '13.6.233.17-node.58', 'oracle must use pinned V8');
  assert.equal(process.versions.icu, '78.3', 'oracle must use pinned ICU');
  assert.equal(process.versions.tz, '2026e', 'oracle must use pinned tzdata');
  const results = {};
  for (const zone of zones) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {env: {...process.env, TZ: zone}, encoding: 'utf8'});
    assert.equal(child.status, 0, `${zone}: ${child.stderr}`);
    results[zone] = JSON.parse(child.stdout);
    assert.equal(results[zone].length, cases.length);
  }
  const output = {
    source: 'Node Date.parse; Node v24.22.1 bundled V8 dateparser',
    sourceUrl: 'https://github.com/nodejs/node/tree/v24.22.1/deps/v8/src/date',
    oracleSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    runtime: {node:process.versions.node, v8:process.versions.v8, icu:process.versions.icu, unicode:process.versions.unicode, tz:process.versions.tz},
    cases, results,
  };
  const path = new URL('js_date_cases.json', import.meta.url);
  if (process.argv.includes('--write')) writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
  else assert.deepEqual(output, JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify({cases:cases.length, zones:zones.length, runtime:output.runtime}));
}
