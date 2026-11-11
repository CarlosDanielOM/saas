/**
 * The documents of an assistant UI card (`show_ui`): model-written HTML/CSS/JS on an opaque origin with no network.
 * Pure (no Angular, no DOM): unit-tested with `node --test`.
 *
 * Isolation, outermost first:
 * - page → relay frame → card frame, both `sandbox="allow-scripts"` only: opaque origins (no site cookies or
 *   localStorage, where the streamer's Twitch login lives), no forms, popups or top navigation;
 * - `assistantFramePolicy()` on both (meta CSP + iframe `csp` attribute): no fetch/sockets, no outside images, fonts,
 *   styles or scripts, no workers, forms or plugins. Its `frame-src 'none'` on the relay also refuses any navigation
 *   of the card frame (ui-relay.ts explains why that needs the second frame);
 * - `RESTRICT` (shared with custom widgets) removes WebRTC, which CSP doesn't cover.
 */
import type { UiBlock } from '../assistant.types';
import { RESTRICT, safeScript, safeStyle } from '../../overlays/widget-runtime/frame-document';
import { DIMA_CHART_MARKUP_SOURCE, DIMA_CHART_WIRE_SOURCE } from './ui-chart';
import { MAX_SUBMIT_BYTES } from './ui-frame-bridge';
import { ASSISTANT_UI_KIT_CSS, ASSISTANT_UI_KIT_SOURCE, type UiKitBoot, type UiKitStrings } from './ui-kit';
import { ASSISTANT_UI_RELAY_SOURCE, type UiRelayBoot } from './ui-relay';

/** The only sandbox token an assistant frame gets. Never add allow-same-origin: it would expose the site's login. */
export const UI_FRAME_SANDBOX = 'allow-scripts';

/**
 * Tighter than custom widgets' "Block outside connections" (`restrictedPolicy`): no outside hosts at all (not even
 * Google Fonts or our API), images/media/fonts only from data:/blob:, and no eval.
 */
export function assistantFramePolicy(): string {
  return [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    'img-src data: blob:', 'media-src data: blob:', 'font-src data:',
    "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "manifest-src 'none'",
    "form-action 'none'", "object-src 'none'", "base-uri 'none'",
  ].join('; ');
}

export type FrameMode = 'dark' | 'light';

/** Theme tokens a card can use (`var(--surface)` …). */
export interface FrameTokens {
  bg: string; surface: string; text: string; muted: string; line: string; 'line-strong': string;
  accent: string; 'accent-strong': string; 'accent-contrast': string; 'accent-text': string;
  soft: string; btn: string; input: string; track: string; axis: string;
  danger: string; ok: string; warn: string; font: string;
}
export interface FrameTheme { mode: FrameMode; tokens: FrameTokens }

/** Live First values (AA-checked); used when the page doesn't define a token. */
export const FRAME_TOKEN_DEFAULTS: Readonly<Record<FrameMode, FrameTokens>> = {
  dark: {
    bg: '#0f1115', surface: '#171a21', text: '#f5f7fb', muted: '#a7b0c2', line: 'rgba(255,255,255,0.08)', 'line-strong': 'rgba(255,255,255,0.14)',
    accent: '#8b5cf6', 'accent-strong': '#7c3aed', 'accent-contrast': '#ffffff', 'accent-text': '#c4b5fd',
    soft: 'rgba(139,92,246,0.16)', btn: '#1d2230', input: '#11141b', track: '#2a3040', axis: 'rgba(255,255,255,0.22)',
    danger: '#fca5a5', ok: '#86efac', warn: '#fbbf24', font: "'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif",
  },
  light: {
    bg: '#f4f5f8', surface: '#ffffff', text: '#14151a', muted: '#596273', line: 'rgba(15,17,21,0.08)', 'line-strong': 'rgba(15,17,21,0.16)',
    accent: '#7c3aed', 'accent-strong': '#7c3aed', 'accent-contrast': '#ffffff', 'accent-text': '#6d28d9',
    soft: 'rgba(124,58,237,0.1)', btn: '#eef0f5', input: '#ffffff', track: '#dcdfe7', axis: 'rgba(15,17,21,0.28)',
    danger: '#b91c1c', ok: '#166534', warn: '#92400e', font: "'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif",
  },
};

/** Page token (custom property name) read for each frame token. Fill colours for buttons stay fixed (AA with white). */
const PAGE_TOKENS: Partial<Record<keyof FrameTokens, string>> = {
  bg: '--bg', surface: '--tile', text: '--fg', muted: '--muted', line: '--line',
  accent: '--accent', 'accent-text': '--kicker', soft: '--accent-soft', danger: '--danger', ok: '--ok', warn: '--warn', font: '--font',
};

/** A value safe to put inside a style rule (no rule breaks, no URLs). */
export const safeCssValue = (value: string): boolean => value.length > 0 && value.length <= 200 && !/[;{}<>\\]|url\(|expression\(|@import/i.test(value);

/** The page's current theme for a frame: computed tokens where the page defines them, LF defaults otherwise. */
export function readFrameTheme(mode: FrameMode, read: (property: string) => string): FrameTheme {
  const tokens = { ...FRAME_TOKEN_DEFAULTS[mode] };
  for (const [token, property] of Object.entries(PAGE_TOKENS) as [keyof FrameTokens, string][]) {
    const value = (read(property) || '').trim();
    if (value && safeCssValue(value)) tokens[token] = value;
  }
  return { mode, tokens };
}

export function themeCss(theme: FrameTheme): string {
  const lines = Object.entries(theme.tokens)
    .filter(([key, value]) => /^[a-z-]+$/.test(key) && safeCssValue(String(value)))
    .map(([key, value]) => `--${key}:${value}`);
  return `:root{${lines.join(';')};color-scheme:${theme.mode === 'light' ? 'light' : 'dark'}}`;
}

export interface UiFrameBoot {
  token: string;
  theme: FrameTheme;
  locked: boolean;
  /** `en` or `es-MX`. */
  locale: string;
  strings: UiKitStrings;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** JSON for an inline script: `<` is escaped so nothing can close the script. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));

/** Card document. Order: policy, WebRTC removal, theme tokens, kit styles, kit script, model CSS, model HTML, model JS. */
export function buildUiFrameDocument(block: Pick<UiBlock, 'html' | 'css' | 'js'> & { title?: string }, boot: UiFrameBoot): string {
  const kitBoot: UiKitBoot = {
    token: boot.token, theme: boot.theme, locked: boot.locked, locale: boot.locale, maxBytes: MAX_SUBMIT_BYTES, strings: boot.strings,
  };
  const lang = boot.locale.toLowerCase().startsWith('es') ? 'es-MX' : 'en';
  const html = typeof block.html === 'string' ? block.html : '';
  const css = typeof block.css === 'string' ? block.css : '';
  const js = typeof block.js === 'string' ? block.js : '';
  return '<!doctype html>'
    + `<html lang="${lang}" data-theme="${boot.theme.mode === 'light' ? 'light' : 'dark'}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${assistantFramePolicy()}">`
    + '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(typeof block.title === 'string' ? block.title.slice(0, 120) : '')}</title>`
    + `<script>${RESTRICT}</script>`
    + `<style id="dima-theme">${safeStyle(themeCss(boot.theme))}</style>`
    + `<style id="dima-kit">${ASSISTANT_UI_KIT_CSS}</style>`
    + `<script>(${safeScript(ASSISTANT_UI_KIT_SOURCE)})(window, ${scriptJson(kitBoot)}, ${safeScript(DIMA_CHART_MARKUP_SOURCE)}, ${safeScript(DIMA_CHART_WIRE_SOURCE)});</script>`
    + (css ? `<style id="dima-card-style">${safeStyle(css)}</style>` : '')
    + `</head><body><div id="dima-root">${html}</div>`
    + (js ? `<script>${safeScript(js)}\n</script>` : '')
    + '</body></html>';
}

/** Relay document (the outer frame's srcdoc): same policy, transparent, full size, holds the card frame. */
export function buildRelayDocument(card: string, boot: Pick<UiRelayBoot, 'token' | 'title' | 'mode'>): string {
  const relayBoot: UiRelayBoot = { token: boot.token, title: boot.title, mode: boot.mode === 'light' ? 'light' : 'dark', policy: assistantFramePolicy(), card };
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${assistantFramePolicy()}">`
    + '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">'
    + `<title>${escapeHtml(relayBoot.title.slice(0, 120))}</title>`
    + `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color-scheme:${relayBoot.mode}}`
    + 'iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>'
    + `</head><body><script>(${safeScript(ASSISTANT_UI_RELAY_SOURCE)})(window, ${scriptJson(relayBoot)});</script></body></html>`;
}
