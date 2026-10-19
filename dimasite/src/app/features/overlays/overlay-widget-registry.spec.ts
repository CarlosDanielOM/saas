import { describe, expect, it } from 'vitest';
import { createWidget, getWidgetModule, widgetModuleFor, widgetPalette } from './overlay-widget-registry';
import { WIDGET_DEFINITIONS, validWidgetModuleConfig } from './overlay-widget-contract.generated';
import { interactionDesign } from './overlay-interaction.model';
import { acceptWidgetStates, legacyWidgetStates, stateForWidget, WidgetStateTransport } from './overlay-widget-state';
import type { OverlayWidget } from './overlay.model';

const poll = (): OverlayWidget => createWidget('poll', { id: 'poll-a', placement: 'scene' })!;
describe('overlay widget modules', () => {
  it('registers every portable definition and preserves scene/design palette ordering', () => {
    for (const definition of WIDGET_DEFINITIONS) {
      expect(getWidgetModule(definition.kind)?.definition).toBe(definition);
      if (definition.delivery === 'state') {
        expect(getWidgetModule(definition.kind)?.renderer).toBeDefined();
        expect(getWidgetModule(definition.kind)?.settings).toBeDefined();
        expect(getWidgetModule(definition.kind)?.preview?.fixtures.length).toBeGreaterThan(0);
      }
    }
    expect(widgetPalette('scene')).toEqual(['poll', 'prediction', 'tts', 'trigger', 'clip', 'alert', 'image', 'video', 'shape']);
    expect(widgetPalette('design')).toEqual(['text', 'image', 'video', 'animation', 'shape']);
  });
  it('creates independent defaults with context and rejects unsupported placements', () => {
    const first = createWidget('alert', { id: 'alert-a', placement: 'scene', position: { x: 10, y: 20 }, defaultDesignId: 'design-a' })!;
    const second = createWidget('alert', { id: 'alert-b', placement: 'scene', defaultDesignId: 'design-b' })!;
    first.events!.pop();
    expect(second.events).toEqual(['sub', 'bits', 'follow', 'raid']);
    expect(first).toMatchObject({ x: 10, y: 20, width: 640, height: 192, designId: 'design-a', configVersion: 1 });
    expect(second.designId).toBe('design-b');
    expect(poll()).toMatchObject({ width: 560, height: 360, interactionDesign: 'card' });
    expect(createWidget('prediction', { id: 'prediction-a', placement: 'scene' })).toMatchObject({ height: 460 });
    expect(createWidget('poll', { id: 'invalid', placement: 'design' })).toBeNull();
    expect(createWidget('animation', { id: 'invalid', placement: 'scene' })).toBeNull();
  });
  it('accepts legacy config, validates namespaced presets, and safely rejects unknown/future config', () => {
    const legacy = { ...poll(), configVersion: undefined };
    expect(widgetModuleFor(legacy, 'scene')).toBeDefined();
    expect(widgetModuleFor({ ...legacy, configVersion: 2 }, 'scene')).toBeUndefined();
    expect(getWidgetModule('unknown')).toBeUndefined();
    expect(getWidgetModule('__proto__')).toBeUndefined();
    expect(validWidgetModuleConfig({ ...legacy, interactionDesign: 'unknown' }, 'scene')).toBe(false);
    expect(validWidgetModuleConfig({ ...legacy, config: { interactionDesign: 'compact' } }, 'scene')).toBe(true);
    expect(validWidgetModuleConfig({ ...legacy, config: { unknown: true } }, 'scene')).toBe(false);
    expect(interactionDesign({ ...legacy, interactionDesign: 'card', config: { interactionDesign: 'compact' } })).toBe('compact');
  });
  it('keeps fixture choices inside modules and creates preview data without touching live state', () => {
    const pollPreview = getWidgetModule('poll')!.preview!, predictionPreview = getWidgetModule('prediction')!.preview!;
    expect(pollPreview.fixtures.map(fixture => fixture.id)).toContain('tie');
    expect(pollPreview.fixtures.map(fixture => fixture.id)).not.toContain('locked');
    expect(predictionPreview.fixtures.map(fixture => fixture.id)).toContain('locked');
    const a = pollPreview.create('result', key => key), b = pollPreview.create('result', key => key);
    expect(a).not.toBe(b);
    expect(a).toMatchObject({ kind: 'poll', phase: 'completed' });
    expect(predictionPreview.create('locked', key => key)).toMatchObject({ kind: 'prediction', phase: 'locked' });
  });
});
describe('shared scene widget state', () => {
  it('shares state across independent placements without sharing their presets', () => {
    const first = poll(), second = { ...poll(), id: 'poll-b', interactionDesign: 'compact' as const };
    const state = { id: 'live' }, states = { poll: { revision: 10, state } };
    expect(stateForWidget(first, states)).toBe(state);
    expect(stateForWidget(second, states)).toBe(state);
    expect(interactionDesign(first)).toBe('card'); expect(interactionDesign(second)).toBe('compact');
    expect(stateForWidget({ ...first, configVersion: 2 }, states)).toBeNull();
  });
  it('guards older module revisions but accepts explicit null at revision zero and full-snapshot removal', () => {
    const previous = { poll: { revision: 10, state: { id: 'current' } }, prediction: { revision: 5, state: { id: 'other' } } };
    expect(acceptWidgetStates(previous, { poll: { revision: 9, state: { id: 'old' } } })).toEqual({ poll: previous.poll });
    expect(acceptWidgetStates(previous, { poll: { revision: 0, state: null } })).toEqual({ poll: { revision: 0, state: null } });
    expect(acceptWidgetStates(previous, {})).toEqual({});
  });
  it('preserves failed sources only while their visible supported placements are requested', () => {
    const previous = { poll: { revision: 10, state: { id: 'current' } } }, widget = poll();
    expect(acceptWidgetStates(previous, {}, [widget], ['twitch-interactions'])).toEqual(previous);
    expect(acceptWidgetStates(previous, {}, [], ['twitch-interactions'])).toEqual({});
    expect(acceptWidgetStates(previous, {}, [{ ...widget, visible: false }], ['twitch-interactions'])).toEqual({});
    expect(acceptWidgetStates(previous, {}, [{ ...widget, configVersion: 2 }], ['twitch-interactions'])).toEqual({});
    expect(acceptWidgetStates(previous, { poll: { revision: 0, state: null } }, [widget], ['twitch-interactions'])).toEqual({ poll: { revision: 0, state: null } });
  });
  it('adapts legacy interaction snapshots through registered state keys', () => {
    expect(legacyWidgetStates({ poll: null, prediction: null, serverTime: 123 })).toEqual({ poll: { revision: 0, state: null }, prediction: { revision: 0, state: null } });
  });
  it('negotiates generic capability per connection and accepts legacy state after server rollback', () => {
    const transport = new WidgetStateTransport(), initial = { widgetStates: { poll: { revision: 4, state: { id: 'new-server' } } }, serverTime: 1000 };
    transport.begin(initial); expect(transport.accept(initial)?.widgetStates).toEqual(initial.widgetStates);
    const legacy = { interactions: { poll: null, prediction: null, serverTime: 900 } };
    expect(transport.accept(legacy)).toBeNull();
    expect(transport.accept({ widgetStates: {}, serverTime: 999 })).toBeNull();
    // A fresh handshake resets both capability and clock ordering without clearing playback.
    transport.begin(legacy);
    expect(transport.accept(legacy)?.widgetStates).toEqual({ poll: { revision: 0, state: null }, prediction: { revision: 0, state: null } });
    expect(transport.accept({ interactions: { ...legacy.interactions, serverTime: 901 } })).not.toBeNull();
    const upgraded = { widgetStates: {}, serverTime: 902 };
    transport.begin(upgraded); expect(transport.accept(upgraded)?.widgetStates).toEqual({});
    expect(transport.accept({ interactions: { ...legacy.interactions, serverTime: 903 } })).toBeNull();
  });
});
