import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WidgetField } from '../custom_widgets/format.js';
import { makeDesign, makeScene, type OverlayScene } from './model.js';
import { PublishBlocked, buildPublished, liveStatus, type PublishWidget } from './publish.js';

process.env.SECRET_KEY ??= 'a'.repeat(32); // the save validator's module reads it at load; nothing is encrypted here
const { validateState } = await import('./store.js');
type State = ReturnType<typeof validateState> & { schemaVersion: 1; revision: number };

const fields: WidgetField[] = [
  { key: 'textColor', type: 'colorpicker', label: 'Text color', value: '#ffffff' },
  { key: 'hideCommands', type: 'checkbox', label: 'Hide commands', value: true },
  { key: 'title', type: 'text', label: 'Title', value: 'Chat' }
];
const chat: PublishWidget = { id: 'a'.repeat(24), name: 'Chat', revision: 3, fields };
const goal: PublishWidget = { id: 'b'.repeat(24), name: 'Goal', revision: 1, fields: [] };
const widgets = (...list: PublishWidget[]) => new Map(list.map(widget => [widget.id, widget]));

/** A saved Studio state with every layer kind an overlay can hold, through the real save validator. */
function saved(): State {
  const design = makeDesign('starter', 'My alerts'), other = makeDesign('unused', 'Unused');
  const scene = makeScene('main', 'My overlay', design.id), second = makeScene('second', 'Second', design.id);
  const layer = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, x: 10, y: 20, width: 300, height: 200, visible: true, locked: false, ...extra });
  scene.widgets.push(...[
    layer('poll-1', 'poll', { configVersion: 1, config: { interactionDesign: 'card' } }),
    layer('prediction-1', 'prediction', { configVersion: 1, config: { interactionDesign: 'compact' } }),
    layer('text-1', 'text', { text: 'Hello $(user)' }),
    layer('shape-1', 'shape'),
    // Saved drafts never pin a revision; settings hold only what changed.
    layer('custom-1', 'custom', { configVersion: 1, config: { widgetId: chat.id, values: { textColor: '#123456', hideCommands: false } } }),
    layer('custom-2', 'custom', { configVersion: 1, config: { widgetId: goal.id } })
  ] as OverlayScene['widgets']);
  const draft = { scenes: [scene, second], designs: [design, other] };
  return { schemaVersion: 1, revision: 1, ...validateState(JSON.parse(JSON.stringify(draft)), { schemaVersion: 1, revision: 0, scenes: [], designs: [] }) };
}
/** Publishes one overlay the way the route does, then stores and reloads the state like MongoDB (JSON round trip). */
function publish(state: State, sceneId: string, available = widgets(chat, goal)): State {
  const scene = state.scenes.find(s => s.id === sceneId)!;
  scene.published = buildPublished(scene, state.designs, available); scene.revision++;
  return JSON.parse(JSON.stringify(state)) as State;
}
/** Saving again with no changes (validateState bumps every design revision). */
const resave = (state: State): State => ({ ...state, revision: state.revision + 1, ...validateState(JSON.parse(JSON.stringify(state)), state) });

test('publishing leaves the overlay live, with custom widgets pinned only in the published copy', () => {
  const state = publish(saved(), 'main');
  const main = state.scenes.find(s => s.id === 'main')!;
  assert.deepEqual(main.published!.widgets.find(w => w.id === 'custom-1')!.config, { widgetId: chat.id, revision: 3, values: { textColor: '#123456', hideCommands: false } });
  assert.deepEqual(main.widgets.find(w => w.id === 'custom-1')!.config, { widgetId: chat.id, values: { textColor: '#123456', hideCommands: false } }, 'the draft keeps following the latest revision');
  assert.deepEqual(liveStatus(state.scenes, state.designs, widgets(chat, goal)), { main: true, second: false });
});

test('saving again without changes keeps it live (design revisions and key order are not content)', () => {
  const state = resave(publish(saved(), 'main'));
  const main = state.scenes.find(s => s.id === 'main')!;
  assert.ok(state.designs.every(d => d.revision === 2) && main.published!.designs.every(d => d.revision === 1), 'the save bumped the design revisions');
  main.published = Object.fromEntries(Object.entries(main.published!).reverse()) as typeof main.published;
  main.published!.widgets = main.published!.widgets.map(w => Object.fromEntries(Object.entries(w).reverse()) as typeof w);
  assert.equal(liveStatus(state.scenes, state.designs, widgets(chat, goal)).main, true);
});

test('each overlay answers for itself', () => {
  const state = publish(publish(saved(), 'main'), 'second');
  assert.deepEqual(liveStatus(state.scenes, state.designs, widgets(chat, goal)), { main: true, second: true });
  state.scenes.find(s => s.id === 'second')!.widgets[0].x += 10;
  assert.deepEqual(liveStatus(state.scenes, state.designs, widgets(chat, goal)), { main: true, second: false });
});

test('saved changes that OBS does not have yet are not live', () => {
  const moved = publish(saved(), 'main');
  moved.scenes[0].widgets[0].x += 10;
  assert.equal(liveStatus(moved.scenes, moved.designs, widgets(chat, goal)).main, false, 'a moved layer');
  const design = publish(saved(), 'main');
  design.designs.find(d => d.id === 'starter')!.events.follow.duration = 9;
  assert.equal(liveStatus(design.scenes, design.designs, widgets(chat, goal)).main, false, 'an alert design this overlay uses');
  const unused = publish(saved(), 'main');
  unused.designs.find(d => d.id === 'unused')!.events.follow.duration = 9;
  assert.equal(liveStatus(unused.scenes, unused.designs, widgets(chat, goal)).main, true, 'a design this overlay does not use');
  const setting = publish(saved(), 'main');
  setting.scenes[0].widgets.find(w => w.id === 'custom-1')!.config!['values'] = { textColor: '#654321' };
  assert.equal(liveStatus(setting.scenes, setting.designs, widgets(chat, goal)).main, false, 'a custom widget setting');
});

test('new custom widget code or fields after publishing are not live until published again', () => {
  const state = publish(saved(), 'main');
  assert.equal(liveStatus(state.scenes, state.designs, widgets({ ...chat, revision: 4 }, goal)).main, false, 'OBS still runs revision 3');
  const dropped = { ...chat, revision: 4, fields: fields.filter(f => f.key !== 'hideCommands') };
  assert.equal(liveStatus(state.scenes, state.designs, widgets(dropped, goal)).main, false, 'publishing would drop a removed setting');
  const again = publish(state, 'main', widgets(dropped, goal));
  assert.equal(liveStatus(again.scenes, again.designs, widgets(dropped, goal)).main, true);
});

test('an overlay that can no longer be published is not live, and publishing it is refused', () => {
  const state = publish(saved(), 'main');
  assert.equal(liveStatus(state.scenes, state.designs, widgets(goal)).main, false, 'its widget was deleted');
  assert.throws(() => buildPublished(state.scenes[0], state.designs, widgets(goal)), (e: unknown) => e instanceof PublishBlocked && e.code === 'missing_widget' && e.status === 404);
  const strict = { ...chat, fields: [{ key: 'textColor', type: 'number', label: 'Size' } as WidgetField] };
  assert.equal(liveStatus(state.scenes, state.designs, widgets(strict, goal)).main, false, 'a saved setting no longer fits');
  assert.throws(() => buildPublished(state.scenes[0], state.designs, widgets(strict, goal)), (e: unknown) => e instanceof PublishBlocked && e.code === 'invalid_value');
});

test('never published is not live', () => {
  const state = saved();
  assert.deepEqual(liveStatus(state.scenes, state.designs, widgets(chat, goal)), { main: false, second: false });
});
