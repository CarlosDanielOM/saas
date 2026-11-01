// Injected only by the loopback capture gateway, before Angular boots.
(() => {
  const query = new URLSearchParams(location.search);
  const lang = query.get('lang') === 'es' ? 'es' : 'en';
  const theme = query.get('theme') === 'light' ? 'light' : 'dark';
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="#7c3aed"/><text x="48" y="62" text-anchor="middle" font-family="sans-serif" font-size="42" fill="white">D</text></svg>');
  const user = { id: '424242', login: 'demostreamer', display_name: 'DemoStreamer', profile_image_url: avatar };
  const app = { name: 'DemoStreamer', email: 'demo@example.invalid', language: lang, plan_tier: 'pro', actived: true,
    chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const state = window.docsCapture = { lang, theme, channelID: user.id, channel: user.login, user, app, avatar, handlers: [], unhandled: [], errors: [], requests: [] };
  localStorage.clear();
  sessionStorage.clear();
  for (const key of ['userLanguage', 'dimasite.language']) localStorage.setItem(key, lang);
  localStorage.setItem('theme', theme);
  localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'docs-fixture-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
  const parse = body => { try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return body; } };
  const reply = (href, method = 'GET', body = null) => {
    const url = new URL(href, location.href);
    const request = { url, method: method.toUpperCase(), body: parse(body) };
    // Analytics never leaves the browser and is not a feature-fixture gap.
    if (url.hostname === 'tadd.domdimabot.com') return { raw: {} };
    state.requests.push({ url: url.href, path: url.pathname, method: request.method });
    for (const handler of state.handlers) {
      try { const result = handler(request); if (result !== undefined) return result; }
      catch (error) { state.errors.push(`${url.pathname}: ${error.message}`); return { status: 500, raw: { error: true, message: 'Screenshot fixture failed' } }; }
    }
    let data;
    if (url.pathname === '/users') data = { id: user.id, username: user.login, display_name: user.display_name, profile_image_url: avatar };
    else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: app.plan_tier };
    else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    else { state.unhandled.push(`${request.method} ${url.pathname}`); data = {}; }
    return { data };
  };
  const response = result => Object.hasOwn(result, 'raw') ? result.raw : { error: false, status: result.status || 200, data: result.data };
  const isLocalAsset = href => new URL(href, location.href).origin === location.origin;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (isLocalAsset(href)) return originalFetch(input, options);
    const result = reply(href, options.method || input.method || 'GET', options.body);
    return new Response(JSON.stringify(response(result)), { status: result.status || 200, headers: { 'content-type': 'application/json' } });
  };
  const NativeXHR = window.XMLHttpRequest;
  class FixtureXHR extends EventTarget {
    constructor() { super(); this.upload = new EventTarget(); this.readyState = 0; this.responseType = ''; this.withCredentials = false; this.timeout = 0; }
    open(method, href, ...args) {
      this.method = method; this.href = href;
      if (isLocalAsset(href)) {
        this.native = new NativeXHR();
        for (const event of ['load', 'error', 'abort', 'timeout', 'progress', 'loadend', 'readystatechange']) this.native.addEventListener(event, () => {
          for (const key of ['readyState', 'status', 'statusText', 'response', 'responseURL']) this[key] = this.native[key];
          try { this.responseText = this.native.responseText; } catch {}
          this.emit(event);
        });
        this.native.open(method, href, ...args);
      }
      this.readyState = 1;
    }
    emit(name) { const event = new Event(name); this.dispatchEvent(event); this['on' + name]?.(event); }
    setRequestHeader(...args) { this.native?.setRequestHeader(...args); }
    getAllResponseHeaders() { return this.native?.getAllResponseHeaders() || 'content-type: application/json\r\n'; }
    getResponseHeader(name) { return this.native?.getResponseHeader(name) || (name.toLowerCase() === 'content-type' ? 'application/json' : null); }
    abort() { this.aborted = true; this.native?.abort(); }
    send(body) {
      if (this.native) { this.native.responseType = this.responseType; this.native.withCredentials = this.withCredentials; return this.native.send(body); }
      queueMicrotask(() => {
        if (this.aborted) return;
        const result = reply(this.href, this.method, body);
        this.status = result.status || 200; this.statusText = this.status < 400 ? 'OK' : 'Error';
        this.responseURL = this.href; this.responseText = JSON.stringify(response(result));
        this.response = this.responseType === 'json' ? response(result) : this.responseText;
        this.readyState = 4; this.emit('readystatechange'); this.emit('load'); this.emit('loadend');
      });
    }
  }
  window.XMLHttpRequest = FixtureXHR;
  class BlockedSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { super(); this.readyState = 3; }
    send() {} close() { this.readyState = 3; }
  }
  window.WebSocket = BlockedSocket;
  window.EventSource = class extends EventTarget { close() {} };
  navigator.sendBeacon = () => true;
})();
