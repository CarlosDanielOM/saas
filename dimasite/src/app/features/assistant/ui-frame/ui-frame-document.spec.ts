// Run: cd dimabot && node --import tsx --test ../dimasite/src/app/features/assistant/ui-frame/*.spec.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { RESTRICT } from '../../overlays/widget-runtime/frame-document.ts';
import {
  FRAME_TOKEN_DEFAULTS, UI_FRAME_SANDBOX, assistantFramePolicy, buildRelayDocument, buildUiFrameDocument, readFrameTheme, safeCssValue, themeCss,
} from './ui-frame-document.ts';
import { ASSISTANT_UI_KIT_CSS } from './ui-kit.ts';

const strings = { error: 'Part failed', chartError: 'No chart', table: 'Table', other: 'Other', total: 'Total', series: 'Series', label: 'Item' };
const boot = (over: Partial<Parameters<typeof buildUiFrameDocument>[1]> = {}) => ({
  token: 'tok-123', theme: { mode: 'dark' as const, tokens: { ...FRAME_TOKEN_DEFAULTS.dark } }, locked: false, locale: 'en', strings, ...over,
});
const directives = (policy: string) => Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

test('sandbox is scripts-only: never same-origin, forms, popups or top navigation', () => {
  assert.equal(UI_FRAME_SANDBOX, 'allow-scripts');
  for (const token of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-modals']) assert.ok(!UI_FRAME_SANDBOX.includes(token), token);
});

test('policy: no network, no outside hosts, no frames/workers/forms/plugins, media only data:/blob:', () => {
  const policy = assistantFramePolicy();
  const d = directives(policy);
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'none'"]);
  for (const name of ['frame-src', 'child-src', 'worker-src', 'form-action', 'object-src', 'base-uri', 'manifest-src']) assert.deepEqual(d[name], ["'none'"], name);
  assert.deepEqual(d['img-src'], ['data:', 'blob:']);
  assert.deepEqual(d['media-src'], ['data:', 'blob:']);
  assert.deepEqual(d['font-src'], ['data:']);
  assert.deepEqual(d['script-src'], ["'unsafe-inline'"], 'inline only, no eval');
  assert.deepEqual(d['style-src'], ["'unsafe-inline'"], 'no Google Fonts or other stylesheets');
  assert.doesNotMatch(policy, /https?:|\*|googleapis|domdimabot/);
});

test('document: CSP meta first, WebRTC removed, theme + kit before the card, card code last', () => {
  const html = buildUiFrameDocument({ html: '<table><tr><td>1</td></tr></table>', css: 'td{color:red}', js: 'dima.submit({a:1})' }, boot());
  assert.match(html, /^<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; /);
  assert.ok(html.includes(`content="${assistantFramePolicy()}"`));
  assert.ok(html.includes('x-dns-prefetch-control" content="off"'));
  const order = ['Content-Security-Policy', RESTRICT, 'id="dima-theme"', 'id="dima-kit"', 'function assistantUiKit', 'id="dima-card-style"', '<div id="dima-root"><table>', 'dima.submit({a:1})'];
  let at = -1;
  for (const part of order) {
    const next = html.indexOf(part);
    assert.ok(next > at, `${part} in order`);
    at = next;
  }
  assert.ok(html.includes(ASSISTANT_UI_KIT_CSS.trim().slice(0, 60)), 'kit CSS injected');
  assert.ok(html.includes('function dimaChartMarkup') && html.includes('function dimaChartWire'), 'chart code injected');
  assert.ok(html.includes('"token":"tok-123"'), 'token in boot data');
  assert.ok(html.includes('"maxBytes":16384'));
});

test('card text cannot close the kit scripts or styles early', () => {
  const html = buildUiFrameDocument({ html: '<p>hi</p>', css: 'p{}</style><script>alert(1)</script>', js: 'var s = "</script><script>alert(2)//";' }, boot());
  assert.ok(!html.includes('</style><script>alert(1)'));
  assert.ok(!html.includes('"</script><script>alert(2)'));
  // Exactly the kit's scripts + the card's script, all closed by us.
  assert.ok(html.includes('var s = "<\\/script><script>alert(2)//";'));
  const bootWithAngle = buildUiFrameDocument({ html: '', js: '' }, boot({ strings: { ...strings, error: '</script><b>x' } }));
  assert.ok(!bootWithAngle.includes('</script><b>x'), 'boot JSON escapes <');
  assert.ok(!bootWithAngle.includes('id="dima-card-style"'), 'no empty card style');
});

test('locked + Spanish + light boot data', () => {
  const html = buildUiFrameDocument({ html: '<p>x</p>' }, boot({ locked: true, locale: 'es-MX', theme: { mode: 'light', tokens: { ...FRAME_TOKEN_DEFAULTS.light } } }));
  assert.match(html, /<html lang="es-MX" data-theme="light">/);
  assert.ok(html.includes('"locked":true'));
  assert.ok(html.includes('color-scheme:light'));
});

test('theme: page tokens win, unsafe values fall back, button fills stay AA', () => {
  const page: Record<string, string> = { '--tile': ' #222 ', '--fg': '#fff', '--accent': 'red;}body{background:url(https://x)', '--font': 'Inter, sans-serif', '--muted': '' };
  const theme = readFrameTheme('dark', (name) => page[name] ?? '');
  assert.equal(theme.tokens.surface, '#222');
  assert.equal(theme.tokens.text, '#fff');
  assert.equal(theme.tokens.accent, FRAME_TOKEN_DEFAULTS.dark.accent, 'injection rejected');
  assert.equal(theme.tokens.muted, FRAME_TOKEN_DEFAULTS.dark.muted, 'missing token → default');
  assert.equal(theme.tokens.font, 'Inter, sans-serif');
  assert.equal(theme.tokens['accent-strong'], '#7c3aed');
  assert.equal(theme.tokens['accent-contrast'], '#ffffff');
  const css = themeCss(theme);
  assert.match(css, /^:root\{--bg:#0f1115;--surface:#222;/);
  assert.match(css, /color-scheme:dark\}$/);
  assert.ok(!safeCssValue('a}b') && !safeCssValue('url(x)') && !safeCssValue('') && safeCssValue('rgba(0, 0, 0, 0.1)'));
});

test('relay: same policy (frame-src none refuses card navigations), card embedded as an escaped string, token', () => {
  const card = buildUiFrameDocument({ html: '<p>card</p>', js: 'var x = "</script><script>alert(1)//";' }, boot());
  const relay = buildRelayDocument(card, { token: 'tok-123', title: 'Your "week" </script>', mode: 'light' });
  assert.ok(relay.includes(`<meta http-equiv="Content-Security-Policy" content="${assistantFramePolicy()}">`));
  assert.match(assistantFramePolicy(), /frame-src 'none'/);
  assert.equal(relay.split('<script>').length - 1, 1, 'one script: the relay');
  assert.equal(relay.split('</script>').length - 1, 1, 'card text never closes it');
  assert.ok(relay.includes('function assistantUiRelay'));
  assert.ok(relay.includes('"token":"tok-123"') && relay.includes('"mode":"light"'));
  assert.ok(relay.includes('color-scheme:light'));
  // The embedded card decodes back to the exact card document.
  const json = relay.slice(relay.indexOf('(window, ') + 9, relay.lastIndexOf(');</script>'));
  assert.equal(JSON.parse(json).card, card);
  assert.equal(JSON.parse(json).policy, assistantFramePolicy());
  assert.equal(JSON.parse(json).title, 'Your "week" </script>');
});
