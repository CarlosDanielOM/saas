#!/usr/bin/env node
// Creates the DimaFX Bits products in Twitch's catalog (one per Bits amount, SKU `bits<amount>`) through the Helix API,
// so nobody has to click 186 products into the Extensions console. Safe by default:
//   node ops/dimafx-bits-products.mjs              dry run: shows what exists, what's missing and any conflict
//   node ops/dimafx-bits-products.mjs --apply      creates missing products as test products (In Development = yes)
//   node ops/dimafx-bits-products.mjs --release    after Twitch approval: switches every bits<N> product to live
//   --display-name "Play on stream"                the name Twitch shows in its Bits confirmation (changeable later)
// Credentials (the extension's API client, not the base64 extension secret):
//   TWITCH_EXTENSION_CLIENT_ID and TWITCH_EXTENSION_CLIENT_SECRET, or TWITCH_EXTENSION_CLIENT_SECRET_FILE.
// It never deletes a product (Twitch can't) and never changes the cost of an existing SKU.
import fs from 'node:fs';

// Same bands as DIMAFX_BITS_TIER_BANDS in dimabot/src/server/services/dimafx.service.ts (186 products).
const BANDS = [
  { from: 5, to: 100, step: 5 },
  { from: 125, to: 1000, step: 25 },
  { from: 1050, to: 5000, step: 50 },
  { from: 5100, to: 10000, step: 100 },
];
const TWITCH_CATALOG_LIMIT = 250;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const apply = flag('--apply');
const release = flag('--release');
const displayName = option('--display-name', 'Play on stream');
if (apply && release) throw new Error('Use --apply (create test products) or --release (go live), not both.');

const amounts = BANDS.flatMap(({ from, to, step }) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step));
const wanted = new Map(amounts.map((amount) => [`bits${amount}`, amount]));
if (wanted.size > TWITCH_CATALOG_LIMIT) throw new Error(`${wanted.size} products exceed Twitch's ${TWITCH_CATALOG_LIMIT}-product catalog`);

const clientId = process.env.TWITCH_EXTENSION_CLIENT_ID?.trim();
const secretFile = process.env.TWITCH_EXTENSION_CLIENT_SECRET_FILE;
const clientSecret = (secretFile ? fs.readFileSync(secretFile, 'utf8') : process.env.TWITCH_EXTENSION_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) throw new Error('Set TWITCH_EXTENSION_CLIENT_ID and TWITCH_EXTENSION_CLIENT_SECRET (or _SECRET_FILE).');

const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
});
if (!tokenResponse.ok) throw new Error(`Twitch app token request failed (${tokenResponse.status}). Check the extension's client ID/secret.`);
const { access_token: token } = await tokenResponse.json();
const helix = async (method, body) => {
  const response = await fetch(`https://api.twitch.tv/helix/bits/extensions${method === 'GET' ? '?should_include_all=true' : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Helix ${method} bits/extensions failed (${response.status}): ${payload.message || 'no message'}`);
  return payload;
};

const existing = new Map(((await helix('GET')).data || []).map((product) => [product.sku, product]));
const missing = [], conflicts = [], toRelease = [];
for (const [sku, amount] of wanted) {
  const product = existing.get(sku);
  if (!product) { missing.push([sku, amount]); continue; }
  const cost = Number(product.cost?.amount);
  // Test products may report 0 Bits; otherwise the catalog must charge exactly the amount the SKU names.
  if (cost !== amount && !(product.in_development && cost === 0)) conflicts.push(`${sku} costs ${cost} Bits in Twitch, expected ${amount}`);
  else if (product.in_development) toRelease.push([sku, amount, product]);
}
const unrelated = [...existing.keys()].filter((sku) => !wanted.has(sku));
console.log(`Catalog: ${existing.size} products in Twitch, ${wanted.size} wanted, ${missing.length} missing, ${toRelease.length} still in development.`);
if (unrelated.length) console.log(`Other products (left alone): ${unrelated.join(', ')}`);
if (conflicts.length) console.log(`Conflicts (left alone, fix by hand):\n  ${conflicts.join('\n  ')}`);
if (existing.size + missing.length > TWITCH_CATALOG_LIMIT) throw new Error(`Creating ${missing.length} would exceed Twitch's ${TWITCH_CATALOG_LIMIT}-product limit.`);

if (apply) {
  for (const [sku, amount] of missing) {
    await helix('PUT', { sku, cost: { amount, type: 'bits' }, display_name: displayName, in_development: true, is_broadcast: false });
    process.stdout.write(`created ${sku} (${amount} Bits, test)\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
} else if (release) {
  for (const [sku, amount, product] of toRelease) {
    await helix('PUT', { sku, cost: { amount, type: 'bits' }, display_name: product.display_name || displayName, in_development: false, is_broadcast: false });
    process.stdout.write(`released ${sku} (${amount} Bits)\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
} else {
  if (missing.length) console.log(`Would create (test products): ${missing.map(([sku]) => sku).join(', ')}`);
  console.log('Dry run only. Re-run with --apply to create the missing products, or --release after Twitch approval.');
}
