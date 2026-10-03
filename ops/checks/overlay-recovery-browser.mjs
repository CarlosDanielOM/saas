import assert from 'node:assert/strict';
import { chromium } from '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs';
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4201';
const publicId = 'a'.repeat(48);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    let socket, snapshotRequests = 0, targetRevision = 1, snapshotStatus = 200, holdSnapshot = false;
    const heldSnapshots = [];
    const requests = new Map(), responses = new Map(), ended = [], errors = [];
    const layer = { id: 'label', kind: 'text', x: 0, y: 0, width: 500, height: 100, text: 'Published 1', visible: true, locked: false };
    const snapshot = { width: 1920, height: 1080, waitFor: ['follow'], widgets: [layer, { id: 'alert', kind: 'alert', x: 0, y: 120, width: 800, height: 240, visible: true, locked: false, designId: 'design', events: ['follow'] }], designs: [{ id: 'design', width: 800, height: 240 }] };
    const state = revision => { const copy = structuredClone(snapshot); copy.widgets[0].text = `Published ${revision}`; return { revision, snapshot: copy }; };
    const send = (name, data) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, data])}`);
    await context.routeWebSocket('**/*', ws => {
      if (!ws.url().includes('/socket.io/')) return ws.close();
      socket = ws; ws.send('0{"sid":"recovery","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
      ws.onMessage(message => {
        const m = String(message);
        if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"recovery"}`); send('overlay-state', state(1)); }
        if (m.startsWith('42/overlay-studio/')) { const [name, data] = JSON.parse(m.slice(m.indexOf(',') + 1)); if (name === 'overlay-ended') ended.push(data); }
      });
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.pathname.includes('/events/')) {
        const id = url.pathname.split('/').at(-1); requests.set(id, (requests.get(id) || 0) + 1);
        const status = responses.get(id) ?? 200;
        if (status === 'timeout') return;
        if (status === 0) return route.abort('failed');
        if (status !== 200) return route.fulfill({ status, json: { error: true } });
        return route.fulfill({ json: { data: { id, kind: 'follow', snapshot, layouts: { design: { duration: 5, widgets: [{ ...layer, text: `Alert ${id}` }] } } } } });
      }
      if (url.pathname === `/overlay-studio/public/${publicId}`) {
        snapshotRequests++;
        if (holdSnapshot) { heldSnapshots.push(route); return; }
        return route.fulfill({ status: snapshotStatus, json: snapshotStatus === 200 ? { data: state(targetRevision) } : { error: true } });
      }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/overlays/${publicId}`); await page.getByText('Published 1', { exact: true }).waitFor();
    await page.clock.install(); await page.clock.pauseAt(new Date());
    const tick = async ms => { await page.clock.runFor(ms); await new Promise(r => setTimeout(r, 40)); };
    const until = async (test, message) => { for (let i = 0; i < 100; i++) { if (await test()) return; await tick(50); } assert.fail(message); };
    // Issue 2: retry temporary errors, preserve ordering and acknowledge only after playback.
    for (const status of [503, 429, 0]) {
      const id = `recover-${status}`; responses.set(id, status); send('overlay-event', { id, kind: 'follow' });
      await until(() => requests.get(id) === 1, 'first failed request'); await tick(100);
      assert(!ended.includes(id));
      send('overlay-event', { id: `${id}-next`, kind: 'follow' });
      send('overlay-event', { id, kind: 'follow' });
      assert(!requests.has(`${id}-next`)); responses.set(id, 200); await tick(1200);
      await until(async () => await page.getByText(`Alert ${id}`, { exact: true }).count(), 'recovered alert renders');
      assert.equal(requests.get(id), 2); assert(!ended.includes(id)); assert(!requests.has(`${id}-next`));
      await tick(5200); await until(() => requests.has(`${id}-next`), 'serial successor starts');
      await tick(5200); await until(() => ended.includes(`${id}-next`), 'successor completes');
      assert.equal(ended.filter(value => value === id).length, 1);
    }
    responses.set('timeout', 'timeout'); send('overlay-event', { id: 'timeout', kind: 'follow' });
    await until(() => requests.has('timeout'), 'timeout starts'); await tick(20100); assert(!ended.includes('timeout'));
    responses.set('timeout', 200); await tick(1200);
    await until(async () => await page.getByText('Alert timeout', { exact: true }).count(), 'timeout retries');
    await tick(5200); await until(() => ended.includes('timeout'), 'timeout recovered playback ends');
    responses.set('gone', 404); send('overlay-event', { id: 'gone', kind: 'follow' });
    await until(() => ended.includes('gone'), 'permanent error releases queue'); await tick(5000); assert.equal(requests.get('gone'), 1);
    responses.set('skip-retry', 503); send('overlay-event', { id: 'skip-retry', kind: 'follow' });
    await until(() => requests.has('skip-retry'), 'skip fixture loaded'); await tick(100);
    send('overlay-control', { id: 'skip-command', action: 'skip', eventIds: ['skip-retry'] });
    await until(() => ended.includes('skip-retry'), 'skip acknowledged'); await tick(10000); assert.equal(requests.get('skip-retry'), 1);
    console.log(`PASS ${width}px: transient alert recovery, duplicate receipt, serial ordering, terminal 404 and skip cancellation`);
    if (!process.env.EVENT_ONLY) {
      // Issue 3: a single notification must recover without another publish/reconnect.
      targetRevision = 2; snapshotStatus = 503; send('overlay-updated', { revision: 2 });
      await until(() => snapshotRequests === 1, 'snapshot failure'); await tick(100);
      assert.equal(await page.getByText('Published 1', { exact: true }).count(), 1);
      snapshotStatus = 200; await tick(1200);
      await until(async () => await page.getByText('Published 2', { exact: true }).count(), 'snapshot retry renders latest');
      assert.equal(snapshotRequests, 2);
      targetRevision = 3; snapshotStatus = 503; send('overlay-updated', { revision: 3 });
      await until(() => snapshotRequests === 3, 'second failed update'); await tick(100);
      send('overlay-state', state(4)); await tick(100); await tick(10000);
      assert.equal(snapshotRequests, 3); assert.equal(await page.getByText('Published 4', { exact: true }).count(), 1);
      // Publication during an in-flight request must not be lost or roll back a newer state.
      targetRevision = 5; snapshotStatus = 200; holdSnapshot = true; send('overlay-updated', { revision: 5 });
      await until(() => heldSnapshots.length === 1, 'held snapshot request');
      targetRevision = 6; send('overlay-updated', { revision: 6 }); await tick(100); assert.equal(snapshotRequests, 4);
      holdSnapshot = false; await heldSnapshots.shift().fulfill({ json: { data: state(5) } }); await tick(100); await tick(1200);
      await until(async () => await page.getByText('Published 6', { exact: true }).count(), 'newer publication follows in-flight request');
      holdSnapshot = true; send('overlay-updated', { revision: 7 });
      await until(() => heldSnapshots.length === 1, 'held stale request');
      send('overlay-state', state(8)); await tick(100);
      await heldSnapshots.shift().fulfill({ json: { data: state(7) } }); await tick(100); await tick(5000);
      assert.equal(await page.getByText('Published 8', { exact: true }).count(), 1);
      holdSnapshot = false; snapshotStatus = 503; send('overlay-updated', { revision: 9 });
      await until(() => snapshotRequests === 7, 'pending retry before revoke'); await tick(100);
      console.log(`PASS ${width}px: published layout retry, coalesced publications and stale response protection`);
    }
    responses.set('revoked-retry', 503); send('overlay-event', { id: 'revoked-retry', kind: 'follow' });
    await until(() => requests.has('revoked-retry'), 'revoke fixture loaded'); await tick(100);
    const count = snapshotRequests;
    send('overlay-revoked'); await tick(100); await tick(35000);
    assert.equal(requests.get('revoked-retry'), 1); assert.equal(snapshotRequests, count); assert.equal(await page.locator('.canvas').count(), 0);
    assert.deepEqual(errors, []); await context.close();
  }
} finally { await browser.close(); }
