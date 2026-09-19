/** Behavior check: clips carousel mobile layout + live test-clip preview. */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

// 1. The clips route resolves to the CSR shell (not the prerendered landing).
const page = await fetch(`${base}/cdom201/clips`);
assert.equal(page.status, 200, 'clips route must resolve');
const shell = await page.text();
assert.match(shell, /<app-root/i, 'CSR shell must be served for /:streamer/clips');

// 2. i18n bundles expose the live-preview and test-flow keys in both languages.
for (const lang of ['en', 'es']) {
  const res = await fetch(`${base}/assets/i18n/${lang}.json`);
  assert.equal(res.status, 200, `${lang}.json must be served`);
  const dict = await res.json();
  const clips = dict.clips ?? {};
  for (const key of ['liveBadge', 'preview', 'mockPreview', 'noLiveData', 'testDesign']) {
    assert.ok(clips[key], `${lang}: clips.${key} missing`);
  }
  const test = clips.test ?? {};
  for (const key of [
    'connectingTitle',
    'connectingCopy',
    'sendingTitle',
    'playingTitle',
    'errorTitle',
    'retry',
    'testAgain',
    'stop'
  ]) {
    assert.ok(test[key], `${lang}: clips.test.${key} missing`);
  }
}

// 3. The built clips chunk must ship the live-stage iframe and test flow, and the
//    retired modal component must no longer be referenced anywhere.
const mainMatch = shell.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');
const mainJs = await (await fetch(`${base}/${mainMatch[1].replace(/^\//, '')}`)).text();
const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((m) => m[0]))];

const bodies = [mainJs];
const concurrency = 8;
for (let i = 0; i < chunkNames.length; i += concurrency) {
  const batch = chunkNames.slice(i, i + concurrency);
  const fetched = await Promise.all(
    batch.map(async (name) => {
      const res = await fetch(`${base}/${name}`);
      return res.status === 200 ? res.text() : '';
    })
  );
  bodies.push(...fetched);
}

const hasLivePreview = (body) =>
  body.includes('lf-live-stage') &&
  body.includes('lf-slide__preview') &&
  body.includes('clips.test.connectingTitle') &&
  body.includes('clips.test.testAgain') &&
  body.includes('app-clip-design-mock');
assert.ok(
  bodies.some(hasLivePreview),
  'no served chunk contains the live test-clip preview markup/logic'
);

assert.ok(
  !bodies.some((body) => body.includes('app-clip-test-modal')),
  'retired clip-test-modal component must not be referenced in the bundle'
);

console.log('clips carousel live-preview bundle checks passed');
