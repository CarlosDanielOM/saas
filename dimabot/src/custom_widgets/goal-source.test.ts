import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layerGoalSource } from './goal-source.js';
import { buildPublished } from '../overlays/publish.js';
import { parseWidgetModuleConfig } from '../overlays/widget-contract.js';

test('a layer keeps "twitch" as its goal source; ours is the default and stays implicit; anything else is refused', () => {
  assert.deepEqual(layerGoalSource({ goalSource: 'twitch' }), { goalSource: 'twitch' });
  for (const config of [undefined, {}, { goalSource: 'dima' }, { goalSource: null }]) assert.deepEqual(layerGoalSource(config as never), {});
  for (const goalSource of ['Twitch', 'both', 1, true, {}]) assert.equal(layerGoalSource({ goalSource }), null);
  const scene = { width: 1920, height: 1080, waitFor: [], widgets: [
    { id: 'a', kind: 'custom', visible: true, config: { widgetId: 'w', goalSource: 'twitch', junk: 1 } },
    { id: 'b', kind: 'custom', visible: true, config: { widgetId: 'w', goalSource: 'dima' } }] } as never;
  const widgets = new Map([['w', { id: 'w', name: 'Goal bar', revision: 2, fields: [] }]]) as never;
  const published = buildPublished(scene, [], widgets);
  assert.deepEqual(published.widgets.map(w => w.config), [{ widgetId: 'w', revision: 2, goalSource: 'twitch' }, { widgetId: 'w', revision: 2 }]);
  const bad = { ...(scene as object), widgets: [{ id: 'c', kind: 'custom', visible: true, config: { widgetId: 'w', goalSource: 'both' } }] } as never;
  assert.throws(() => buildPublished(bad, [], widgets), /invalid goal source/);
});

test('the overlay layer contract accepts the goal source (Studio saves and the site validate with it)', () => {
  const layer = (config: Record<string, unknown>) => parseWidgetModuleConfig({ kind: 'custom', configVersion: 1, config }, 'scene');
  assert.deepEqual(layer({ widgetId: 'w', goalSource: 'twitch' })?.config, { widgetId: 'w', goalSource: 'twitch' });
  assert.ok(layer({ widgetId: 'w', goalSource: 'dima' }));
  assert.equal(layer({ widgetId: 'w', goalSource: 'both' }), undefined);
});
