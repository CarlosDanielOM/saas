import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./public/dimafx-player.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = new Map<string, (data?: unknown) => void>();
  const events: { name: string; data: { triggerID?: string; status?: string; captions?: boolean } }[] = [];
  const actions: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const nodes: { tag: string; textContent: string; removed: boolean; listeners: Record<string, () => void> }[] = [];
  const sandbox = {
    window: { location: { pathname: '/overlays/dimafx/42', search: '?token=fixture' } }, URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    io: () => ({ on: (name: string, fn: (data?: unknown) => void) => handlers.set(name, fn), emit: (name: string, data: { status?: string }) => { actions.push(`ack:${data?.status || ''}`); events.push({ name, data }); } }),
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    document: {
      getElementById: () => ({ appendChild: () => {} }),
      createElement: (tag: string) => {
        const node = { tag, textContent: '', removed: false, style: {}, listeners: {} as Record<string, () => void>,
          setAttribute: () => {}, removeAttribute: () => {}, load: () => {},
          addEventListener: (name: string, fn: () => void) => { node.listeners[name] = fn; },
          pause: () => actions.push('pause'), play: () => Promise.resolve(), remove: () => { node.removed = true; },
        };
        nodes.push(node); return node;
      },
    },
  };
  vm.runInNewContext(source, sandbox);
  const play = (extra = {}) => handlers.get('dimafx-play')!({ triggerID: 'job', url: 'https://fixture.invalid/media', mediaType: 'audio/wav', timeoutMs: 4000, ...extra });
  return { handlers, events, actions, timers, nodes, play };
}
test('player announces caption support and displays the Twitch name/text using textContent', () => {
  const f = fixture(); f.handlers.get('connect')!();
  assert.equal(f.events[0].data.captions, true);
  f.play({ viewer: { name: 'Viewer <name>', text: '<script>hello</script>' } });
  assert.equal(f.nodes[1].textContent, 'Viewer <name>: “<script>hello</script>”');
  f.nodes[0].listeners.ended();
  assert.equal(f.nodes[1].removed, true); assert.equal(f.events.at(-1)?.data.status, 'completed');
  assert.ok(f.actions.indexOf('pause') < f.actions.indexOf('ack:completed'));
});
test('media error remains failed across redeliveries; stop removes caption and acknowledges skipped', () => {
  const f = fixture(); f.play({ viewer: { name: 'Viewer', text: 'Hi' } });
  f.nodes[0].listeners.error();
  assert.equal(f.events.at(-1)?.data.status, 'failed'); assert.equal(f.nodes[1].removed, true);
  f.play(); assert.equal(f.nodes.length, 2); assert.equal(f.events.at(-1)?.data.status, 'failed');
  const second = fixture(); second.play({ viewer: { name: 'Viewer', text: 'Hi' } });
  second.handlers.get('dimafx-stop')!({ triggerID: 'job', reason: 'removed_by_broadcaster' });
  assert.equal(second.nodes[0].removed, true); assert.equal(second.nodes[1].removed, true);
  assert.equal(second.events.at(-1)?.data.status, 'skipped');
});
test('images use the item duration; watchdog stops media before reporting failure', () => {
  const f = fixture(); f.play({ mediaType: 'image/gif', durationMs: 1234 }); f.nodes[0].listeners.load();
  const imageTimer = [...f.timers.values()].find(timer => timer.ms === 1234); assert.ok(imageTimer); imageTimer.fn();
  assert.equal(f.events.at(-1)?.data.status, 'completed');
  const second = fixture(); second.play();
  [...second.timers.values()][0].fn();
  assert.equal(second.events.at(-1)?.data.status, 'failed'); assert.equal(second.nodes[0].removed, true);
  assert.ok(second.actions.indexOf('pause') < second.actions.indexOf('ack:failed'));
});
