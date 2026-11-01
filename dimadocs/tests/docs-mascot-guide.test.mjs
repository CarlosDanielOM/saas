import test from 'node:test';
import assert from 'node:assert/strict';
import { sameDocumentHash, collectGuideTargets, resolveGuideTarget, createPageGuide } from '../src/lib/docs-mascot-guide.mjs';

test('guidance keeps canonical docs links local and rejects other documents or unsafe targets', () => {
  const current = 'http://127.0.0.1:4322/es/tts/';
  assert.equal(sameDocumentHash('#voice', current), 'voice');
  assert.equal(sameDocumentHash('https://docs.domdimabot.com/es/tts/index.txt#voice', current), 'voice');
  assert.equal(sameDocumentHash('/es/tts#voz%20favorita', current), 'voz favorita');
  for (const href of ['/tts/#voice', '/es/memories/#voice', '//other.example/es/tts/#voice',
    'https://other.example/es/tts/#voice', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:test@example.invalid',
    '/es/tts/?different=1#voice', '#%E0%A4%A', '#', '/es/tts/']) {
    assert.equal(sameDocumentHash(href, current), null, href);
  }
});

// A tiny article fixture exercises policy and sequencing without a browser or
// another DOM dependency. Runtime layout and focus are verified in the preview.
function article() {
  const events = [];
  let headings = [];
  const main = { contains: (node) => node.inMain, querySelectorAll: () => headings, querySelector: () => title };
  const doc = {
    querySelector: (selector) => selector === 'main' ? main : null,
    getElementById: (id) => [...headings, title, outside].find((node) => node.id === id),
    dispatchEvent: (event) => events.push(event),
  };
  const heading = (id, label, options = {}) => ({
    id, inMain: true, hidden: false, rendered: true, ...options,
    closest() { return this.hidden ? {} : null; },
    getClientRects() { return this.rendered ? [{}] : []; },
    cloneNode: () => ({ textContent: label, querySelectorAll: () => [] }),
  });
  const title = heading('_top', 'The page');
  const outside = heading('sidebar', 'Navigation', { inMain: false });
  headings = [heading('voice', 'Choose a voice'), heading('hidden', 'A hidden tab', { hidden: true }),
    heading('closed', 'A closed section', { rendered: false }), heading('limits', 'Set limits')];
  return { doc, headings, events, title, setHeadings: (next) => { headings = next; } };
}

test('tour selection ignores hidden panels and falls back to the visible article title', () => {
  const fixture = article();
  assert.deepEqual(collectGuideTargets(fixture.doc).map((node) => node.id), ['voice', 'limits']);
  fixture.setHeadings([]);
  assert.deepEqual(collectGuideTargets(fixture.doc), [fixture.title]);
  fixture.title.rendered = false;
  assert.deepEqual(collectGuideTargets(fixture.doc), []);
});

test('same-page source guidance resolves only visible article targets', () => {
  const { doc } = article();
  const current = 'https://docs.domdimabot.com/tts/';
  assert.equal(resolveGuideTarget('#voice', current, doc)?.id, 'voice');
  for (const href of ['#hidden', '#closed', '#sidebar', '#missing']) assert.equal(resolveGuideTarget(href, current, doc), null);
});

test('reader-started tours advance real sections and finish at the dock', () => {
  const { doc, events, headings } = article();
  const guide = createPageGuide(doc);
  assert.equal(events.length, 0, 'nothing moves before the reader starts');
  assert.equal(guide.start(), true);
  assert.equal(events[0].type, 'docs-mascot:guide');
  assert.equal(events[0].detail.target, headings[0]);
  assert.equal(events[0].detail.total, 2);
  assert.equal(guide.next(), true);
  assert.equal(events[1].detail.label, 'Set limits');
  assert.equal(guide.next(), false);
  assert.equal(events.at(-1).type, 'docs-mascot:home');
  assert.equal(guide.active, false);
  assert.equal(guide.stop(), false);
});
