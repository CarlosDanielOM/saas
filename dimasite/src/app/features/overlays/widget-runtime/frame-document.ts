import type { JsonObject, JsonValue } from '../custom-widget-format.generated';
import type { WidgetEngine } from '../custom-widget-format.generated';

/** A widget revision as the runtime needs it (owner bundle in the editor, public bundle in OBS). */
export interface WidgetBundle {
  widgetId: string; revision: number; engine: WidgetEngine;
  uses: string[];
  html: string; css: string; js: string;
  /** Remote URL → our URL for files copied into the channel's storage (already resolved for this page). */
  media: Record<string, string>;
}
/** `sdk` is the Dima SDK function source (called with boot data); `shim` and `jquery` are complete scripts. */
export interface FrameScripts { sdk: string; shim: string; jquery: string }
/** Per-run boot data: `exec` tags every message of this run; `origin` becomes the base URL (never the overlay's link). */
export interface FrameBoot { exec: string; origin: string }

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]{1,64})\s*\}\}|\{([A-Za-z0-9_-]{1,64})\}/g;
const asText = (value: JsonValue | undefined): string =>
  value === null || value === undefined ? '' : Array.isArray(value) ? value.map(item => asText(item)).join(',') : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** `{key}` / `{{key}}` → the setting's value, only for keys that exist (StreamElements behaviour). */
export function substitute(text: string, values: Readonly<JsonObject>): string {
  return text.replace(PLACEHOLDER, (match, double: string | undefined, single: string | undefined) => {
    const key = (double ?? single)!;
    return Object.hasOwn(values, key) ? asText(values[key]) : match;
  });
}
/** Replaces copied remote files with our URLs in text and setting values (longest URLs first). */
export function rewriteMedia(text: string, media: Readonly<Record<string, string>>): string {
  const urls = Object.keys(media).sort((a, b) => b.length - a.length);
  return urls.reduce((out, url) => out.split(url).join(media[url]), text);
}
export function rewriteValues(values: JsonObject, media: Readonly<Record<string, string>>): JsonObject {
  if (!Object.keys(media).length) return values;
  const walk = (value: JsonValue): JsonValue => typeof value === 'string' ? rewriteMedia(value, media)
    : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value;
  return walk(values) as JsonObject;
}
// Text placed inside <script>/<style> must not close them early.
const safeScript = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const safeStyle = (text: string) => text.replace(/<\/(style)/gi, '<\\/$1');

/**
 * Inline `onerror="fn(this)"` handlers in the widget's HTML can fire (e.g. `<img src="">`) before the widget's script at
 * the end of <body> has defined `fn`. Hold those error events until the script has run, then replay them, so the
 * handler finds its function (StreamElements widgets rely on this).
 */
const HOLD_ERRORS = "(function(){var held=[],hold=function(e){var t=e.target;if(t&&t.nodeType===1&&t.hasAttribute('onerror')){e.stopImmediatePropagation();"
  + "for(var i=0;i<held.length;i++)if(held[i][0]===t)return;held.push([t,t.getAttribute('src')]);}};"
  + "addEventListener('error',hold,true);Object.defineProperty(window,'__dimaReleaseErrors',{configurable:true,value:function(){removeEventListener('error',hold,true);"
  + "delete window.__dimaReleaseErrors;held.splice(0).forEach(function(h){var t=h[0];"
  // Replayed once, only while the element is still in the page with the same source and an onerror handler.
  + "if(t.isConnected&&t.getAttribute('src')===h[1]&&typeof t.onerror==='function')t.dispatchEvent(new Event('error'));});}});})();";
const RELEASE_ERRORS = 'window.__dimaReleaseErrors&&window.__dimaReleaseErrors();';

/**
 * The sandboxed frame's document: base style, Dima SDK, then (StreamElements engine) jQuery and the SE layer,
 * then the widget's CSS, HTML and a classic, non-strict script at the end of <body>.
 */
export function buildFrameDocument(bundle: WidgetBundle, values: JsonObject, scripts: FrameScripts, boot: FrameBoot): string {
  const se = bundle.engine === 'streamelements';
  const fields = rewriteValues(values, bundle.media);
  const prepare = (text: string, substituteValues: boolean) => {
    const rewritten = rewriteMedia(text, bundle.media);
    return substituteValues ? substitute(rewritten, fields) : rewritten;
  };
  const css = prepare(bundle.css, true), html = prepare(bundle.html, true), js = prepare(bundle.js, se);
  const bootJson = JSON.stringify({ exec: boot.exec, fields }).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
    + `<meta http-equiv="Content-Security-Policy" content="object-src 'none'; form-action 'none'">`
    + `<base href="${boot.origin.replace(/"/g, '')}/">`
    + '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}</style>'
    + `<script>(${safeScript(scripts.sdk)})(window, ${bootJson});</script><script>${HOLD_ERRORS}</script>`
    + (se ? `<script>${safeScript(scripts.jquery)}</script><script>${safeScript(scripts.shim)}</script>` : '')
    + `<style>${safeStyle(css)}</style></head><body>${html}`
    + `<script>${safeScript(js)}\n</script><script>${RELEASE_ERRORS}</script></body></html>`;
}
