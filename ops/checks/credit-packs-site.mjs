import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const page = await fetch(`${base}/cdom201/credits`);
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /<app-root/);

for (const language of ['en', 'es']) {
  const response = await fetch(`${base}/assets/i18n/${language}.json`);
  assert.equal(response.status, 200);
  const messages = await response.json();
  assert.ok(messages.creditPacks);
  assert.ok(messages.creditPacks.credit.description);
  assert.ok(messages.creditPacks.recharge.description);
  assert.ok(messages.creditPacks.recharge.expires);
  assert.ok(messages.navbar.buyCredits);
}

const mainMatch = html.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');
const main = await (await fetch(`${base}/${mainMatch[1].replace(/^\//, '')}`)).text();
const hasBillingClient = body => body.includes('billing/credit-packs');
const hasStoreUi = body =>
  body.includes('creditPacks.recharge.expires')
  && body.includes('lf-pack-card--recharge');
const hasNavigation = body => body.includes('navbar.buyCredits');

let foundBillingClient = hasBillingClient(main);
let foundStoreUi = hasStoreUi(main);
let foundNavigation = hasNavigation(main);
const visited = new Set();
const pending = [...new Set([...main.matchAll(/chunk-[A-Z0-9]+\.js/g)].map(match => match[0]))];
while (pending.length > 0 && (!foundBillingClient || !foundStoreUi || !foundNavigation)) {
  const names = pending.splice(0, 8).filter(name => !visited.has(name));
  names.forEach(name => visited.add(name));
  const bodies = await Promise.all(names.map(async name => {
    const response = await fetch(`${base}/${name}`);
    return response.status === 200 ? response.text() : '';
  }));
  foundBillingClient = foundBillingClient || bodies.some(hasBillingClient);
  foundStoreUi = foundStoreUi || bodies.some(hasStoreUi);
  foundNavigation = foundNavigation || bodies.some(hasNavigation);
  for (const body of bodies) {
    for (const match of body.matchAll(/chunk-[A-Z0-9]+\.js/g)) {
      if (!visited.has(match[0])) pending.push(match[0]);
    }
  }
}
assert.ok(foundBillingClient, 'no served chunk contains the credit store billing client');
assert.ok(foundStoreUi, 'no served chunk contains the credit and recharge pack distinction UI');
assert.ok(foundNavigation, 'no served chunk contains the credit store navigation entry');

console.log('PASS credit store route, translated distinction copy, navigation label, and billing client in production bundle');
