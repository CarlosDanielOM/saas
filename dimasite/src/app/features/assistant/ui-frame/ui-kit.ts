/**
 * The UI kit inside every assistant UI frame: `window.dima` plus Live First base styles.
 *
 * `assistantUiKit` is inlined into the sandboxed frame as text (`.toString()`), so it must stay self-contained: no
 * imports, no references outside its body, no object spread. It runs before the model's HTML and code.
 * Protocol (page ⇄ frame, every message `{dimaUi: 1, token, type}`): see ui-frame-bridge.ts.
 */

export interface UiKitStrings {
  error: string;
  /** Shown when the card's code tries to send or open a page without the person pressing anything. */
  needsClick: string;
  chartError: string;
  table: string;
  other: string;
  total: string;
  series: string;
  label: string;
}

export interface UiKitBoot {
  token: string;
  theme: { mode: 'dark' | 'light'; tokens: object };
  locked: boolean;
  locale: string;
  maxBytes: number;
  strings: UiKitStrings;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function assistantUiKit(win: any, boot: UiKitBoot, chartMarkup: any, chartWire: any): void {
  'use strict';
  const doc = win.document;
  const parent = win.parent;
  const token = String(boot.token);
  const strings = boot.strings;
  let theme = boot.theme;
  let locked = false;
  let errors = 0;
  const themeListeners: any[] = [];
  const charts: any[] = [];

  // One object literal (no Object.assign, no property sets): card code that patches built-ins or adds setters to
  // Object.prototype never gets to see the token.
  const post = (message: any) => {
    try {
      parent.postMessage({ dimaUi: 1, token, type: message.type, values: message.values, route: message.route, height: message.height, errors: message.errors }, '*');
    } catch { /* page gone */ }
  };

  // The bridge token is written in this <script>: take it out of the document before the card's code can read it.
  try { if (doc.currentScript) doc.currentScript.remove(); } catch { /* ignore */ }

  // No nested frames: each would be a fresh realm where the WebRTC removal doesn't apply (and could reach the
  // network). JS can't create them, frame URLs can't be set, shadow roots (invisible to the watcher) are off, and
  // anything a parser inserts is removed before it can load (insertion is synchronous, frame loads are not).
  const FRAME = /^(iframe|frame|frameset|object|embed|portal|fencedframe)$/i;
  const refuse = () => { throw new win.DOMException('Frames are not allowed in assistant cards', 'NotSupportedError'); };
  const lock = (target: any, name: string, value: any) => {
    try { Object.defineProperty(target, name, { value, configurable: false, writable: false }); } catch { /* ignore */ }
  };
  const create = win.Document.prototype.createElement;
  const createNS = win.Document.prototype.createElementNS;
  // The tag is turned into text once, and that same text is checked and used (an object can't change its answer).
  lock(win.Document.prototype, 'createElement', function (this: any, tag: any, options?: any) {
    const name = String(tag);
    if (FRAME.test(name.trim())) refuse();
    return create.call(this, name, options);
  });
  lock(win.Document.prototype, 'createElementNS', function (this: any, ns: any, tag: any, options?: any) {
    const name = String(tag);
    if (FRAME.test((name.split(':').pop() || '').trim())) refuse();
    return createNS.call(this, ns, name, options);
  });
  lock(win.Element.prototype, 'attachShadow', function () { refuse(); });
  if (win.Element.prototype.setHTMLUnsafe) lock(win.Element.prototype, 'setHTMLUnsafe', function () { refuse(); });
  if (win.ShadowRoot && win.ShadowRoot.prototype.setHTMLUnsafe) lock(win.ShadowRoot.prototype, 'setHTMLUnsafe', function () { refuse(); });
  if (win.Document.parseHTMLUnsafe) lock(win.Document, 'parseHTMLUnsafe', function () { refuse(); });
  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement'].forEach((type) => {
    const proto = win[type] && win[type].prototype;
    if (!proto) return;
    ['src', 'srcdoc', 'data'].forEach((name) => {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && desc.set) {
        try { Object.defineProperty(proto, name, { get: desc.get, set() { /* refused */ }, configurable: false }); } catch { /* ignore */ }
      }
    });
  });
  const isFrame = (node: any) => node && node.nodeType === 1 && FRAME.test(String(node.localName || ''));
  const purge = (node: any) => {
    if (!node || node.nodeType !== 1 && node.nodeType !== 11) return;
    if (isFrame(node)) { node.remove(); return; }
    if (node.querySelectorAll) node.querySelectorAll('iframe,frame,frameset,object,embed,portal,fencedframe').forEach((el: any) => el.remove());
  };
  new win.MutationObserver((records: any[]) => {
    records.forEach((record: any) => record.addedNodes && record.addedNodes.forEach(purge));
  }).observe(doc, { childList: true, subtree: true });

  // Sending and opening pages only happen while the person is actually clicking or typing in this card. The real
  // getter is kept now, before the card's code could replace navigator.userActivation or its prototype.
  const activation = win.navigator && win.navigator.userActivation;
  const activeDesc = activation && win.UserActivation ? Object.getOwnPropertyDescriptor(win.UserActivation.prototype, 'isActive') : null;
  const isActive = activeDesc && activeDesc.get ? activeDesc.get : null;
  const reflectApply = Reflect.apply;
  const activated = () => (isActive ? reflectApply(isActive, activation, []) === true : !activation);

  // Links never leave the card (in-page #anchors still work). Scripted navigation is refused by the relay frame's
  // policy (see ui-relay.ts); this only keeps a stray link click from ending the card.
  doc.addEventListener('click', (event: any) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link && !String(link.getAttribute('href')).startsWith('#')) event.preventDefault();
  }, true);

  // Errors in the card's code show as a small note here; nothing reaches the page.
  const note = (detail: string) => {
    errors++;
    let box = doc.getElementById('dima-note');
    if (!box) {
      box = doc.createElement('p');
      box.id = 'dima-note';
      box.className = 'dima-note';
      box.setAttribute('role', 'status');
      (doc.body || doc.documentElement).appendChild(box);
    }
    box.textContent = strings.error;
    if (detail) box.title = String(detail).slice(0, 300);
    measure();
  };
  win.addEventListener('error', (event: any) => {
    if (event && event.message !== undefined) note(event.message || 'Error');
  });
  win.addEventListener('unhandledrejection', (event: any) => {
    const reason = event && event.reason;
    note(reason && reason.message ? reason.message : String(reason));
  });

  // ---- theme
  const applyTheme = (next: any) => {
    if (!next || typeof next !== 'object' || !next.tokens) return;
    theme = next;
    const style = doc.getElementById('dima-theme');
    if (style) {
      const lines: string[] = [];
      Object.keys(next.tokens).forEach((key) => {
        const value = String(next.tokens[key]);
        if (/^[a-z-]+$/.test(key) && !/[;{}<>]|url\(/i.test(value)) lines.push('--' + key + ':' + value);
      });
      style.textContent = ':root{' + lines.join(';') + ';color-scheme:' + (next.mode === 'light' ? 'light' : 'dark') + '}';
    }
    doc.documentElement.setAttribute('data-theme', next.mode === 'light' ? 'light' : 'dark');
    charts.forEach((chart) => chart.render());
    themeListeners.slice().forEach((listener) => { try { listener(api.theme); } catch (error: any) { note(error && error.message); } });
  };

  // ---- lock: after the answer was sent (or the card closed) nothing can be changed or sent again
  const CONTROLS = 'input, select, textarea, button, fieldset';
  const lockControl = (el: any) => {
    if (el.hasAttribute('data-dima-lock')) return;
    el.setAttribute('data-dima-lock', el.disabled ? 'kept' : 'set');
    el.disabled = true;
  };
  let lockObserver: any = null;
  const setLocked = (value: boolean) => {
    locked = value;
    if (value) {
      doc.documentElement.setAttribute('data-locked', '');
      doc.querySelectorAll(CONTROLS).forEach(lockControl);
      if (!lockObserver && win.MutationObserver) {
        lockObserver = new win.MutationObserver(() => { if (locked) doc.querySelectorAll(CONTROLS).forEach(lockControl); });
        lockObserver.observe(doc.documentElement, { childList: true, subtree: true });
      }
    } else {
      doc.documentElement.removeAttribute('data-locked');
      if (lockObserver) { lockObserver.disconnect(); lockObserver = null; }
      doc.querySelectorAll('[data-dima-lock]').forEach((el: any) => {
        if (el.getAttribute('data-dima-lock') === 'set') el.disabled = false;
        el.removeAttribute('data-dima-lock');
      });
    }
  };

  // ---- values: a form (or the whole card) as a plain object
  const formValues = (form?: any) => {
    const scope = form && form.elements ? form : doc.getElementById('dima-root') || doc;
    const els = Array.from(scope.elements || scope.querySelectorAll('input, select, textarea')) as any[];
    const out: Record<string, unknown> = {};
    const checkboxes: Record<string, number> = {};
    els.forEach((el) => { if (el.type === 'checkbox' && el.name) checkboxes[el.name] = (checkboxes[el.name] || 0) + 1; });
    els.forEach((el) => {
      const name = el.name;
      if (!name || (el.disabled && el.getAttribute('data-dima-lock') !== 'set')) return;
      const kind = String(el.type || '').toLowerCase();
      if (['button', 'submit', 'reset', 'image', 'file'].indexOf(kind) >= 0 || el.tagName === 'FIELDSET' || el.tagName === 'OBJECT' || el.tagName === 'OUTPUT') return;
      if (kind === 'checkbox') {
        if (checkboxes[name] > 1) {
          const list = Array.isArray(out[name]) ? out[name] as unknown[] : [];
          if (el.checked) list.push(el.value);
          out[name] = list;
        } else out[name] = !!el.checked;
      } else if (kind === 'radio') {
        if (el.checked) out[name] = el.value;
        else if (!(name in out)) out[name] = null;
      } else if (kind === 'number' || kind === 'range') {
        out[name] = Number.isFinite(el.valueAsNumber) ? el.valueAsNumber : null;
      } else if (el.tagName === 'SELECT' && el.multiple) {
        out[name] = Array.from(el.selectedOptions).map((option: any) => option.value);
      } else out[name] = String(el.value);
    });
    return out;
  };

  // ---- size: the page sets the frame height from this (capped there)
  let lastHeight = -1;
  let measureQueued = false;
  const measure = (force?: boolean) => {
    if (measureQueued && !force) return;
    measureQueued = true;
    win.requestAnimationFrame(() => {
      measureQueued = false;
      const height = Math.ceil(doc.documentElement.getBoundingClientRect().height);
      if (force || Math.abs(height - lastHeight) >= 1) {
        lastHeight = height;
        post({ type: 'resize', height });
      }
    });
  };

  // ---- sliders: fill the track up to the thumb (custom styled, see the kit CSS)
  const syncRange = (el: any) => {
    const min = el.min === '' ? 0 : Number(el.min);
    const max = el.max === '' ? 100 : Number(el.max);
    const value = Number(el.value);
    const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
    el.style.setProperty('--pct', String(Math.round(pct * 1000) / 1000));
  };
  const syncRanges = () => doc.querySelectorAll('input[type=range]').forEach(syncRange);
  doc.addEventListener('input', (event: any) => { if (event.target && event.target.type === 'range') syncRange(event.target); }, true);

  // ---- forms: sandboxed frames never fire `submit`, so the kit runs it (validation, `submit` event, then dima.submit)
  const runSubmit = (form: any, submitter: any) => {
    if (locked || !form) return;
    if (!form.noValidate && !(submitter && submitter.formNoValidate) && form.reportValidity && !form.reportValidity()) return;
    let event: any;
    try { event = new win.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }); }
    catch { event = new win.Event('submit', { bubbles: true, cancelable: true }); }
    if (form.dispatchEvent(event)) {
      const values = formValues(form);
      if (submitter && submitter.name) values[submitter.name] = submitter.value;
      api.submit(values);
    }
  };
  doc.addEventListener('click', (event: any) => {
    const button = event.target && event.target.closest ? event.target.closest('button, input[type=submit], input[type=image]') : null;
    if (!button || !button.form || String(button.type).toLowerCase() !== 'submit') return;
    event.preventDefault();
    runSubmit(button.form, button);
  });
  doc.addEventListener('keydown', (event: any) => {
    const field = event.target;
    if (event.key !== 'Enter' || event.isComposing || !field || field.tagName !== 'INPUT' || !field.form) return;
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].indexOf(String(field.type)) >= 0) return;
    event.preventDefault();
    const submitter = field.form.querySelector('button:not([type]), button[type=submit], input[type=submit]');
    runSubmit(field.form, submitter);
  });
  try {
    const proto = win.HTMLFormElement.prototype;
    Object.defineProperty(proto, 'requestSubmit', { configurable: true, value: function (this: any, submitter?: any) { runSubmit(this, submitter || null); } });
    Object.defineProperty(proto, 'submit', { configurable: true, value: function (this: any) { api.submit(formValues(this)); } });
  } catch { /* keep native */ }

  // ---- charts
  let chartCount = 0;
  const chart = (target: any, spec: any) => {
    const el = typeof target === 'string' ? doc.querySelector(target) : target;
    if (!el || !el.ownerDocument) { note('dima.chart: element not found'); return null; }
    const id = 'dc' + (++chartCount);
    let current = spec;
    let unwire: any = null;
    let lastWidth = 0;
    const entry = {
      render: () => {
        if (unwire) unwire();
        const width = Math.round(el.clientWidth || el.getBoundingClientRect().width || 320);
        lastWidth = width;
        const result = chartMarkup(current || {}, {
          width, mode: theme.mode, locale: boot.locale, id,
          strings: { table: strings.table, other: strings.other, total: strings.total, error: strings.chartError, series: strings.series, label: strings.label },
        });
        el.innerHTML = result.html;
        unwire = chartWire(el, result.model);
        measure();
      },
    };
    charts.push(entry);
    try { entry.render(); } catch (error: any) { note(error && error.message); }
    if (win.ResizeObserver) {
      const observer = new win.ResizeObserver(() => {
        const width = Math.round(el.clientWidth);
        if (width && Math.abs(width - lastWidth) > 4) entry.render();
      });
      observer.observe(el);
    }
    return { update: (next: any) => { current = next; entry.render(); } };
  };

  const api = {
    /** Send the answer to the assistant (a plain JSON object). Returns false when locked or invalid. */
    submit: (values?: any) => {
      if (locked) return false;
      if (!activated()) { note(strings.needsClick); return false; }
      let data: any;
      try { data = JSON.parse(JSON.stringify(values === undefined ? formValues() : values)); } catch { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { note('dima.submit needs an object'); return false; }
      const size = new win.TextEncoder().encode(JSON.stringify(data)).length;
      if (size > boot.maxBytes) { note('dima.submit: too much data'); return false; }
      post({ type: 'submit', values: data });
      setLocked(true); // the page unlocks it again if the answer couldn't be sent
      return true;
    },
    resize: () => { syncRanges(); measure(true); },
    /** Ask the page to open one of its pages (a route key such as "modules.tts"). */
    navigate: (route: any) => {
      if (!activated()) { note(strings.needsClick); return false; }
      post({ type: 'navigate', route: String(route) });
      return true;
    },
    get theme() { return { mode: theme.mode, tokens: Object.assign({}, theme.tokens) }; },
    onTheme: (listener: any) => {
      if (typeof listener !== 'function') return () => {};
      themeListeners.push(listener);
      return () => { const i = themeListeners.indexOf(listener); if (i >= 0) themeListeners.splice(i, 1); };
    },
    chart,
    formValues,
    get locked() { return locked; },
  };
  Object.defineProperty(win, 'dima', { value: Object.freeze(api), configurable: false, writable: false, enumerable: true });

  win.addEventListener('message', (event: any) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.dimaUi !== 1 || data.token !== token) return;
    if (data.type === 'theme') applyTheme(data.theme);
    else if (data.type === 'lock') setLocked(true);
    else if (data.type === 'unlock') setLocked(false);
  });

  // After the card's own HTML and code ran (parser-inserted scripts finish before DOMContentLoaded).
  doc.addEventListener('DOMContentLoaded', () => {
    syncRanges();
    if (boot.locked) setLocked(true);
    if (win.ResizeObserver) new win.ResizeObserver(() => measure()).observe(doc.documentElement);
    const height = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    lastHeight = height;
    post({ type: 'ready', height, errors });
  });
}

export const ASSISTANT_UI_KIT_SOURCE = assistantUiKit.toString();

/** Live First base styles for model-written cards. Tokens come from the page theme (`#dima-theme`). */
export const ASSISTANT_UI_KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:var(--surface)}
body{margin:0;padding:2px;background:transparent;color:var(--text);font:400 14px/1.5 var(--font);overflow-wrap:anywhere}
#dima-root{display:grid;gap:.75rem;min-width:0}
h1,h2,h3,h4{margin:0;color:var(--text);font-weight:750;letter-spacing:-.01em;line-height:1.25}
h1{font-size:1.25rem}h2{font-size:1.08rem}h3{font-size:.98rem}h4{font-size:.9rem}
p{margin:0;line-height:1.55}
small{font-size:.8rem}
small,.muted{color:var(--muted)}
a{color:var(--accent-text);text-underline-offset:2px}
strong,b{font-weight:700}
code{padding:.08rem .3rem;border-radius:.35rem;background:var(--soft);font:500 .85em ui-monospace,SFMono-Regular,Menlo,monospace}
hr{margin:.25rem 0;border:0;border-top:1px solid var(--line)}
ul,ol{margin:0;padding-inline-start:1.2rem}
.card{min-width:0;padding:.85rem 1rem;border:1px solid var(--line);border-radius:1rem;background:var(--surface)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.row.spread,.spread{justify-content:space-between}
.stack{display:grid;gap:.6rem;min-width:0}
.grid{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))}
.table-wrap{max-width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.85rem;font-variant-numeric:tabular-nums}
th,td{padding:.5rem .6rem;border-bottom:1px solid var(--line);text-align:start;vertical-align:top}
thead th{color:var(--muted);font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
tbody tr:last-child>*{border-bottom:0}
td.num,th.num{text-align:end}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:44px;padding:.55rem 1rem;border:1px solid var(--line-strong);border-radius:999px;background:var(--btn);color:var(--text);font:650 .88rem/1.2 var(--font);text-decoration:none;cursor:pointer;touch-action:manipulation}
button:hover:not(:disabled),.btn:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--line-strong))}
.btn-primary,button[type=submit]{border-color:var(--accent-strong);background:var(--accent-strong);color:var(--accent-contrast)}
.btn-primary:hover:not(:disabled),button[type=submit]:hover:not(:disabled){border-color:var(--accent-strong);filter:brightness(1.08)}
.btn-ghost{border-color:transparent;background:transparent;color:var(--accent-text)}
.btn-danger{border-color:color-mix(in srgb,var(--danger) 45%,var(--line));color:var(--danger)}
button:disabled,.btn[aria-disabled=true]{border-color:var(--line);background:var(--btn);color:var(--muted);cursor:not-allowed;filter:none}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
label{display:grid;gap:.35rem;color:var(--text);font-size:.82rem;font-weight:650}
label:has(>input[type=checkbox]),label:has(>input[type=radio]),label.check{display:flex;align-items:center;gap:.55rem;min-height:44px;font-weight:550}
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=button]),select,textarea{width:100%;min-width:0;min-height:44px;padding:.55rem .75rem;border:1px solid var(--line-strong);border-radius:.8rem;background:var(--input);color:var(--text);font:400 16px/1.4 var(--font)}
textarea{min-height:6rem;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}
input[type=checkbox],input[type=radio]{flex:none;width:1.15rem;height:1.15rem;margin:0;accent-color:var(--accent-strong)}
fieldset{min-width:0;margin:0;padding:0;border:0;display:grid;gap:.4rem}
legend{padding:0;margin-bottom:.35rem;font-size:.82rem;font-weight:650}
input[type=range]{--pct:.5;width:100%;height:32px;margin:0;padding:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(to right,var(--accent-strong) 0,var(--accent-strong) calc(11px + (100% - 22px) * var(--pct)),var(--track) calc(11px + (100% - 22px) * var(--pct)),var(--track) 100%)}
input[type=range]::-webkit-slider-thumb{width:22px;height:22px;margin-top:-8px;border:3px solid var(--accent-strong);border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);-webkit-appearance:none;appearance:none}
input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:var(--track)}
input[type=range]::-moz-range-progress{height:6px;border-radius:999px;background:var(--accent-strong)}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border:3px solid var(--accent-strong);border-radius:50%;background:#fff}
input[type=range]:focus-visible{outline:none}
input[type=range]:focus-visible::-webkit-slider-thumb{outline:3px solid var(--accent);outline-offset:2px}
input[type=range]:focus-visible::-moz-range-thumb{outline:3px solid var(--accent);outline-offset:2px}
input[type=range]:disabled{cursor:not-allowed}
input[type=range]:disabled::-webkit-slider-thumb{border-color:var(--muted)}
input[type=range]:disabled::-webkit-slider-runnable-track{background:var(--track)}
.chips{display:flex;flex-wrap:wrap;gap:.4rem}
.chip{display:inline-flex;align-items:center;gap:.3rem;min-height:2rem;padding:.25rem .75rem;border:1px solid var(--line-strong);border-radius:999px;background:var(--btn);color:var(--text);font-size:.8rem;font-weight:650}
button.chip{min-height:44px}
.chip[aria-pressed=true],.chip.on{border-color:var(--accent-strong);background:var(--accent-strong);color:var(--accent-contrast)}
.badge{display:inline-flex;align-items:center;gap:.25rem;padding:.1rem .5rem;border-radius:999px;background:var(--soft);color:var(--text);font-size:.72rem;font-weight:750;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.danger{color:var(--danger)}
.dima-note{margin:.5rem 0 0;padding:.45rem .7rem;border:1px dashed color-mix(in srgb,var(--warn) 55%,var(--line));border-radius:.7rem;color:var(--muted);font-size:.78rem}
.dc{display:grid;gap:.5rem;min-width:0;margin:0}
.dc-title{font-size:.9rem;font-weight:700}
.dc-legend{display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin:0;padding:0;list-style:none;color:var(--muted);font-size:.78rem}
.dc-legend b{color:var(--text)}
.dc-key{display:inline-block;width:.7rem;height:.7rem;margin-inline-end:.35rem;border-radius:3px;vertical-align:-1px}
.dc-key--line{width:.9rem;height:2px;border-radius:2px;vertical-align:3px}
.dc-muted{color:var(--muted)}
.dc-plot{position:relative;min-width:0}
.dc-svg{display:block;width:100%;height:auto;overflow:visible;font-family:var(--font);touch-action:pan-y}
.dc-svg:focus-visible{outline:3px solid var(--accent);outline-offset:4px;border-radius:6px}
.dc-grid{stroke:var(--line);stroke-width:1;shape-rendering:crispEdges}
.dc-base{stroke:var(--axis)}
.dc-tick,.dc-xlabel{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.dc-value{fill:var(--text);font-size:11px;font-weight:700}
.dc-total{fill:var(--text);font-size:20px;font-weight:750}
.dc-total-label{fill:var(--muted);font-size:11px}
.dc-hit{fill:transparent}
.dc-cross{stroke:var(--muted);stroke-width:1;opacity:0}
.dc-cross.is-on{opacity:.7}
.dc-svg[data-hover] .dc-bar:not(.is-active),.dc-svg[data-hover] .dc-seg:not(.is-active){opacity:.5}
.dc-tip{position:absolute;top:0;left:0;z-index:2;min-width:8rem;max-width:14rem;padding:.45rem .6rem;border:1px solid var(--line-strong);border-radius:.7rem;background:var(--surface);box-shadow:0 8px 22px rgba(0,0,0,.25);font-size:.78rem;pointer-events:none}
.dc-tip[hidden]{display:none}
.dc-tip__title{margin:0 0 .2rem;color:var(--muted);font-size:.72rem}
.dc-tip__row{display:flex;align-items:center;gap:.4rem;margin:0}
.dc-tip__row b{color:var(--text)}
.dc-tip__row span:last-child{color:var(--muted)}
.dc-tip__key{flex:none;width:.75rem;height:2px;border-radius:2px}
.dc-table summary{display:flex;align-items:center;min-height:44px;color:var(--accent-text);font-size:.8rem;font-weight:650;cursor:pointer}
.dc-table__scroll{max-width:100%;overflow-x:auto}
.dc-error{color:var(--muted);font-size:.82rem}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
