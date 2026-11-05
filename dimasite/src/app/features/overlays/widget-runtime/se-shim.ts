/**
 * StreamElements translation layer v1. Runs after the Dima SDK (and jQuery) inside frames of widgets whose
 * engine is `streamelements`, and is built only from public Dima SDK calls. Inlined as text (`SE_SHIM_SCRIPT`):
 * keep the function self-contained. Mapping: dimabot/CUSTOM_WIDGET_ENGINE.md, section 5.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function seShim(win: any): void {
  'use strict';
  const Dima = win.Dima;
  if (!Dima) return;
  let ctx: any = null;
  const session: any = { data: {}, recents: [] };
  const fire = (name: string, detail: unknown) => {
    try { win.dispatchEvent(new win.CustomEvent(name, { detail })); }
    catch (error: any) { win.console?.error?.(error); }
  };
  const received = (listener: string, event: unknown) => fire('onEventReceived', { listener, event });
  const CHEERMOTES = ['cheer', 'doodlecheer', 'biblethump', 'cheerwhal', 'corgo', 'uni', 'showlove', 'party', 'seemsgood', 'pride', 'kappa',
    'frankerz', 'heyguys', 'dansgame', 'elegiggle', 'trihard', 'kreygasm', '4head', 'swiftrage', 'notlikethis', 'failfish', 'vohiyo', 'pjsalt',
    'mrdestructoid', 'bday', 'ripcheer', 'shamrock', 'bitboss', 'streamlabs', 'muxy', 'holidaycheer', 'goal', 'anon', 'charity'];
  const cheerPattern = new RegExp('(^|\\s)(?:' + CHEERMOTES.join('|') + ')\\d+(?=\\s|$)', 'gi');

  const toMessage = (m: any) => {
    const roles = m.user?.roles ?? {};
    const emotes: any[] = [], ranges: Record<string, string[]> = {};
    let position = 0;
    for (const part of m.parts ?? []) {
      const length = Array.from(String(part.text ?? '')).length;
      if (part.type === 'emote' && length) {
        const end = position + length - 1;
        emotes.push({ type: 'twitch', name: part.text, id: part.id, gif: !!part.animated, animated: !!part.animated,
          urls: { 1: part.images?.['1x'] ?? '', 2: part.images?.['2x'] ?? '', 4: part.images?.['4x'] ?? '' }, start: position, end });
        (ranges[part.id] ??= []).push(position + '-' + end);
      }
      position += length;
    }
    const badges = (m.user?.badges ?? []).map((b: any) => ({ type: b.set, version: b.version, url: b.images?.['4x'] || b.images?.['1x'] || '', description: b.title }));
    const tags: Record<string, string> = {
      'badge-info': m.user?.subMonths != null ? 'subscriber/' + m.user.subMonths : '',
      badges: (m.user?.badges ?? []).map((b: any) => b.set + '/' + b.version).join(','),
      color: m.user?.color || '', 'display-name': m.user?.name ?? '', emotes: Object.entries(ranges).map(([id, list]) => id + ':' + list.join(',')).join('/'),
      'first-msg': m.firstMessage ? '1' : '0', flags: '', id: m.id, mod: roles.moderator ? '1' : '0', 'returning-chatter': '0',
      'room-id': ctx?.channel?.id ?? '', subscriber: roles.subscriber ? '1' : '0', 'tmi-sent-ts': String(m.at ?? Date.now()),
      turbo: roles.turbo ? '1' : '0', 'user-id': m.user?.id ?? '', 'user-type': roles.moderator ? 'mod' : ''
    };
    if (roles.vip) tags['vip'] = '1';
    if (m.reply) Object.assign(tags, { 'reply-parent-msg-id': m.reply.id, 'reply-parent-user-id': m.reply.user?.id ?? '', 'reply-parent-user-login': m.reply.user?.login ?? '',
      'reply-parent-display-name': m.reply.user?.name ?? '', 'reply-parent-msg-body': m.reply.text ?? '' });
    return {
      service: 'twitch', renderedText: Dima.html(m),
      data: { time: m.at ?? Date.now(), tags, nick: m.user?.login ?? '', userId: m.user?.id ?? '', displayName: m.user?.name ?? '', displayColor: m.user?.color || '',
        badges, channel: ctx?.channel?.login ?? '', text: m.text ?? '', isAction: !!m.action, emotes, msgId: m.id }
    };
  };
  const name = (user: any) => user?.name ?? user?.login ?? 'Anonymous';
  const toAlert = (a: any): [string, string, any] | null => {
    const base = { type: '', name: name(a.user), amount: Number(a.amount) || 0, message: a.message ?? '', _id: a.id, createdAt: new Date(a.at ?? Date.now()).toISOString() };
    // No object spread in this file (see dima-sdk.ts): extend() copies fields instead.
    const extend = (extra: Record<string, unknown>) => Object.assign({}, base, extra);
    switch (a.type) {
      case 'follow': return ['follower-latest', 'follower', extend({ type: 'follower', amount: 1 })];
      case 'sub': case 'resub': return ['subscriber-latest', 'subscriber', extend({ type: 'subscriber', amount: Number(a.months ?? a.amount) || 1, tier: a.tier ?? '1000',
        gifted: false, sender: '', bulkGifted: false, isCommunityGift: false, playedAsCommunityGift: false, streak: a.streak ?? undefined })];
      case 'gift': return a.recipient
        ? ['subscriber-latest', 'subscriber', extend({ type: 'subscriber', name: name(a.recipient), amount: 1, tier: a.tier ?? '1000', gifted: true, sender: name(a.user), bulkGifted: false, isCommunityGift: false })]
        : ['subscriber-latest', 'subscriber', extend({ type: 'subscriber', amount: Number(a.amount) || 1, tier: a.tier ?? '1000', gifted: true, sender: name(a.user), bulkGifted: true, isCommunityGift: true })];
      case 'bits': return ['cheer-latest', 'cheer', extend({ type: 'cheer' })];
      case 'raid': return ['raid-latest', 'raid', extend({ type: 'raid' })];
      case 'tip': return ['tip-latest', 'tip', extend({ type: 'tip', currency: a.currency ?? 'USD' })];
      default: return null;
    }
  };
  const bump = (prefix: string, event: any) => {
    const data = session.data;
    data[prefix + '-latest'] = event;
    data[prefix + '-recent'] = [event, ...(Array.isArray(data[prefix + '-recent']) ? data[prefix + '-recent'] : [])].slice(0, 25);
    const counted = prefix === 'cheer' || prefix === 'tip' ? event.amount : 1;
    for (const span of ['session', 'week', 'month', 'total']) {
      const key = prefix + '-' + span, current = data[key] && typeof data[key] === 'object' ? data[key] : {};
      data[key] = prefix === 'cheer' || prefix === 'tip' ? Object.assign({}, current, { amount: (Number(current.amount) || 0) + counted }) : Object.assign({}, current, { count: (Number(current.count) || 0) + counted });
    }
    session.recents = [event, ...session.recents].slice(0, 25);
  };

  const status = () => ({ isEditorMode: ctx?.mode === 'editor', muted: !!ctx?.muted });
  // StreamElements' alert queue: with a widgetDuration setting, alerts play one at a time for that many
  // seconds or until the widget calls SE_API.resumeQueue(). Chat and other events never wait.
  const queue: [string, string, any][] = [];
  let holding = false, holdTimer: any = null;
  const release = () => { if (holdTimer) win.clearTimeout(holdTimer); holdTimer = null; holding = false; drain(); };
  const drain = () => {
    while (!holding && queue.length) {
      const [listener, prefix, event] = queue.shift()!;
      bump(prefix, event);
      received(listener, event);
      fire('onSessionUpdate', { session: session.data });
      const hold = Number(ctx?.fields?.widgetDuration) || 0;
      if (hold > 0) { holding = true; holdTimer = win.setTimeout(release, Math.min(hold, 300) * 1000); }
    }
  };
  win.SE_API = Object.freeze({
    store: Object.freeze({ get: (key: string) => Dima.store.get(key), set: (key: string, value: unknown) => Dima.store.set(key, value) }),
    // Documented shape { id, count }; older widgets read { counter, value }, so both are present.
    counters: Object.freeze({ get: (counter: string) => Dima.counters.get(counter).then((value: number) => ({ id: counter, count: value, counter, value })) }),
    sanitize: (input: { message?: string }) => Promise.resolve({ skip: false, result: { message: String(input?.message ?? '') } }),
    cheerFilter: (text: string) => Promise.resolve(String(text ?? '').replace(cheerPattern, '$1').replace(/\s{2,}/g, ' ').trim()),
    getOverlayStatus: () => Promise.resolve(status()),
    resumeQueue: () => { void Dima.done(); release(); },
    setField: (key: string, value: unknown, reload = true) => { if (ctx) ctx.fields[key] = value; return Dima.setField(key, value, reload); }
  });

  Dima.ready().then((context: any) => {
    ctx = context;
    if (context.session && typeof context.session === 'object') { session.data = Object.assign({}, context.session.data ?? {}); session.recents = [...(context.session.recents ?? [])]; }
    fire('onWidgetLoad', {
      channel: { id: context.channel?.id ?? '', username: context.channel?.login ?? '', providerId: context.channel?.id ?? '', avatar: '' },
      currency: { code: 'USD', name: 'U.S. Dollar', symbol: '$' },
      fieldData: context.fields, recents: session.recents, session: { data: session.data, settings: {} },
      overlay: status(), emotes: []
    });
  });
  Dima.on('chat', (m: any) => received('message', toMessage(m)));
  Dima.on('chat.delete', (d: any) => received('delete-message', { msgId: d?.messageId }));
  Dima.on('chat.clear', (d: any) => { if (d?.userId) received('delete-messages', { userId: d.userId }); });
  Dima.on('alert', (a: any) => {
    const mapped = toAlert(a); if (!mapped) return;
    if (queue.length < 50) queue.push(mapped);
    drain();
  });
  Dima.on('session', (s: any) => {
    if (!s || typeof s !== 'object') return;
    session.data = Object.assign({}, s.data ?? {}); session.recents = [...(s.recents ?? [])];
    fire('onSessionUpdate', { session: session.data });
  });
  Dima.on('button', (b: any) => received('widget-button', { listener: 'widget-button', field: b?.field, value: b?.value }));
  Dima.on('store', (s: any) => received('kvstore:update', { data: { key: 'customWidget.' + s?.key, value: s?.value } }));
}

export const SE_SHIM_SCRIPT = `(${seShim.toString()})(window);`;
