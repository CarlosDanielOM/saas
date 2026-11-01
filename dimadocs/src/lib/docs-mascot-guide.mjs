import { docsLink } from './assistant-markdown.mjs';

const blockedRegion = '[hidden], [inert], [aria-hidden="true"], nav, aside, docs-assistant, docs-mascot, [data-docs-mascot-stage]';
const pagePath = (path) => path.replace(/\/+$/, '') || '/';

/** Return a decoded anchor only when the link stays on this exact document. */
export function sameDocumentHash(href, currentUrl) {
  const link = docsLink(href);
  if (!link || link.external) return null;
  try {
    const current = new URL(currentUrl);
    const target = new URL(link.href, current);
    if (target.origin !== current.origin || pagePath(target.pathname) !== pagePath(current.pathname)
      || target.search !== current.search || !target.hash) return null;
    return decodeURIComponent(target.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

/** A tour can only point at real, visible content in the article. */
export function isGuideTarget(target, main) {
  if (!target || !main || !main.contains(target) || target.closest(blockedRegion)) return false;
  if (!target.getClientRects().length) return false;
  const style = target.ownerDocument?.defaultView?.getComputedStyle(target);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

export function guideHeadingLabel(target) {
  const copy = target.cloneNode(true);
  // Starlight's anchor includes screen-reader text which repeats the heading.
  copy.querySelectorAll('.sl-anchor-link, .sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
  return (copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function collectGuideTargets(doc = globalThis.document) {
  const main = doc?.querySelector('main');
  if (!main) return [];
  const headings = [...main.querySelectorAll('.sl-markdown-content h2')]
    .filter((heading) => isGuideTarget(heading, main));
  if (headings.length) return headings;
  const title = main.querySelector('h1');
  return isGuideTarget(title, main) ? [title] : [];
}

export function resolveGuideTarget(href, currentUrl, doc = globalThis.document) {
  const id = sameDocumentHash(href, currentUrl);
  if (!id || !doc) return null;
  const target = doc.getElementById(id);
  return isGuideTarget(target, doc.querySelector('main')) ? target : null;
}

/** Sequencing only: the mascot controller owns movement, scrolling and focus. */
export function createPageGuide(doc = globalThis.document) {
  let targets = [];
  let index = -1;
  const emit = (name, detail) => doc.dispatchEvent(new CustomEvent(name, { detail }));
  const stop = () => {
    const active = index >= 0;
    targets = [];
    index = -1;
    if (active) emit('docs-mascot:home');
    return active;
  };
  const show = () => {
    const target = targets[index];
    if (!isGuideTarget(target, doc.querySelector('main'))) return stop(), false;
    emit('docs-mascot:guide', { target, label: guideHeadingLabel(target), index, total: targets.length });
    return true;
  };
  return {
    start(target) {
      const sections = collectGuideTargets(doc);
      if (target && !isGuideTarget(target, doc.querySelector('main'))) return false;
      targets = target && !sections.includes(target) ? [target] : sections;
      index = target ? targets.indexOf(target) : 0;
      if (!targets.length || index < 0) { stop(); return false; }
      return show();
    },
    next() {
      if (index < 0) return false;
      do { index++; } while (index < targets.length && !isGuideTarget(targets[index], doc.querySelector('main')));
      if (index >= targets.length) { stop(); return false; }
      return show();
    },
    stop,
    get active() { return index >= 0; },
  };
}
