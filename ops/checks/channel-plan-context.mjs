/** Behavior check: managed dashboards use the viewed channel's plan tier. */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const page = await fetch(`${base}/managed_channel/modules`);
assert.equal(page.status, 200, 'managed dashboard route must resolve to the CSR shell');
const shell = await page.text();
assert.match(shell, /<app-root/i, 'managed dashboard route must serve the app shell');

const mainMatch = shell.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');
const mainName = mainMatch[1].replace(/^\//, '');
const mainJs = await (await fetch(`${base}/${mainName}`)).text();
const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((match) => match[0]))];
const bodies = [mainJs];

for (let index = 0; index < chunkNames.length; index += 8) {
  const batch = chunkNames.slice(index, index + 8);
  bodies.push(
    ...(await Promise.all(
      batch.map(async (name) => {
        const response = await fetch(`${base}/${name}`);
        return response.status === 200 ? response.text() : '';
      })
    ))
  );
}

assert.ok(
  bodies.some(
    (body) => body.includes('getPlanTierForStreamer') && body.includes('setPlanTierForStreamer')
  ),
  'served app must store and resolve the viewed streamer plan tier'
);
assert.ok(
  bodies.some((body) => body.includes('plan_tier') && body.includes('administrating')),
  'served app must include managed-channel plan data in the session contract'
);

console.log('managed-channel frontend tier checks passed');
