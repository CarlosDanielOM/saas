// Link-preview image release check (site target): the built bundle must point the Open Graph and Twitter
// meta tags at the new image and serve that exact file. No browser needed.
// SAAS_PREVIEW_URL=http://127.0.0.1:PORT node ops/checks/og-image.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');

const IMAGE = '/og-image-v2.jpg';                       // new name so social caches refetch
const LEGACY = '/og-image.jpg';                         // old URL keeps serving the same new image
const ABS = `https://domdimabot.com${IMAGE}`;
const EXPECTED_SHA256 = 'bddf76bc078f6a84028efd9e6d0837923f07362c2a1f3c6ae7e8117dfa37650b'; // marketing/og/og-b-chat-en.jpg
const WHATSAPP_LIMIT = 300 * 1024;                      // larger images get no big preview on WhatsApp

const get = async path => { const r = await fetch(base + path); assert.equal(r.status, 200, `${path} status`); return r; };
function meta(doc, attr, name) {
  const tag = doc.match(new RegExp(`<meta[^>]*\\s${attr}="${name.replace(/[:.]/g, '\\$&')}"[^>]*>`));
  assert(tag, `${name} meta missing`);
  const content = tag[0].match(/\scontent="([^"]*)"/);
  assert(content, `${name} has no content`);
  return content[1];
}
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'not a JPEG');
  for (let i = 2; i < buf.length;) {
    assert.equal(buf[i], 0xff, 'bad JPEG marker');
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return {height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7)};
    i += 2 + len;
  }
  assert.fail('JPEG has no frame header');
}

let checks = 0;
for (const path of ['/', '/index.csr.html']) {                // prerendered landing + CSR fallback for app routes
  const doc = await (await get(path)).text();
  assert.equal(meta(doc, 'property', 'og:image'), ABS, `${path} og:image`);
  assert.equal(meta(doc, 'property', 'og:image:secure_url'), ABS, `${path} og:image:secure_url`);
  assert.equal(meta(doc, 'name', 'twitter:image'), ABS, `${path} twitter:image`);
  assert.equal(meta(doc, 'property', 'og:image:type'), 'image/jpeg', `${path} og:image:type`);
  assert.equal(meta(doc, 'property', 'og:image:width'), '1200', `${path} og:image:width`);
  assert.equal(meta(doc, 'property', 'og:image:height'), '630', `${path} og:image:height`);
  assert.doesNotMatch(doc, /og-image\.jpg["']/, `${path} still references the old image name`);
  checks += 7;
}
for (const path of [IMAGE, LEGACY]) {
  const r = await get(path);
  const type = r.headers.get('content-type');
  if (type) assert.match(type, /^image\/jpeg/, `${path} content-type`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(createHash('sha256').update(buf).digest('hex'), EXPECTED_SHA256, `${path} bytes differ from the chosen candidate`);
  assert.deepEqual(jpegSize(buf), {width: 1200, height: 630}, `${path} dimensions`);
  assert(buf.length < WHATSAPP_LIMIT, `${path} is ${buf.length} bytes`);
  checks += 4;
}
console.log(`PASS og-image: ${checks} assertions; ${IMAGE} and ${LEGACY} serve sha256 ${EXPECTED_SHA256.slice(0, 12)}… (1200x630 JPEG), meta tags point at ${ABS}`);
