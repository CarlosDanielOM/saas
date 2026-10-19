import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WIDGET_DEFINITIONS, getWidgetDefinition, widgetKinds, validWidgetModuleConfig } from '/app/dist/overlays/widget-contract.js';
import { WidgetStateRegistry } from '/app/dist/overlays/widget-state.js';
import { validateState } from '/app/dist/overlays/store.js';
import { makeDesign, makeScene } from '/app/dist/overlays/model.js';
import { widgetStateRegistry } from '/app/dist/overlays/widget-state-providers.js';
import { publicWidgetStateFor, interactionsFor } from '/app/dist/overlays/live.js';

assert.deepEqual(WIDGET_DEFINITIONS.map(d => d.kind).sort(), ['alert', 'animation', 'clip', 'image', 'poll', 'prediction', 'shape', 'text', 'trigger', 'tts', 'video']);
assert.equal(new Set(WIDGET_DEFINITIONS.map(d => d.kind)).size, WIDGET_DEFINITIONS.length);
for (const definition of WIDGET_DEFINITIONS) {
  assert.equal(definition.configVersion, 1);
  assert(definition.defaultSize.width > 0 && definition.defaultSize.height > 0);
  for (const placement of ['scene', 'design']) {
    const expected = definition.placements.includes(placement);
    assert.equal(validWidgetModuleConfig({ kind: definition.kind }, placement), expected, `${definition.kind} legacy ${placement}`);
    assert.equal(validWidgetModuleConfig({ kind: definition.kind, configVersion: 1 }, placement), expected);
    for (const configVersion of [0, 2, '1', null]) assert.equal(validWidgetModuleConfig({ kind: definition.kind, configVersion }, placement), false);
  }
}
assert.equal(getWidgetDefinition('future-widget'), undefined);
assert.equal(validWidgetModuleConfig({ kind: 'future-widget' }, 'scene'), false);
assert(widgetKinds('scene').includes('text'), 'palette visibility must not invalidate an existing placement');
assert(!widgetKinds('design').includes('poll'));
assert.equal(validWidgetModuleConfig({ kind: 'poll', interactionDesign: 'custom' }, 'scene'), false);
assert.equal(validWidgetModuleConfig({ kind: 'tts', interactionDesign: 'compact' }, 'scene'), false);
const design = makeDesign('module-design', 'Module fixture'), scene = makeScene('module-scene', 'Module fixture', design.id);
const previous = { schemaVersion: 1, revision: 0, designs: [design], scenes: [scene] };
scene.widgets = ['poll', 'prediction'].map((kind, i) => ({ id: kind, kind, x: i * 600, y: 20, width: 560, height: 360, visible: true, locked: false, interactionDesign: 'compact', ...(i ? { configVersion: 1 } : {}) }));
const validated = validateState(previous, previous);
assert.equal(validated.scenes[0].widgets[0].configVersion, undefined, 'legacy widgets remain readable without rewriting their version');
assert.equal(validated.scenes[0].widgets[1].configVersion, 1);
for (const patch of [{ configVersion: 2 }, { kind: 'future-widget' }, { interactionDesign: 'custom' }]) {
  const raw = structuredClone(previous); Object.assign(raw.scenes[0].widgets[0], patch);
  assert.throws(() => validateState(raw, previous));
}
const invalidPlacement = structuredClone(previous); invalidPlacement.designs[0].events.follow.widgets.push(scene.widgets[0]);
assert.throws(() => validateState(invalidPlacement, previous));
console.log('PASS module contracts/store: all descriptors, placement rules, legacy/v1 compatibility, future version/kind rejection and poll/prediction preset preservation.');

const visible = kind => ({ kind, visible: true });
let reads = 0;
const registry = new WidgetStateRegistry([{ source: 'twitch-interactions', snapshot: async channel => {
  reads++; return { poll: { revision: 3, state: { channel, title: 'Public aggregate' } }, prediction: { revision: 4, state: { channel } }, privateSourceField: { revision: 1, state: 'must not publish' } };
} }]);
const scope = registry.createReadScope();
const duplicate = [visible('poll'), visible('poll'), visible('prediction')];
const [first, second] = await Promise.all([registry.snapshot('fixture-a', duplicate, scope), registry.snapshot('fixture-a', [visible('poll')], scope)]);
assert.equal(reads, 1, 'one shared channel/source read per delivery cycle, including duplicate instances/scenes');
assert.deepEqual(Object.keys(first.widgetStates).sort(), ['poll', 'prediction']);
assert.deepEqual(Object.keys(second.widgetStates), ['poll']);
assert.deepEqual(first.failedSources, []);
await registry.snapshot('fixture-b', [visible('poll')], scope); assert.equal(reads, 2, 'channels have isolated read scopes');
await registry.snapshot('fixture-a', [visible('poll')]); assert.equal(reads, 3, 'new cycles read fresh aggregate state');
const unrequested = await registry.snapshot('fixture-a', [{ kind: 'poll', visible: false }, { kind: 'prediction', visible: true, configVersion: 99 }, visible('future-widget'), visible('tts')]);
assert.deepEqual(unrequested.widgetStates, {}); assert.equal(reads, 3, 'hidden/unsupported/event widgets do not read state');
const unavailable = new WidgetStateRegistry([{ source: 'twitch-interactions', snapshot: async () => ({}) }]);
assert.deepEqual((await unavailable.snapshot('a', [visible('poll')])).widgetStates, { poll: { revision: 0, state: null } });
const failure = new WidgetStateRegistry([{ source: 'twitch-interactions', snapshot: async () => { throw new Error('isolated failure'); } }]);
const failed = await failure.snapshot('a', duplicate); assert.deepEqual(failed.widgetStates, {}); assert.deepEqual(failed.failedSources, ['twitch-interactions']);
const malformed = new WidgetStateRegistry([{ source: 'twitch-interactions', snapshot: async () => ({ poll: { revision: 1, state: {} }, prediction: { revision: -1, state: {} } }) }]);
assert.deepEqual((await malformed.snapshot('a', duplicate)).widgetStates, {}, 'invalid provider data cannot publish partial state');
assert.throws(() => new WidgetStateRegistry([{ source: 'duplicate', snapshot: async () => ({}) }, { source: 'duplicate', snapshot: async () => ({}) }]));
console.log('PASS generic state registry: shared reads, channel isolation/fresh cycles, published visibility/version scope, unavailable clears, failure isolation and aggregate-only projection.');

const readWidgets = widgetStateRegistry.snapshot;
try {
  widgetStateRegistry.snapshot = async () => ({ widgetStates: {}, serverTime: Date.now(), failedSources: ['twitch-interactions'] });
  const publicSource = { channel: 'fixture-only', snapshot: { widgets: scene.widgets } };
  const unavailableState = await publicWidgetStateFor(publicSource);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(unavailableState)), 'interactions'), false, 'failed legacy hydration omits its envelope instead of fabricating a definitive clear');
  await assert.rejects(() => interactionsFor(publicSource), error => error.status === 503);
} finally { widgetStateRegistry.snapshot = readWidgets; }
console.log('PASS legacy compatibility: temporary source failure preserves clients during hydration and public refresh.');

// Copy the existing interactions fixtures plus its check into --fixtures. The
// baseline intentionally exits; a child process lets this check extend it.
const baseline = '/tmp/saas-fixtures/overlay-interactions.mjs';
assert(existsSync(baseline), 'Fixtures must include ops/checks/overlay-interactions.mjs alongside the existing interactions provider fixtures');
const legacy = spawnSync(process.execPath, [baseline], { stdio: 'inherit', env: process.env, timeout: 180000 });
assert.equal(legacy.status, 0, 'existing signed-ingestion/subscription/legacy-transport/runtime baseline');
if (process.env.SAAS_INTERACTION_TARGET === 'api') {
  const channel = '990702';
  const request = async (method, path, body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:3000/overlay-studio/${path}`, { method, headers: { Authorization: `Bearer fixture-${channel}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result.data;
  };
  let state = await request('GET', channel);
  state.scenes[0].widgets = [
    { ...scene.widgets[0], id: 'poll-a' }, { ...scene.widgets[0], id: 'poll-b', configVersion: 1, x: 650 },
    { ...scene.widgets[1], visible: false }
  ];
  state = await request('PUT', channel, state);
  for (const patch of [{ configVersion: 2 }, { kind: 'future-widget' }]) {
    const invalid = structuredClone(state); Object.assign(invalid.scenes[0].widgets[0], patch); await request('PUT', channel, invalid, 400);
  }
  state = await request('POST', `${channel}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  const publicId = state.scenes[0].publicId;
  const publicData = await request('GET', `public/${publicId}`);
  assert.deepEqual(Object.keys(publicData.widgetStates), ['poll']);
  assert.equal(publicData.widgetStates.poll.state.kind, 'poll');
  assert.equal(publicData.interactions.poll.id, publicData.widgetStates.poll.state.id, 'legacy and generic projections use the same resource');
  assert.equal(publicData.interactions.prediction, null, 'hidden widgets cannot expose their live state');
  assert.equal(typeof publicData.serverTime, 'number');
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket'), messages = [];
  const ns = `/overlay-studio/${publicId}`;
  ws.addEventListener('message', event => {
    const message = String(event.data);
    if (message.startsWith('0')) ws.send(`40${ns},{"clientId":"widget-module-check-client"}`);
    else if (message === '2') ws.send('3');
    else if (message.startsWith('42')) messages.push(JSON.parse(message.slice(message.indexOf(',') + 1)));
  });
  const until = async predicate => { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 150)); } assert.fail('Timed out waiting for generic socket state'); };
  try {
    await until(() => messages.some(m => m[0] === 'overlay-state'));
    assert.deepEqual(Object.keys(messages.find(m => m[0] === 'overlay-state')[1].widgetStates), ['poll']);
    state.scenes[0].widgets = []; state = await request('PUT', channel, state);
    await request('POST', `${channel}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
    await until(() => messages.some(m => m[0] === 'overlay-widget-states' && Object.keys(m[1].widgetStates).length === 0));
    assert.deepEqual((await request('GET', `public/${publicId}`)).widgetStates, {});
  } finally { ws.close(); }
  console.log('PASS actual API/generic OBS transport: v1/legacy save, future rejection, duplicate public widgets, hidden-state scoping, legacy parity, hydration and removal clearing.');
}
process.exit(0);
