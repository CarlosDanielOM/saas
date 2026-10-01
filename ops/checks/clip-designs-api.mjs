// Runs inside the isolated API candidate with the real server on loopback.
// The clip overlay is a served HTML asset; this asserts the shipped page gives every
// design a 16:9 clip slot and fits the whole frame instead of cropping top/bottom.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
const variants = ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash'];

for (const design of ['classic', 'hud', 'slash']) {
  const response = await fetch(`${base}/clip/990191?design=${design}`);
  assert.equal(response.status, 200, `clip page must be served for ${design}`);
  const html = await response.text();
  assert.match(html, /<title>Clips<\/title>/, 'served clip page must be the overlay document');
  assert.match(html, /\.skin video\s*\{[^}]*object-fit:\s*contain/s, 'the clip video must fit the whole frame (object-fit: contain)');

  const rules = new Map();
  for (const match of html.matchAll(/\.overlay\[data-variant='([a-z]+)'\] \.skin__video\s*\{([^}]*)\}/g)) {
    rules.set(match[1], match[2].replace(/\s+/g, ' ').trim());
  }
  for (const variant of variants) {
    const body = rules.get(variant);
    assert.ok(body, `missing .skin__video rule for ${variant}`);
    assert.ok(!/inset:\s*0\s*;/.test(body), `${variant} must not full-bleed (crop) the clip`);
    if (variant === 'orbit') {
      assert.match(body, /aspect-ratio:\s*16\s*\/\s*9/, 'orbit clip slot must be 16:9');
    } else {
      assert.match(body, /width:\s*400px/, `${variant} clip slot must be 400px wide (16:9 at 225px tall)`);
      assert.match(body, /height:\s*225px/, `${variant} clip slot must be 225px tall`);
    }
  }
}

console.log('PASS clip overlay API: every design serves a 16:9 (400x225) clip slot with object-fit contain, so the whole clip is shown instead of being cropped top and bottom.');
