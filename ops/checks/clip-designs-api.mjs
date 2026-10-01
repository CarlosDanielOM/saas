// Runs against the actual API in an isolated candidate with disposable dependencies.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:3000';
const expected = await readFile('/app/dist/server/routes/public/clip.html', 'utf8');
for (const design of ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash']) {
  const response = await fetch(`${base}/clip/990191?design=${design}`);
  assert.equal(response.status, 200, `clip page must be served for ${design}`);
  const html = await response.text();
  assert.equal(html, expected, 'API must serve the candidate overlay');
  assert.match(html, /\.skin video\s*\{[^}]*object-fit:\s*contain/s, 'show the complete source frame');
  assert.match(html, /window.innerHeight \/ overlay.offsetHeight/, 'responsive scale must use the selected canvas height');
  assert.match(html, /overlay.dataset.variant = variant;\s*applyResponsiveScale\(\)/, 'recalculate after selecting a design');
  assert.match(html, /\[data-variant='third'\].*\[data-variant='cinema'\].*\[data-variant='pill'\].*\[data-variant='hud'\].*\[data-variant='slash'\].*height: 450px/, 'video-led compositions have their own canvas');
  const slash = html.match(/\.overlay\[data-variant='slash'\] \.skin__video\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(slash, /clip-path:/, 'Slash decor must not mask the visible video');
  assert.match(slash, /inset:\s*0/, 'Slash video fills the canvas behind its decorative overlay');
  assert.match(html, /repeating-linear-gradient/, 'Slash includes a transparent mesh');
}
console.log('PASS API: all eight designs serve the candidate, preserve full frames, and scale their distinct canvases.');
