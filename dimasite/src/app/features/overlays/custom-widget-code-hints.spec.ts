import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { hoverDoc, jsCompletions, jsonCompletions, placeholderCompletions, type HintContext } from './custom-widget-code-hints';
import { readPackage } from './custom-widget-format.generated';
import { editorKit, fieldsSchema, manifestSchema, widgetTypings } from './custom-widget-editor-kit';
import { readImport } from './custom-widget-import';
import { starterFiles, type StarterTexts } from './custom-widget-templates';
import { writeZip } from './custom-widget-zip';
import { EVENT_USES, type DimaSignal } from './widget-runtime/dima-events';
import { dimaSdk } from './widget-runtime/dima-sdk';
import { testAlert, testChat, testDimafx, testDuel, testGoals, testPet, testPolls, testReward, testRoulette, testTrigger, testTts } from './widget-runtime/test-events';
import { SE_SHIM_SCRIPT, seShim } from './widget-runtime/se-shim';
import { DIMA_EVENTS, SE_LISTENERS, TYPES } from './widget-runtime/sdk-reference';

const texts: StarterTexts = { groupLook: 'Look', groupChat: 'Chat', groupAlerts: 'Alerts', accent: 'Accent */ colour', text: 'Text', size: 'Size', max: 'Max', alerts: 'Alerts on',
  follow: '{name} followed!', sub: '{name} subscribed!', gift: '{name} gifted {amount}!', bits: '{name} cheered {amount}!', raid: '{name} raids with {amount}!', shout: 'Shout', shoutExample: 'Hello chat!' };
const dima = starterFiles('dima', 'Mine', texts), dimaPkg = readPackage({ ...dima, manifest: dima.manifest });
const hints = (engine: HintContext['engine'] = 'dima', uses: string[] = ['chat', 'alerts']): HintContext => ({ engine, uses, fields: dimaPkg.fields, dataKeys: ['legacy'] });
/** Runs one source at the end of `doc` (or at `|`). */
function complete(source: CompletionSource, doc: string, language: Extension): CompletionResult | null {
  const pos = doc.includes('|') ? doc.indexOf('|') : doc.length;
  const state = EditorState.create({ doc: doc.replace('|', ''), extensions: [language] });
  return source(new CompletionContext(state, pos, false)) as CompletionResult | null;
}
const labels = (result: CompletionResult | null) => result?.options.map(option => option.label) ?? null;

describe('SDK reference matches the runtime', () => {
  it('events, Dima members, SE_API members and SE listeners', () => {
    // `fields` is Studio-only (no uses entry, not a feed event).
    expect(DIMA_EVENTS.filter(e => e.name !== 'fields').map(e => [e.name, e.uses])).toEqual(Object.entries(EVENT_USES).map(([name, use]) => [name, use]));
    const win: Record<string, unknown> & { addEventListener: () => void } = { parent: { postMessage: () => {} }, console: {}, addEventListener: () => {}, setInterval: () => 0, setTimeout: () => 0,
      clearTimeout: () => {}, document: { readyState: 'complete' }, CustomEvent: class {}, dispatchEvent: () => true };
    dimaSdk(win, { exec: 'x', fields: {} });
    expect(Object.keys(win['Dima'] as object).sort()).toEqual(Object.keys(TYPES['DimaSDK'].props).sort());
    seShim(win);
    expect(Object.keys(win['SE_API'] as object).sort()).toEqual(Object.keys(TYPES['SEApi'].props).sort());
    // Builds may re-quote the inlined source, so either quote style.
    const used = new Set([...SE_SHIM_SCRIPT.matchAll(/received\((['"])([\w:-]+)\1/g), ...SE_SHIM_SCRIPT.matchAll(/\[(['"])([\w-]+-latest)\1/g)].map(match => match[2]));
    expect(SE_LISTENERS.map(l => l.name).filter(name => name !== 'tip-latest').sort()).toEqual([...used].filter(name => name !== 'tip-latest').sort());
  });
  it('every StreamElements payload the layer sends fits the SEEvent / SEMessageData typings', async () => {
    const handlers: Record<string, (data: unknown) => void> = {}, states: Record<string, (value: unknown) => void> = {}, details: { listener: string; event: Record<string, unknown> }[] = [];
    const Dima = { ready: () => Promise.resolve({ channel: { id: '1', login: 'c', name: 'C' }, fields: {}, mode: 'editor', session: null }), on: (type: string, fn: (data: unknown) => void) => { handlers[type] = fn; }, state: (name: string, fn: (value: unknown) => void) => { states[name] = fn; },
      storage: { get: async () => null, set: async () => undefined }, counters: { get: async () => 0 }, setField: async () => undefined, done: async () => undefined, html: () => '' };
    const win: Record<string, unknown> = { Dima, CustomEvent: window.CustomEvent, setTimeout: () => 0, clearTimeout: () => {}, console,
      dispatchEvent: (event: CustomEvent) => { if (event.type === 'onEventReceived') details.push(event.detail); return true; } };
    seShim(win);
    handlers['chat'](testChat('reply', testChat('emotes', null)));
    handlers['chat.delete']({ messageId: 'm', userId: 'u' }); handlers['chat.clear']({ userId: 'u' });
    for (const kind of ['follow', 'sub', 'resub', 'gift', 'giftBulk', 'bits', 'raid', 'tip'] as const) handlers['alert'](testAlert(kind));
    handlers['button']({ field: 'b', value: 1 }); handlers['storage']({ key: 'k', value: 2, namespace: 'se' });
    const signal: DimaSignal = { id: 's1', name: 'feed', value: 'pizza 2', json: null, args: ['pizza', '2'], at: 1, target: null, source: { kind: 'command', name: 'feed' },
      user: { id: '2', login: 'ada', name: 'Ada', roles: { broadcaster: false, moderator: false, vip: false, subscriber: true } } };
    expect(Object.keys(signal).sort()).toEqual(Object.keys(TYPES['DimaSignal'].props).sort());
    handlers['signal'](signal);
    // Live state and bot events reach StreamElements widgets as dima:* listeners, always as objects.
    await new Promise(r => setTimeout(r, 0)); // the SE layer subscribes to live state after onWidgetLoad
    states['polls'](testPolls()); states['goals'](testGoals());
    handlers['tts'](testTts('start')); handlers['trigger'](testTrigger()); handlers['reward'](testReward());
    handlers['pet'](testPet('done')); handlers['duel'](testDuel('ended')); handlers['roulette'](testRoulette('result')); handlers['dimafx'](testDimafx());
    for (const [type, value] of [['DimaPet', testPet('done')], ['DimaDuel', testDuel('ended')], ['DimaRoulette', testRoulette('result')], ['DimaDimafx', testDimafx()]] as const) expect(Object.keys(value).sort()).toEqual(Object.keys(TYPES[type].props).sort());
    for (const [type, value] of [['DimaTts', testTts('end')], ['DimaTrigger', testTrigger()], ['DimaReward', testReward()]] as const) expect(Object.keys(value).sort()).toEqual(Object.keys(TYPES[type].props).sort());
    expect(Object.keys(testGoals()[0] as object).sort()).toEqual(Object.keys(TYPES['DimaGoal'].props).sort());
    const eventKeys = new Set(Object.keys(TYPES['SEEvent'].props)), dataKeys = new Set(Object.keys(TYPES['SEMessageData'].props));
    expect(new Set(details.map(d => d.listener))).toEqual(new Set(SE_LISTENERS.map(l => l.name).filter(name => name !== 'tip-latest').concat('tip-latest')));
    for (const { listener, event } of details) {
      expect(Object.keys(event).filter(key => !eventKeys.has(key)), listener).toEqual([]);
      if (event['data'] && typeof event['data'] === 'object') expect(Object.keys(event['data']).filter(key => !dataKeys.has(key)), listener).toEqual([]);
    }
  });
  it('payload fields match real events (the Studio test events use the runtime shapes)', () => {
    const keys = (type: string) => Object.keys(TYPES[type].props).sort();
    const chat = testChat('emotes', null), reply = testChat('reply', chat), alert = testAlert('gift');
    expect(Object.keys(chat).sort()).toEqual(keys('DimaChat'));
    expect(Object.keys(chat.user).sort()).toEqual(keys('DimaChatUser'));
    expect(Object.keys(chat.user.roles).sort()).toEqual(keys('DimaRoles'));
    if (chat.user.badges.length) expect(Object.keys(chat.user.badges[0]).sort()).toEqual(keys('DimaBadge'));
    expect(Object.keys(reply.reply!).sort()).toEqual(keys('DimaReply'));
    expect(Object.keys(alert).sort()).toEqual(keys('DimaAlert'));
  });
});

describe('code editor suggestions', () => {
  const js = jsCompletions(() => hints()), se = jsCompletions(() => hints('streamelements')), lang = javascript();
  it('Dima members, nested objects, settings and event names (marking missing uses)', () => {
    expect(labels(complete(js, 'Dima.', lang))).toEqual(expect.arrayContaining(['on', 'fields', 'storage', 'ready', 'html', 'log']));
    expect(complete(js, 'Dima.', lang)!.options.find(option => option.label === 'on')!.apply).toBeTypeOf('function'); // snippet
    expect(labels(complete(js, 'Dima.storage.g', lang))).toEqual(['get', 'set']);
    expect(labels(complete(js, 'const c = Dima.fields.', lang))).toEqual(['accentColor', 'textColor', 'fontSize', 'maxMessages', 'showAlerts', 'legacy']);
    // Setting names that aren't identifiers are offered as ["name"].
    const odd = jsCompletions(() => ({ ...hints(), dataKeys: ['accent-color'] }));
    const view = new EditorView({ state: EditorState.create({ doc: 'Dima.fields.acc', extensions: [lang] }) });
    const option = complete(odd, 'Dima.fields.acc', lang)!.options.find(o => o.label === 'accent-color')!;
    (option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, 12, 15);
    expect(view.state.doc.toString()).toBe('Dima.fields["accent-color"]');
    view.destroy();
    const events = complete(js, "Dima.on('", lang)!;
    expect(events.options.map(o => o.label)).toEqual(DIMA_EVENTS.map(e => e.name));
    expect(events.options.find(o => o.label === 'storage')!.detail).toMatch(/needs "storage"/);
    expect(complete(js, 'foo.', lang)).toBeNull();
    // Built-in object names are not members (and never crash the lookup).
    for (const doc of ['Dima.toString.', 'Dima.storage.constructor.', 'Dima.fields.hasOwnProperty.', 'Dima.__proto__.']) expect(complete(js, doc, lang)).toBeNull();
  });
  it('accepting in the middle of a name replaces the whole name; no handler snippet when the call is written', () => {
    const mid = complete(js, 'Dima.fie|lds', lang)!;
    expect([mid.from, mid.to]).toEqual([5, 11]);
    const on = complete(js, "Dima.o|n('chat', m => {})", lang)!.options.find(o => o.label === 'on')!;
    expect(on.apply).toBeUndefined();
    expect(complete(js, 'Dima.o', lang)!.options.find(o => o.label === 'on')!.apply).toBeTypeOf('function');
    const odd = jsCompletions(() => ({ ...hints(), dataKeys: ['accent-color'] }));
    const result = complete(odd, 'Dima.fields.acc|entColor', lang)!, option = result.options.find(o => o.label === 'accent-color')!;
    const view = new EditorView({ state: EditorState.create({ doc: 'Dima.fields.accentColor', extensions: [lang] }) });
    (option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, result.from, result.to!);
    expect(view.state.doc.toString()).toBe('Dima.fields["accent-color"]');
    view.destroy();
  });
  it('handler parameters get their event type (level 2)', () => {
    expect(labels(complete(js, "Dima.on('chat', message => {\n  message.user.", lang))).toEqual(expect.arrayContaining(['name', 'color', 'badges', 'roles', 'subMonths']));
    expect(labels(complete(js, "Dima.on('chat', message => {\n  message.user.roles.", lang))).toEqual(expect.arrayContaining(['moderator', 'vip']));
    expect(labels(complete(js, "Dima.on('alert', function (a) {\n  if (a.", lang))).toEqual(expect.arrayContaining(['amount', 'user', 'tier', 'type']));
    expect(labels(complete(js, 'Dima.ready().then(ctx => ctx.channel.', lang))).toEqual(['id', 'login', 'name']);
    expect(labels(complete(js, 'Dima.ready().', lang))).toBeNull(); // a Promise, not a type we complete
    expect(labels(complete(js, "Dima.on('chat', m => {\n  const f = (m) => m.", lang))).toBeNull(); // shadowed parameter
    expect(labels(complete(js, "Dima.on('chat', ({ user }) => user.", lang))).toBeNull(); // destructured: unknown
    expect(labels(complete(js, "Dima.on('signal:feed', s => s.", lang))).toEqual(expect.arrayContaining(['name', 'value', 'json', 'args', 'user', 'source', 'target']));
    expect(labels(complete(js, "Dima.on('signal', s => s.user.roles.", lang))).toEqual(expect.arrayContaining(['moderator', 'subscriber']));
  });
  it('signals declared in widget.json are suggested as signal:<name> events', () => {
    const declared = jsCompletions(() => ({ ...hints('dima', ['chat', 'signals']), signals: ['feed', 'pet'] }));
    const options = complete(declared, "Dima.on('", lang)!.options;
    expect(options.map(o => o.label)).toEqual([...DIMA_EVENTS.map(e => e.name), 'signal:feed', 'signal:pet']);
    expect(options.find(o => o.label === 'signal:feed')!.detail).toBe('DimaSignal');
    const missing = jsCompletions(() => ({ ...hints(), signals: ['feed'] }));
    expect(complete(missing, "Dima.on('", lang)!.options.find(o => o.label === 'signal:feed')!.detail).toMatch(/needs "signals"/);
    expect(labels(complete(se, "window.addEventListener('onEventReceived', obj => {\n  if (obj.detail.listener === '", lang))).toContain('dima:signal');
  });
  it('StreamElements: SE_API, events, listener names, event details and {key} placeholders in JS', () => {
    expect(labels(complete(se, 'SE_API.', lang))).toEqual(expect.arrayContaining(['store', 'counters', 'resumeQueue']));
    expect(complete(js, 'SE_API.', lang)).toBeNull(); // Dima widgets have no SE_API
    expect(labels(complete(se, "window.addEventListener('", lang))).toEqual(['onWidgetLoad', 'onEventReceived', 'onSessionUpdate']);
    const handler = "window.addEventListener('onEventReceived', obj => {\n  ";
    expect(labels(complete(se, handler + 'obj.', lang))).toEqual(['detail']);
    expect(labels(complete(se, handler + 'obj.detail.', lang))).toEqual(['listener', 'event']);
    expect(labels(complete(se, handler + 'obj.detail.event.data.', lang))).toEqual(expect.arrayContaining(['displayName', 'text', 'msgId']));
    expect(labels(complete(se, handler + "if (obj.detail.listener === '", lang))).toEqual(expect.arrayContaining(['message', 'follower-latest', 'widget-button']));
    expect(labels(complete(se, "window.addEventListener('onWidgetLoad', obj => obj.detail.fieldData.", lang))).toContain('accentColor');
    expect(labels(complete(se, 'const c = "{acc', lang))).toContain('accentColor'); // SE replaces placeholders in JS strings too
    expect(complete(js, 'const c = {acc', lang)).toBeNull(); // Dima JS has no placeholders
  });
  it('{key} placeholders in HTML and CSS values, not after a CSS rule brace', () => {
    const htmlSource = placeholderCompletions(() => hints(), false), cssSource = placeholderCompletions(() => hints(), true);
    expect(labels(complete(htmlSource, '<p style="color: {te|"></p>', html()))).toContain('textColor');
    expect(labels(complete(cssSource, '.row { color: {acc', css()))).toContain('accentColor');
    expect(complete(cssSource, '.row { co', css())).toBeNull();
  });
  it('widget.json, fields and data', () => {
    const manifest = jsonCompletions('manifest', () => hints()), fields = jsonCompletions('fields', () => hints()), data = jsonCompletions('data', () => hints());
    expect(labels(complete(manifest, '{ "engine": "', json()))).toEqual(['dima', 'streamelements']);
    expect(labels(complete(manifest, '{ "engine": "dima", "uses": ["chat", "', json()))).toEqual(['chat', 'alerts', 'storage', 'counters', 'session', 'signals', 'polls', 'goals', 'tts', 'triggers', 'rewards', 'pets', 'duels', 'roulette', 'dimafx']);
    expect(labels(complete(manifest, '{ "engine": "dima", "', json()))).not.toContain('engine');
    expect(labels(complete(fields, '{ "x": { "type": "', json()))).toEqual(expect.arrayContaining(['colorpicker', 'slider', 'hidden']));
    expect(labels(complete(fields, '{ "x": { "', json()))).toEqual(expect.arrayContaining(['type', 'label', 'value', 'group']));
    expect(labels(complete(fields, '{ "x": { "group": "', json()))).toEqual(['Look', 'Chat', 'Alerts']);
    const quoted = jsonCompletions('fields', () => ({ ...hints(), fields: [{ key: 'a', type: 'text', label: 'A', group: 'A "quoted" \\ group' }] }));
    expect(complete(quoted, '{ "x": { "group": "', json())!.options[0].apply).toBe('A \\"quoted\\" \\\\ group');
    expect(labels(complete(data, '{\n  "', json()))).toContain('maxMessages');
    expect(complete(data, '{ "maxMessages": "', json())).toBeNull();
  });
  it('hover docs for members and event names', () => {
    const at = (doc: string, word: string, engine: HintContext['engine'] = 'dima') => {
      const state = EditorState.create({ doc, extensions: [javascript()] });
      return hoverDoc(state, doc.indexOf(word) + 1, hints(engine));
    };
    expect(at('Dima.storage.get("x")', 'storage')).toMatchObject({ title: 'storage: DimaStorage' });
    expect(at('Dima.storage.get("x")', 'get')!.title).toMatch(/get — get\(key\)/);
    expect(at("Dima.on('chat', m => m.user.name)", 'chat')).toMatchObject({ title: 'chat → DimaChat' });
    expect(at("Dima.on('chat', m => m.user.name)", 'name')!.doc).toBe('Display name.');
    expect(at('SE_API.resumeQueue()', 'resumeQueue', 'streamelements')!.doc).toMatch(/widgetDuration/);
  });
});

describe('download for your code editor', () => {
  it('typings: settings typed from fields, Dima vs StreamElements globals, labels escaped', () => {
    const typings = widgetTypings(dimaPkg.fields, ['legacy'], 'dima');
    expect(typings).toContain('interface WidgetFields {');
    expect(typings).toMatch(/accentColor: string;[\s\S]*fontSize: number;[\s\S]*showAlerts: boolean;[\s\S]*legacy: any;/);
    expect(typings).toContain('Accent *\\/ colour'); // a label can't close the doc comment
    expect(typings).toContain('declare const Dima: DimaSDK;');
    expect(typings).toContain('"1x": string;');
    expect(typings).not.toContain('SE_API');
    const seTypings = widgetTypings(dimaPkg.fields, [], 'streamelements');
    expect(seTypings).toMatch(/declare const SE_API: SEApi;[\s\S]*interface WindowEventMap \{\s*onWidgetLoad: CustomEvent<SEWidgetLoad>;/);
    expect(seTypings).toContain('interface Window { SE_API: SEApi; }');
    expect(typings).toContain('interface Window { Dima: DimaSDK; }');
    expect(typings).toContain('[name: `signal:${string}`]: DimaSignal;');
    expect(typings).toMatch(/interface DimaSignal \{[\s\S]*value: string;/);
  });
  it('the widget.json schema lists declared signals', () => {
    const signals = JSON.parse(manifestSchema()).properties.signals;
    expect(signals.items.properties.name.pattern).toBe('^[a-z0-9_]{1,40}$');
    expect(signals.maxItems).toBe(30);
  });
  it('the fields schema suggests standard types but accepts others the importer takes', () => {
    const schema = JSON.parse(fieldsSchema()), type = schema.additionalProperties.properties.type;
    expect(type.anyOf).toEqual([expect.objectContaining({ enum: expect.arrayContaining(['colorpicker', 'slider']) }), { type: 'string' }]);
    expect(schema.additionalProperties.properties.options.additionalProperties.type).toEqual(['string', 'number']);
  });
  it('files without code still hand over what was found (the editor loads settings-only files)', async () => {
    const draft = await readImport([{ path: 'fields.json', blob: new Blob([dima.fields]) }]);
    expect(draft.error).toBe('noCode');
    expect(draft.source?.fields).toBe(dima.fields);
    expect(draft.parts.filter(part => part.name).map(part => part.file)).toEqual(['fields']);
  });
  it('the kit round-trips through the importer (folder in a zip, widget.ini with real names)', async () => {
    const kit = editorKit(dima, dimaPkg.fields, [], 'dima', '# Mine');
    expect(kit.map(file => file.name)).toEqual(['widget.ini', 'widget.html', 'widget.css', 'widget.js', 'fields.json', 'data.json', 'widget.json', 'dima.d.ts', 'jsconfig.json',
      '.vscode/settings.json', '.vscode/fields.schema.json', '.vscode/widget.schema.json', 'README.md']);
    const draft = await readImport([{ path: 'Mine.zip', blob: writeZip(kit.map(file => ({ name: `Mine/${file.name}`, text: file.text }))) }]);
    expect(draft.error).toBe('');
    expect(draft.source).toEqual({ html: dima.html, css: dima.css, js: dima.js, fields: dima.fields, data: dima.data, manifest: dima.manifest });
  });
});
