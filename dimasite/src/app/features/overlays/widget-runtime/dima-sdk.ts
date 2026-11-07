/**
 * Dima SDK v1: runs first inside every custom widget frame and is the widget's only connection to Studio/OBS.
 * It is inlined into the frame as text (`DIMA_SDK_SCRIPT`), so the function must stay self-contained:
 * no imports, no references to anything outside its body. Protocol: dimabot/CUSTOM_WIDGET_ENGINE.md, section 3.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function dimaSdk(win: any, boot: { exec: string; fields: Record<string, unknown> }): void {
  'use strict';
  const parent = win.parent;
  const exec = String(boot?.exec ?? '');
  // Settings are known before the widget's own code runs (Dima.fields works synchronously).
  const initialFields = boot?.fields && typeof boot.fields === 'object' ? boot.fields : {};
  // No object spread in this file: the production build turns it into a helper that doesn't exist inside the frame.
  // Every message carries this run's ID, so the host ignores anything from an earlier run of the frame.
  const post = (message: Record<string, unknown>) => { try { parent.postMessage(Object.assign({ dima: 1, exec }, message), '*'); } catch { /* the host is gone */ } };
  const listeners = new Map<string, Set<(data: any) => void>>();
  const states = new Map<string, unknown>();
  // Grows with every state value, so a deferred first delivery never lands after a newer one.
  const stateVersions = new Map<string, number>();
  const setState = (name: string, value: unknown) => { states.set(name, value); stateVersions.set(name, (stateVersions.get(name) ?? 0) + 1); };
  let context: any = null;
  let resolveReady: (value: any) => void = () => {};
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: any }>();
  let nextId = 1;

  // Opaque-origin frames throw on storage access; widgets written for StreamElements expect it to work.
  const memoryStorage = () => {
    const items = new Map<string, string>();
    return {
      getItem: (key: unknown) => items.has(String(key)) ? items.get(String(key)) : null,
      setItem: (key: unknown, value: unknown) => { items.set(String(key), String(value)); },
      removeItem: (key: unknown) => { items.delete(String(key)); },
      clear: () => items.clear(),
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() { return items.size; }
    };
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try { void win[name].length; } catch { try { Object.defineProperty(win, name, { value: memoryStorage(), configurable: true }); } catch { /* keep native */ } }
  }
  // OBS exposes window.obsstudio to browser sources; widget code must not control OBS (best effort).
  try { delete win.obsstudio; } catch { /* not configurable */ }
  try { Object.defineProperty(win, 'obsstudio', { value: undefined, writable: false, configurable: false }); } catch { /* already locked */ }

  const describe = (value: unknown, depth = 0): unknown => {
    if (value instanceof Error) return value.stack || value.message;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value === 'string' ? value.slice(0, 2000) : value;
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return String(value).slice(0, 200);
    if (depth > 2) return '[…]';
    try {
      if (Array.isArray(value)) return value.slice(0, 20).map(item => describe(item, depth + 1));
      if (typeof (value as any).nodeName === 'string') return '<' + String((value as any).nodeName).toLowerCase() + '>';
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).slice(0, 30)) out[key] = describe((value as any)[key], depth + 1);
      return out;
    } catch { return '[unreadable]'; }
  };
  const log = (level: string, args: unknown[]) => post({ type: 'log', level, args: args.slice(0, 10).map(arg => describe(arg)) });
  const consoleRef = win.console || {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = typeof consoleRef[level] === 'function' ? consoleRef[level].bind(consoleRef) : () => {};
    try { consoleRef[level] = (...args: unknown[]) => { log(level === 'log' ? 'info' : level, args); original(...args); }; } catch { /* frozen console */ }
  }
  win.addEventListener('error', (event: any) => post({ type: 'error', message: String(event?.message || 'Script error').slice(0, 500), stack: event?.error?.stack ? String(event.error.stack).slice(0, 2000) : undefined, line: event?.lineno }));
  win.addEventListener('unhandledrejection', (event: any) => post({ type: 'error', message: 'Unhandled promise rejection: ' + String(event?.reason?.message ?? event?.reason ?? '').slice(0, 480), stack: event?.reason?.stack ? String(event.reason.stack).slice(0, 2000) : undefined }));
  win.setInterval(() => post({ type: 'heartbeat' }), 2000);

  const emit = (type: string, data: unknown) => {
    for (const handler of [...(listeners.get(type) ?? [])]) {
      try { handler(data); } catch (error: any) { post({ type: 'error', message: String(error?.message || error).slice(0, 500), stack: error?.stack ? String(error.stack).slice(0, 2000) : undefined }); }
    }
  };
  const rpc = (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = win.setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    post({ type: 'rpc', id, method, params });
  });
  const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, character => '&#' + character.charCodeAt(0) + ';');
  const html = (message: any) => {
    const parts = Array.isArray(message?.parts) ? message.parts : [{ type: 'text', text: message?.text ?? '' }];
    return parts.map((part: any) => {
      if (part?.type === 'emote' && part.images?.['1x']) {
        return '<img class="dima-emote" src="' + escape(part.images['1x']) + '" srcset="' + escape(part.images['1x']) + ' 1x, ' + escape(part.images['2x']) + ' 2x, ' + escape(part.images['4x']) + ' 4x" alt="' + escape(part.text) + '">';
      }
      if (part?.type === 'mention') return '<span class="dima-mention">' + escape(part.text) + '</span>';
      return escape(part?.text);
    }).join('');
  };

  win.addEventListener('message', (event: any) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.dima !== 1 || typeof message.type !== 'string' || message.exec !== exec) return;
    // The host checks this is still the document it built (a widget that opened another page doesn't answer).
    if (message.type === 'probe') { post({ type: 'probe-ok', token: message.token }); return; }
    if (message.type === 'init' && !context) {
      context = message.context || {};
      context.fields = context.fields || {};
      // Live state known when the frame started (polls, goals…): Dima.state(name) gets it right away.
      // Handlers registered before this message (the widget's script runs first) get them too.
      if (context.states && typeof context.states === 'object') {
        for (const name of Object.keys(context.states)) { setState(name, context.states[name]); emit('state:' + name, context.states[name]); }
      }
      resolveReady(api.context);
    } else if (message.type === 'event' && context && message.event && typeof message.event.type === 'string') {
      if (message.event.type === 'session') context.session = message.event.data;
      // Live state: remembered per name, then Dima.on('state') and Dima.state(name, …) handlers.
      if (message.event.type === 'state' && typeof message.event.data?.name === 'string') {
        setState(message.event.data.name, message.event.data.value);
        emit('state:' + message.event.data.name, message.event.data.value);
      }
      emit(message.event.type, message.event.data);
      // Dima.on('signal:feed', …) listens to one signal name.
      if (message.event.type === 'signal' && typeof message.event.data?.name === 'string') emit('signal:' + message.event.data.name, message.event.data);
    } else if (message.type === 'fields' && context && message.fields && typeof message.fields === 'object') {
      context.fields = message.fields;
      emit('fields', message.fields);
    } else if (message.type === 'rpc-result') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id); win.clearTimeout(call.timer);
      if (message.ok) call.resolve(message.value); else call.reject(new Error(String(message.error || 'Request failed')));
    }
  });

  const api = {
    version: 1,
    /** Resolves after Studio/OBS sends the widget's settings and channel. */
    ready: () => ready,
    get context() { return context ? { widget: context.widget, channel: context.channel, fields: context.fields, mode: context.mode, muted: !!context.muted, session: context.session ?? null, goalSource: context.goalSource === 'twitch' ? 'twitch' : 'dima' } : null; },
    get fields() { return context ? context.fields : initialFields; },
    get mode() { return context ? context.mode : null; },
    on(type: string, handler: (data: any) => void) {
      if (typeof type !== 'string' || typeof handler !== 'function') throw new TypeError('Dima.on(type, handler)');
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => { listeners.get(type)?.delete(handler); };
    },
    off(type: string, handler: (data: any) => void) { listeners.get(type)?.delete(handler); },
    /** Live state by name ('polls', 'goals', 'hypetrain', 'ads'): the handler gets the latest value now (if known) and every change. */
    state(name: string, handler: (value: any) => void) {
      if (typeof name !== 'string' || typeof handler !== 'function') throw new TypeError('Dima.state(name, handler)');
      let active = true;
      const off = api.on('state:' + name, handler);
      if (states.has(name)) {
        // Delivered after the widget's current code has run; skipped if it stopped listening or a newer value already came.
        const value = states.get(name), version = stateVersions.get(name);
        win.setTimeout(() => {
          if (!active || stateVersions.get(name) !== version) return;
          try { handler(value); } catch (error: any) { post({ type: 'error', message: String(error?.message || error).slice(0, 500), stack: error?.stack ? String(error.stack).slice(0, 2000) : undefined }); }
        }, 0);
      }
      return () => { active = false; off(); };
    },
    /** Values saved for this widget (RPC names stay `store.*` internally). */
    storage: Object.freeze({
      get: (key: string) => rpc('store.get', { key: String(key) }),
      set: (key: string, value: unknown) => rpc('store.set', { key: String(key), value })
    }),
    counters: Object.freeze({ get: (name: string) => rpc('counters.get', { name: String(name) }) }),
    /** Editor only: change a setting from widget code (StreamElements `setField`). */
    setField: (key: string, value: unknown, reload = true) => rpc('field.set', { key: String(key), value, reload: reload !== false }),
    /** No-op in v1: custom widgets don't hold the alert queue yet. */
    done: () => rpc('queue.done', {}).catch(() => undefined),
    escape,
    html,
    log: (...args: unknown[]) => log('info', args)
  };
  try { Object.defineProperty(win, 'Dima', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true }); } catch { win.Dima = api; }
  // Widget scripts are inline at the end of <body>, so they have run by DOMContentLoaded.
  const loaded = () => post({ type: 'loaded' });
  if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', loaded, { once: true });
  else win.setTimeout(loaded, 0);
}

/** Function source; the frame document calls it with this run's boot data. */
export const DIMA_SDK_SOURCE = dimaSdk.toString();
