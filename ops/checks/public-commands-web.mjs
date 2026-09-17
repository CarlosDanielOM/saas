/** Behavior check: Live First public commands page (/commands/:streamer). */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

// 1. The public commands route resolves to the CSR shell (not the prerendered landing).
const page = await fetch(`${base}/commands/cdom201`);
assert.equal(page.status, 200, 'commands/:streamer route must resolve');
const html = await page.text();
assert.match(html, /<app-root/i, 'CSR shell must be served for /commands/:streamer');

// 2. i18n bundles expose the new Live First keys in both languages.
for (const lang of ['en', 'es']) {
  const res = await fetch(`${base}/assets/i18n/${lang}.json`);
  assert.equal(res.status, 200, `${lang}.json must be served`);
  const dict = await res.json();
  const pub = dict.commands?.public ?? {};
  for (const key of ['searchPlaceholder', 'noMatch', 'listTitle']) {
    assert.ok(pub[key], `${lang}: commands.public.${key} missing`);
  }
  assert.ok(pub.metrics?.total && pub.metrics?.enabled && pub.metrics?.disabled, `${lang}: metrics labels missing`);
  // Permission expressions: role labels + mode labels + fixed user level names.
  const levels = dict.commands?.userLevels ?? {};
  assert.ok(levels.vip && levels.founder && levels.broadcaster, `${lang}: fixed user level names (vip/founder/broadcaster) missing`);
  assert.ok(!levels.founders && !levels.streamer, `${lang}: legacy swapped level names must be gone`);
  const perm = dict.permissions ?? {};
  for (const role of ['everyone', 'sub', 'vip', 'founder', 'mod', 'editor', 'admin', 'broadcaster']) {
    assert.ok(perm.roles?.[role], `${lang}: permissions.roles.${role} missing`);
  }
  assert.ok(perm.mode?.level && perm.mode?.tags, `${lang}: permissions.mode labels missing`);
  assert.ok(perm.summary?.and && perm.summary?.or && perm.summary?.notRole, `${lang}: permissions.summary patterns missing`);
  assert.ok(perm.invalidLabel, `${lang}: permissions.invalidLabel missing`);
}

// 3. The page code must be served and contain the new search UI (lf-search)
//    wired to the search i18n key. The page is eagerly imported by app.routes,
//    so it ships in the main chunk; fall back to lazy chunks for safety.
const mainMatch = html.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the shell');
const mainJs = await (await fetch(`${base}/${mainMatch[1].replace(/^\//, '')}`)).text();
const hasSearchUi = (body) =>
  body.includes('commands.public.searchPlaceholder') && body.includes('lf-search');

let found = hasSearchUi(mainJs);
if (!found) {
  const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((m) => m[0]))];
  const concurrency = 8;
  for (let i = 0; i < chunkNames.length && !found; i += concurrency) {
    const batch = chunkNames.slice(i, i + concurrency);
    const bodies = await Promise.all(
      batch.map(async (name) => {
        const res = await fetch(`${base}/${name}`);
        return res.status === 200 ? res.text() : '';
      })
    );
    found = bodies.some(hasSearchUi);
  }
}
assert.ok(found, 'no served chunk contains the Live First public commands search UI');

// 4. The permission expression editor + localized descriptions ship in the
//    bundle so dashboards and public lists can describe expressions locally.
const chunkCandidates = [mainJs];
const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((m) => m[0]))];
for (let i = 0; i < chunkNames.length; i += 8) {
  const batch = chunkNames.slice(i, i + 8);
  const bodies = await Promise.all(
    batch.map(async (name) => {
      const res = await fetch(`${base}/${name}`);
      return res.status === 200 ? res.text() : '';
    })
  );
  chunkCandidates.push(...bodies);
}
assert.ok(
  chunkCandidates.some((body) => body.includes('app-permission-expression-editor') || body.includes('perm-preview__value')),
  'permission expression editor ships in the bundle'
);

console.log('public commands Live First bundle checks passed');
