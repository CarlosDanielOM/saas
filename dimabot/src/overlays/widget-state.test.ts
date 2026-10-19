import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getWidgetDefinition, parseWidgetModuleConfig, validWidgetModuleConfig, widgetKinds, WIDGET_DEFINITIONS } from './widget-contract.js';
import { WidgetStateRegistry, type StateWidget } from './widget-state.js';

const poll = { id: 'poll-a', kind: 'poll', visible: true };
const prediction = { id: 'prediction-a', kind: 'prediction', visible: true };
test('portable definitions preserve placement, legacy config, versions and strict module-owned fields', () => {
  assert.equal(new Set(WIDGET_DEFINITIONS.map(d => d.kind)).size, WIDGET_DEFINITIONS.length);
  assert(widgetKinds('scene').includes('text')); assert(!widgetKinds('scene').includes('animation'));
  assert(widgetKinds('design').includes('animation')); assert(!widgetKinds('design').includes('poll'));
  assert.equal(getWidgetDefinition('constructor'), undefined);
  for (const raw of [poll, { ...poll, configVersion: 1 }, { ...poll, interactionDesign: 'compact' }, { ...poll, config: { interactionDesign: 'card' } }]) assert(validWidgetModuleConfig(raw, 'scene'));
  for (const raw of [{ ...poll, interactionDesign: 'script' }, { ...poll, config: { goalID: 'private' } }, { ...poll, config: [] }, { ...poll, configVersion: 2 }, { ...poll, configVersion: null }, { ...poll, kind: 'text', interactionDesign: 'card' }, { ...poll, kind: 'unregistered' }]) assert(!validWidgetModuleConfig(raw, 'scene'));
  assert(!validWidgetModuleConfig(poll, 'design'));
  const raw = { ...poll, configVersion: 1, interactionDesign: 'compact', config: { interactionDesign: 'card' }, discarded: 'secret' };
  const parsed = parseWidgetModuleConfig(raw, 'scene')!;
  assert.deepEqual(parsed, { legacy: { interactionDesign: 'compact' }, configVersion: 1, config: { interactionDesign: 'card' } });
  raw.config.interactionDesign = 'compact'; assert.equal(parsed.config?.['interactionDesign'], 'card');
});
test('visible selected modules share source reads across instances/peers, with channel and cycle boundaries', async () => {
  const reads: string[] = [];
  const registry = new WidgetStateRegistry([{ source: 'twitch-interactions', async snapshot(channel) {
    reads.push(channel); return { poll: { revision: 7, state: { channel } }, prediction: { revision: 3, state: { secret: 'not-selected' } }, unrelated: { revision: 8, state: 'private' } };
  } }]);
  const scope = registry.createReadScope();
  const [a, b] = await Promise.all([registry.snapshot('a', [poll, { ...poll, id: 'poll-b' }, { ...prediction, visible: false }], scope), registry.snapshot('a', [poll], scope)]);
  assert.deepEqual(reads, ['a']); assert.deepEqual(a.widgetStates, b.widgetStates);
  assert.deepEqual(a.widgetStates, { poll: { revision: 7, state: { channel: 'a' } } });
  assert(!JSON.stringify(a).includes('secret'));
  await registry.snapshot('a', [poll], scope); assert.deepEqual(reads, ['a']);
  await registry.snapshot('b', [poll], scope); assert.deepEqual(reads, ['a', 'b']);
  await registry.snapshot('a', [poll]); assert.deepEqual(reads, ['a', 'b', 'a']);
  await registry.snapshot('a', [{ ...poll, visible: false }, { ...poll, configVersion: 2 }, { ...poll, config: { unknown: true } }]);
  assert.deepEqual(reads, ['a', 'b', 'a']);
});
test('successful missing states explicitly clear while revisions and null remain intact', async () => {
  const registry = new WidgetStateRegistry([{ source: 'twitch-interactions', async snapshot() { return { poll: { revision: 9, state: null } }; } }]);
  assert.deepEqual((await registry.snapshot('a', [poll, prediction])).widgetStates, { poll: { revision: 9, state: null }, prediction: { revision: 0, state: null } });
  assert.deepEqual((await registry.snapshot('a', [])).widgetStates, {});
});
test('failed source is isolated, failed in-flight reads release and a fresh cycle retries', async () => {
  let fail = true, reads = 0;
  const registry = new WidgetStateRegistry([
    { source: 'twitch-interactions', async snapshot() { reads++; if (fail) throw new Error('private provider detail'); return { poll: { revision: 4, state: 'recovered' } }; } },
    { source: 'test-other-source', async snapshot() { return { prediction: { revision: 2, state: 'healthy' } }; } }
  ], kind => { const definition = getWidgetDefinition(kind); return definition?.kind === 'prediction' ? { ...definition, state: { source: 'test-other-source', stateKey: 'prediction' } } : definition; });
  const scope = registry.createReadScope();
  const [a, b] = await Promise.all([registry.snapshot('a', [poll, prediction], scope), registry.snapshot('a', [poll], scope)]);
  assert.equal(reads, 1); assert.deepEqual(a.failedSources, ['twitch-interactions']); assert.deepEqual(b.failedSources, a.failedSources);
  assert.deepEqual(a.widgetStates, { prediction: { revision: 2, state: 'healthy' } }); assert(!JSON.stringify(a).includes('private'));
  fail = false; assert.equal((await registry.snapshot('a', [poll])).widgetStates['poll'].revision, 4); assert.equal(reads, 2);
});
test('access checks precede reads and projection receives full selected instance configs', async () => {
  let reads = 0; const selected: StateWidget[][] = [];
  const registry = new WidgetStateRegistry([{ source: 'twitch-interactions', async authorize(channel) { return channel === 'allowed'; }, async snapshot() { reads++; return { poll: { revision: 1, state: 'shared' } }; }, project(snapshot, widgets) { selected.push([...widgets]); return { poll: { ...snapshot.poll!, state: widgets.map(w => [w.id, w.config]) } }; } }]);
  const denied = await registry.snapshot('denied', [poll]);
  assert.deepEqual(denied.failedSources, []); assert.deepEqual(denied.widgetStates, { poll: { revision: 0, state: null } }); assert.equal(reads, 0);
  const widget = { ...poll, config: { interactionDesign: 'compact' } };
  const result = await registry.snapshot('allowed', [widget, { ...prediction, visible: false }]);
  assert.deepEqual(selected, [[widget]]); assert.deepEqual(result.widgetStates['poll'].state, [['poll-a', { interactionDesign: 'compact' }]]);
});
test('unknown sources and invalid revisions are isolated as unavailable', async () => {
  assert.deepEqual((await new WidgetStateRegistry([]).snapshot('a', [poll])).failedSources, ['twitch-interactions']);
  const registry = new WidgetStateRegistry([{ source: 'twitch-interactions', async snapshot() { return { poll: { revision: -1, state: 'invalid' } }; } }]);
  const result = await registry.snapshot('a', [poll]); assert.deepEqual(result.widgetStates, {}); assert.deepEqual(result.failedSources, ['twitch-interactions']);
});
