/**
 * The outer frame of an assistant card: our code only, no model code.
 *
 * Why two frames: a sandboxed frame can always navigate itself (`location.href = …`, `<meta http-equiv=refresh>`), and
 * the Navigation API can't cancel that on an opaque origin. What blocks it is the embedding document's `frame-src`.
 * dimasite has no such policy (and must not get a site-wide one), so the card runs inside this relay, whose policy has
 * `frame-src 'none'`: the card's own srcdoc still loads, any later navigation is refused before a request leaves.
 * The relay forwards messages (token-checked) between the page and the card, and reports `stopped` when the card
 * tried to load another page.
 *
 * Inlined into the relay document as text (`.toString()`): self-contained, no imports, no object spread.
 */

export interface UiRelayBoot {
  token: string;
  /** The complete card document (srcdoc of the inner frame). */
  card: string;
  title: string;
  mode: 'dark' | 'light';
  /** Policy for the inner frame's `csp` attribute (same as its meta policy). */
  policy: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function assistantUiRelay(win: any, boot: UiRelayBoot): void {
  'use strict';
  const doc = win.document;
  const parent = win.parent;
  const token = String(boot.token);
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('csp', boot.policy);
  frame.setAttribute('allow', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', boot.title);
  frame.style.colorScheme = boot.mode;
  let loads = 0;
  let stopped = false;
  const toPage = (message: any) => { try { parent.postMessage(message, '*'); } catch { /* page gone */ } };
  frame.addEventListener('load', () => {
    // First load: the card. Any later one: it tried to open another page (blocked by this document's frame-src).
    if (++loads > 1 && !stopped) {
      stopped = true;
      frame.remove();
      toPage({ dimaUi: 1, token, type: 'stopped' });
    }
  });
  win.addEventListener('message', (event: any) => {
    const data = event.data;
    if (!data || data.dimaUi !== 1 || data.token !== token) return;
    // From the card: forwarded as is (the page validates); only the relay itself may say `stopped`.
    if (event.source === frame.contentWindow) { if (data.type !== 'stopped') toPage(data); return; }
    if (event.source !== parent || stopped) return;
    if (data.type === 'theme' && data.theme) {
      const mode = data.theme.mode === 'light' ? 'light' : 'dark';
      doc.documentElement.style.colorScheme = mode;
      frame.style.colorScheme = mode;
    }
    try { frame.contentWindow.postMessage(data, '*'); } catch { /* card gone */ }
  });
  frame.srcdoc = boot.card;
  doc.body.appendChild(frame);
}

export const ASSISTANT_UI_RELAY_SOURCE = assistantUiRelay.toString();
