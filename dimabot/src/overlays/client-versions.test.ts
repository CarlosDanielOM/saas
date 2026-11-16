import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { ClientVersion, clientVersion, clientVersionReport, sawClient, MAX_NEW_VERSIONS_PER_HOUR, MAX_PROTOCOL, SEEN_REFRESH_MS } from './client-versions.js';
import { COMPAT_ENTRIES, COMPAT_QUIET_DAYS } from './compat.js';

const DAY = 86_400_000, NOW = Date.parse('2026-12-20T12:00:00Z');
type Group = { _id: { client: 'overlay' | 'studio'; protocol: number }; firstSeenAt: Date; lastSeenAt: Date };
function withRows(groups: Group[]) {
  mock.method(ClientVersion, 'aggregate', async () => groups);
  mock.method(ClientVersion, 'find', () => ({ sort: () => ({ limit: () => ({ lean: async () => groups.map(g => ({ client: g._id.client, protocol: g._id.protocol, build: `b${g._id.protocol}`, firstSeenAt: g.firstSeenAt, lastSeenAt: g.lastSeenAt })) }) }) }));
}
const group = (client: 'overlay' | 'studio', protocol: number, firstDaysAgo: number, lastDaysAgo: number): Group =>
  ({ _id: { client, protocol }, firstSeenAt: new Date(NOW - firstDaysAgo * DAY), lastSeenAt: new Date(NOW - lastDaysAgo * DAY) });
const overlayStates = async () => Object.fromEntries((await clientVersionReport(NOW)).entries.filter(e => e.client === 'overlay').map(e => [e.id, e.state]));

test('clientVersion: what a page reported, pages from before protocols count as 0', () => {
  assert.deepEqual(clientVersion(undefined), { protocol: 0, build: 'before-protocol' });
  assert.deepEqual(clientVersion({ clientId: 'x' } as never), { protocol: 0, build: 'before-protocol' });
  assert.deepEqual(clientVersion({ protocol: 1, build: 'main-2GM7C2KF' }), { protocol: 1, build: 'main-2GM7C2KF' });
  assert.deepEqual(clientVersion({ protocol: 1, build: 'main <script>' }), { protocol: 1, build: 'unknown' });
  assert.deepEqual(clientVersion({ protocol: 1.5, build: 'dev' }), { protocol: 0, build: 'dev' });
  assert.deepEqual(clientVersion({ protocol: '2', build: 'dev' }), { protocol: 0, build: 'dev' });
});

test('report: collecting until tracking is 14 days old, then needed while an old page was seen recently, then removable', async () => {
  assert.equal(COMPAT_QUIET_DAYS, 14);
  withRows([group('overlay', 0, 3, 0), group('overlay', 1, 1, 0)]);
  assert.ok(Object.values(await overlayStates()).every(state => state === 'collecting'), 'fewer than 14 days of data');
  withRows([group('overlay', 0, 20, 2), group('overlay', 1, 1, 0)]);
  const needed = (await clientVersionReport(NOW)).entries.find(e => e.id === 'overlay-legacy-sound')!;
  assert.equal(needed.state, 'needed');
  assert.equal(needed.olderLastSeenAt, new Date(NOW - 2 * DAY).toISOString());
  assert.equal(needed.removableFrom, new Date(NOW + 12 * DAY).toISOString());
  withRows([group('overlay', 0, 20, 15), group('overlay', 1, 13, 0)]);
  assert.ok(Object.values(await overlayStates()).every(state => state === 'removable'), 'no old page for 15 days');
  withRows([group('overlay', 1, 20, 0)]);
  assert.ok(Object.values(await overlayStates()).every(state => state === 'removable'), 'no old page ever seen');
  mock.restoreAll();
});

test('report: each client kind is judged on its own pages; versions list marks outdated rows and live counts', async () => {
  withRows([group('overlay', 1, 30, 0), group('studio', 0, 30, 1), group('studio', 2, 30, 0)]);
  const report = await clientVersionReport(NOW, [{ protocol: 1, build: 'b1' }, { protocol: 1, build: 'b1' }]);
  assert.equal(report.entries.find(e => e.client === 'studio')!.state, 'needed');
  assert.ok(report.entries.filter(e => e.client === 'overlay').every(e => e.state === 'removable'));
  assert.deepEqual(report.current, { overlay: 1, studio: 2 });
  const studioOld = report.versions.find(v => v.client === 'studio' && v.protocol === 0)!, overlay = report.versions.find(v => v.client === 'overlay')!;
  assert.equal(studioOld.outdated, true); assert.equal(studioOld.connectedNow, null);
  assert.equal(overlay.outdated, false); assert.equal(overlay.connectedNow, 2);
  assert.equal(new Set(COMPAT_ENTRIES.map(e => e.id)).size, COMPAT_ENTRIES.length, 'entry ids are unique');
  mock.restoreAll();
});

test('sawClient: one write per version per refresh window, a failed write is retried next time', async () => {
  const writes: string[] = []; let fail = true;
  mock.method(ClientVersion, 'updateOne', (filter: { _id: string }) => { writes.push(filter._id); return fail ? Promise.reject(new Error('down')) : Promise.resolve({}); });
  sawClient('overlay', { protocol: 1, build: 'main-TEST' }, NOW);
  await new Promise(resolve => setImmediate(resolve));
  sawClient('overlay', { protocol: 1, build: 'main-TEST' }, NOW + 1000);
  fail = false;
  sawClient('overlay', { protocol: 1, build: 'main-TEST' }, NOW + 2000);
  sawClient('overlay', { protocol: 1, build: 'main-TEST' }, NOW + 3000);
  sawClient('overlay', { protocol: 1, build: 'main-TEST' }, NOW + 2000 + SEEN_REFRESH_MS);
  assert.deepEqual(writes, ['overlay|1|main-TEST', 'overlay|1|main-TEST', 'overlay|1|main-TEST'], 'first write failed (retried), then once per window');
  mock.restoreAll();
});

test('sawClient: invented builds are capped per hour into one overflow row per protocol; protocols stay recorded', async () => {
  const writes: { id: string; build: string; protocol: number }[] = [];
  mock.method(ClientVersion, 'updateOne', (filter: { _id: string }, update: { $setOnInsert: { build: string; protocol: number } }) => {
    writes.push({ id: filter._id, build: update.$setOnInsert.build, protocol: update.$setOnInsert.protocol }); return Promise.resolve({});
  });
  const start = NOW + 10 * 3_600_000; // a fresh hour window
  for (let i = 0; i < MAX_NEW_VERSIONS_PER_HOUR + 20; i++) sawClient('overlay', { protocol: i % 2, build: `main-FAKE${String(i).padStart(4, '0')}` }, start + i);
  const named = writes.filter(w => w.build !== 'overflow');
  assert.equal(named.length, MAX_NEW_VERSIONS_PER_HOUR, 'only the first new versions get their own row');
  assert.deepEqual([...new Set(writes.filter(w => w.build === 'overflow').map(w => w.id))].sort(), ['overlay|0|overflow', 'overlay|1|overflow']);
  assert.ok(writes.filter(w => w.build === 'overflow').length <= 2, 'overflow rows are throttled like any other');
  // A version already recorded this hour keeps its own row after the cap.
  const before = writes.length;
  sawClient('overlay', { protocol: 0, build: 'main-FAKE0000' }, start + SEEN_REFRESH_MS + 100);
  assert.equal(writes.at(-1)?.id, 'overlay|0|main-FAKE0000'); assert.equal(writes.length, before + 1);
  // The next hour accepts new versions again.
  sawClient('overlay', { protocol: 1, build: 'main-NEXTHOUR' }, start + 3_600_000 + 1);
  assert.equal(writes.at(-1)?.id, 'overlay|1|main-NEXTHOUR');
  mock.restoreAll();
});

test('clientVersion: only the build formats our pages send', () => {
  assert.equal(clientVersion({ protocol: 1, build: 'dev' }).build, 'dev');
  assert.equal(clientVersion({ protocol: 1, build: 'build-123' }).build, 'unknown');
  assert.equal(clientVersion({ protocol: 1, build: 'main-' + 'A'.repeat(40) }).build, 'unknown');
  assert.equal(clientVersion({ protocol: MAX_PROTOCOL + 1, build: 'dev' }).protocol, 0);
});
