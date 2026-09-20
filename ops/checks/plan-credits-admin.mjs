/**
 * Behavior check: updated AI credit grant presets in the served admin bundle.
 *
 * The channel detail credit-grant panel builds its preset buttons from
 * `creditPresets`; the production bundle must carry the updated plan ceilings.
 */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const shell = await fetch(`${base}/`);
assert.equal(shell.status, 200);
const html = await shell.text();
assert.match(html, /<app-root/);

const mainMatch = html.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');

const expected = 'creditPresets=[25e3,2e5,8e5]';
const stale = 'creditPresets=[25e3,125e3,5e5]';
let found = false;
const visited = new Set();
const pending = [mainMatch[1].replace(/^\//, '')];

while (pending.length > 0 && !found) {
  const names = pending.splice(0, 8).filter((name) => !visited.has(name));
  names.forEach((name) => visited.add(name));
  const bodies = await Promise.all(names.map(async (name) => {
    const response = await fetch(`${base}/${name}`);
    return response.status === 200 ? response.text() : '';
  }));
  for (const body of bodies) {
    assert.ok(!body.includes(stale), 'served bundle must not contain stale credit presets');
    found = found || body.includes(expected);
    for (const match of body.matchAll(/chunk-[A-Z0-9]+\.js/g)) {
      if (!visited.has(match[0])) pending.push(match[0]);
    }
  }
}

assert.ok(found, `no served chunk contains ${expected}`);
console.log('PASS updated admin AI credit grant presets [25e3,2e5,8e5] in production bundle');
