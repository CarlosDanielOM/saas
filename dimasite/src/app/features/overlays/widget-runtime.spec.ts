import { afterEach, describe, expect, it } from 'vitest';
import { buildFrameDocument, rewriteMedia, substitute, type WidgetBundle } from './widget-runtime/frame-document';
import { dimaSdk } from './widget-runtime/dima-sdk';
import { seShim } from './widget-runtime/se-shim';
import { testAlert, testChat } from './widget-runtime/test-events';

const bundle = (engine: 'dima' | 'streamelements', extra: Partial<WidgetBundle> = {}): WidgetBundle => ({
  widgetId: 'a'.repeat(24), revision: 1, engine, uses: ['chat'], html: '<p data-x="{color}">{{ name }}</p>', css: '.a { color: {color}; } .b { x: { }; }',
  js: 'const c = "{color}"; const s = "</script><b>";', media: {}, ...extra
});
const scripts = { sdk: 'function sdk(){/*SDK*/}', shim: '/*SHIM*/', jquery: '/*JQUERY*/' };
const boot = { exec: 'run-1', origin: 'https://domdimabot.com' };

describe('custom widget frame document', () => {
  it('substitutes {key} and {{key}} for known settings only, like StreamElements', () => {
    expect(substitute('a {x} b {{ y }} c { } d {missing} e {list}', { x: 1, y: 'two', list: ['p', 'q'] })).toBe('a 1 b two c { } d {missing} e p,q');
    expect(substitute('{n}', { n: null })).toBe('');
  });
  it('rewrites copied media URLs (longest first)', () => {
    expect(rewriteMedia('url(https://cdn.x/a.png) https://cdn.x/a.png.webm', { 'https://cdn.x/a.png': 'L1', 'https://cdn.x/a.png.webm': 'L2' })).toBe('url(L1) L2');
  });
  it('orders scripts and substitutes per engine, without letting values close our tags', () => {
    const se = buildFrameDocument(bundle('streamelements'), { color: 'red', name: 'Ana' }, scripts, boot);
    expect(se).toContain('(function sdk(){/*SDK*/})(window, {"exec":"run-1","fields":{"color":"red","name":"Ana"}});');
    expect(se).toContain('<base href="https://domdimabot.com/">');
    expect(se).toContain("object-src 'none'; form-action 'none'");
    expect(se.indexOf('/*SDK*/')).toBeLessThan(se.indexOf('/*JQUERY*/'));
    expect(se.indexOf('/*JQUERY*/')).toBeLessThan(se.indexOf('/*SHIM*/'));
    expect(se).toContain('<p data-x="red">Ana</p>');
    expect(se).toContain('.a { color: red; } .b { x: { }; }');
    expect(se).toContain('const c = "red"');
    expect(se).toContain('<\\/script><b>');
    expect(se.match(/<\/script>/g)!.length).toBe(4);
    const dima = buildFrameDocument(bundle('dima'), { color: 'red', name: 'Ana' }, scripts, boot);
    expect(dima).not.toContain('/*JQUERY*/');
    expect(dima).not.toContain('/*SHIM*/');
    expect(dima).toContain('const c = "{color}"');
    const evil = buildFrameDocument(bundle('streamelements', { css: '.a{color:{color}}' }), { color: 'x</style><script>alert(1)</script>' }, scripts, boot);
    expect(evil).not.toContain('"fields":{"color":"x</');
    expect(evil).toContain('<\\/style>');
  });
});

describe('Dima SDK and StreamElements layer (inside a fake frame)', () => {
  const host: { data: Record<string, unknown> }[] = [];
  const onHost = (event: MessageEvent) => { if (event.data?.dima === 1) host.push({ data: event.data }); };
  const send = (data: Record<string, unknown>, exec = 'run-1') => window.dispatchEvent(new MessageEvent('message', { source: window, data: { dima: 1, exec, ...data } }));
  afterEach(() => { window.removeEventListener('message', onHost); });

  it('starts, delivers SE-shaped events and maps SE_API to Dima calls', async () => {
    window.addEventListener('message', onHost);
    const win = window as unknown as Record<string, unknown>;
    const seEvents: CustomEvent[] = [];
    window.addEventListener('onWidgetLoad', e => seEvents.push(e as CustomEvent));
    window.addEventListener('onEventReceived', e => seEvents.push(e as CustomEvent));
    window.addEventListener('onSessionUpdate', e => seEvents.push(e as CustomEvent));
    dimaSdk(window, { exec: 'run-1', fields: { color: 'boot' } }); seShim(window);
    expect(typeof (win['Dima'] as { ready: unknown }).ready).toBe('function');
    expect((win['Dima'] as { fields: unknown }).fields).toEqual({ color: 'boot' }); // settings before init
    send({ type: 'init', context: { fields: { color: 'stale' } } }, 'old-run');
    await new Promise(r => setTimeout(r, 0));
    expect(seEvents.length).toBe(0); // messages for an earlier run are ignored
    expect(typeof (win['SE_API'] as { store: unknown }).store).toBe('object');
    send({ type: 'init', context: { widget: { id: 'w' }, channel: { id: '1', login: 'chan', name: 'Chan' }, fields: { color: 'red' }, mode: 'editor', session: { data: { 'follower-latest': { name: 'Sam' } }, recents: [] } } });
    await new Promise(r => setTimeout(r, 0));
    const load = seEvents.find(e => e.type === 'onWidgetLoad')!;
    expect(load.detail.fieldData).toEqual({ color: 'red' });
    expect(load.detail.channel.username).toBe('chan');
    expect(load.detail.overlay).toEqual({ isEditorMode: true, muted: false });
    expect(load.detail.session.data['follower-latest']).toEqual({ name: 'Sam' });

    const chat = testChat('emotes'); chat.user.roles.vip = true;
    send({ type: 'event', event: { type: 'chat', data: chat } });
    const message = seEvents.find(e => e.type === 'onEventReceived' && e.detail.listener === 'message')!.detail.event;
    expect(message.data.text).toBe('this stream Kappa LUL so good SeemsGood');
    expect(message.data.emotes.map((e: { name: string; start: number; end: number }) => [e.name, e.start, e.end])).toEqual([['Kappa', 12, 16], ['LUL', 18, 20], ['SeemsGood', 30, 38]]);
    expect(message.data.emotes[0].urls[4]).toContain('/25/static/dark/3.0');
    expect(message.data.tags).toMatchObject({ subscriber: '1', vip: '1', mod: '0', 'first-msg': '0', 'badge-info': 'subscriber/14', 'room-id': '1' });
    expect(message.data.tags.emotes.split('/').sort()).toEqual(['25:12-16', '425618:18-20', '64138:30-38']);
    expect(message.renderedText).toContain('<img class="dima-emote"');

    send({ type: 'event', event: { type: 'alert', data: testAlert('giftBulk') } });
    const gift = seEvents.filter(e => e.detail?.listener === 'subscriber-latest').at(-1)!.detail.event;
    expect(gift).toMatchObject({ name: 'Yuzu', amount: 5, bulkGifted: true, gifted: true, sender: 'Yuzu', isCommunityGift: true });
    const session = seEvents.filter(e => e.type === 'onSessionUpdate').at(-1)!.detail.session;
    expect(session['subscriber-session']).toEqual({ count: 1 });
    send({ type: 'event', event: { type: 'alert', data: testAlert('bits') } });
    expect(seEvents.filter(e => e.detail?.listener === 'cheer-latest').at(-1)!.detail.event).toMatchObject({ name: 'Ame', amount: 500 });
    send({ type: 'event', event: { type: 'chat.delete', data: { messageId: 'm1', userId: 'u' } } });
    expect(seEvents.filter(e => e.detail?.listener === 'delete-message').at(-1)!.detail.event).toEqual({ msgId: 'm1' });
    send({ type: 'event', event: { type: 'storage', data: { key: 'score', value: 3 } } });
    expect(seEvents.filter(e => e.detail?.listener === 'kvstore:update').at(-1)!.detail.event).toEqual({ data: { key: 'customWidget.score', value: 3 } });
    send({ type: 'event', event: { type: 'button', data: { field: 'test', value: 'v' } } });
    expect(seEvents.filter(e => e.detail?.listener === 'widget-button').at(-1)!.detail.event).toEqual({ listener: 'widget-button', field: 'test', value: 'v' });

    // SE_API.store.get → Dima RPC → host reply.
    const seApi = win['SE_API'] as { store: { get: (key: string) => Promise<unknown> }; cheerFilter: (text: string) => Promise<string> };
    const pending = seApi.store.get('score');
    await new Promise(r => setTimeout(r, 0));
    const rpc = host.find(item => item.data['type'] === 'rpc')!.data;
    expect(rpc).toMatchObject({ method: 'store.get', params: { key: 'score' } });
    send({ type: 'rpc-result', id: rpc['id'], ok: true, value: 42 });
    await expect(pending).resolves.toBe(42);
    await expect(seApi.cheerFilter('Cheer100 nice Kappa10 cheer5 cheerful')).resolves.toBe('nice cheerful');
    // The SDK reports it loaded after the DOM is ready, and messages from other windows are ignored.
    expect(host.some(item => item.data['type'] === 'loaded' && item.data['exec'] === 'run-1')).toBe(true);
    // widgetDuration queue: the second alert waits for resumeQueue().
    (win['Dima'] as { fields: Record<string, unknown> }).fields['widgetDuration'] = 30;
    const before = seEvents.filter(e => e.detail?.listener === 'follower-latest').length;
    send({ type: 'event', event: { type: 'alert', data: testAlert('follow') } });
    send({ type: 'event', event: { type: 'alert', data: testAlert('follow') } });
    expect(seEvents.filter(e => e.detail?.listener === 'follower-latest').length).toBe(before + 1);
    (win['SE_API'] as { resumeQueue: () => void }).resumeQueue();
    expect(seEvents.filter(e => e.detail?.listener === 'follower-latest').length).toBe(before + 2);
    // counters.get carries both documented and legacy shapes.
    const counter = (win['SE_API'] as { counters: { get: (name: string) => Promise<unknown> } }).counters.get('deaths');
    await new Promise(r => setTimeout(r, 0));
    const call = host.filter(item => item.data['type'] === 'rpc').at(-1)!.data;
    send({ type: 'rpc-result', id: call['id'], ok: true, value: 7 });
    await expect(counter).resolves.toEqual({ id: 'deaths', count: 7, counter: 'deaths', value: 7 });
  });
});
