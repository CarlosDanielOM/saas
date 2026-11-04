// Rebuild Twitch listing artwork with authentic DimaFX runtime captures.
// No server, production calls, image generation, checkout or live-file writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '..');
const root = path.resolve(here, '../../../..');
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const origin = 'https://dimafx-demo.invalid';
const sourceFiles = ['panel.html', 'mobile.html', 'panel.js', 'storefront.css', 'assets/logo-mark-white.png'];
const runtimePath = path.join(here, 'runtime');
// Keep all source inputs with the downloadable pack. Refresh only on request.
if (process.argv.includes('--refresh-source')) {
  for (const name of sourceFiles) {
    await fs.mkdir(path.dirname(path.join(runtimePath, name)), { recursive: true });
    await fs.copyFile(path.join(root, 'dimafx', name), path.join(runtimePath, name));
  }
  await fs.copyFile(path.join(root, 'dimasite/public/assets/brand/mark-on-dark.png'), path.join(here, 'brand-mark-original.png'));
}
const sources = new Map(await Promise.all(sourceFiles.map(async name => [name, await fs.readFile(path.join(runtimePath, name))])));
const mark = await fs.readFile(path.join(here, 'brand-mark-original.png'));
const dataImage = (buffer, type = 'image/png') => `data:${type};base64,${buffer.toString('base64')}`;
let brandImage = dataImage(mark);
const fonts = await Promise.all([['Medium', 500], ['Bold', 700], ['ExtraBold', 800]].map(async ([name, weight]) => {
  const data = await fs.readFile(path.join(here, 'fonts', `PlusJakartaSans-${name}.ttf`));
  return `@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:${weight};src:url(${dataImage(data, 'font/ttf')}) format('truetype');font-display:block}`;
}));
const fontCss = fonts.join('\n');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
const copy = {
  en: {
    demo: 'Demo content', storeTitle: 'Make chat part of the show.',
    storeSub: 'Sounds, visual effects and voices. One place to join in.',
    storeLabel: 'EXPLORE THE STORE', savedTitle: 'Save a little fun for later.', savedLabel: 'YOUR SAVED ITEMS',
    voiceTitle: 'Give your message<br>a voice.', voiceSub: 'Write a custom message.<br>Hear it on stream.',
    voiceNote: 'Custom messages require sharing<br>your Twitch ID.', voiceLabel: 'YOUR WORDS. ON STREAM.',
    categories: ['Sounds', 'Visuals', 'Voice'], voiceMessage: 'That was incredible! GG, chat.',
    discovery: 'Make chat part<br>of the show.',
    names: ['Confetti burst', 'Victory chime', 'Your message, aloud', 'GG, everyone!', 'Drum roll', 'Stream cheer'],
    descriptions: ['A little celebration for a big moment.', 'A bright sound for the win.', 'Write your own message for the stream.', 'A friendly GG for the whole chat.', 'Build up the moment.', 'A colorful cheer on screen.'],
  },
  es: {
    demo: 'Contenido de ejemplo', storeTitle: 'Tu chat, parte del show.',
    storeSub: 'Sonidos, efectos y voces. Todo para participar en el stream.',
    storeLabel: 'EXPLORA LA TIENDA', savedTitle: 'Guarda la diversión para después.', savedLabel: 'TUS ARTÍCULOS GUARDADOS',
    voiceTitle: 'Dale voz<br>a tu mensaje.', voiceSub: 'Escribe tu propio mensaje.<br>Hazlo sonar en el stream.',
    voiceNote: 'Para enviar texto propio, comparte<br>tu ID de Twitch.', voiceLabel: 'TUS PALABRAS. EN EL STREAM.',
    categories: ['Sonidos', 'Efectos', 'Voz'], voiceMessage: '¡Eso fue increíble! GG, chat.',
    discovery: 'Tu chat,<br>parte del show.',
    names: ['Lluvia de confeti', 'Sonido de victoria', 'Tu mensaje en voz alta', '¡GG para todos!', 'Redoble de tambor', 'Fiesta en el stream'],
    descriptions: ['Una celebración para un gran momento.', 'Un sonido brillante para la victoria.', 'Escribe tu propio mensaje para el stream.', 'Un GG para todo el chat.', 'Dale emoción al momento.', 'Una explosión de color en pantalla.'],
  },
};
const icons = {
  sounds: '<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',
  visuals: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/>',
  voice: '<path d="M5 4h14v12H9l-4 4V4Z"/><path d="M9 8h6M9 12h4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
function thumbnail(kind, lang) {
  const pieces = Array.from({ length: 23 }, (_, i) => {
    const x = (i * 67 + 22) % 320, y = (i * 43 + 18) % 180;
    return `<rect x="${x}" y="${y}" width="${i % 3 ? 6 : 4}" height="${i % 3 ? 13 : 6}" rx="2" fill="${['#a78bfa', '#fbbf24', '#f472b6', '#86efac'][i % 4]}" transform="rotate(${i * 29} ${x} ${y})"/>`;
  }).join('');
  const content = kind === 'confetti' ? `${pieces}<circle cx="160" cy="90" r="38" fill="#321e57" stroke="#8264b8"/><path d="m140 103 13-39 27 27-40 12Z" fill="#b69af8"/><path d="m162 66 5-15m12 23 15-6m-25 13 17-13" stroke="#fbbf24" stroke-width="4" stroke-linecap="round"/>`
    : kind === 'gg' ? `<circle cx="160" cy="90" r="62" fill="#31204f" stroke="#654893"/>${pieces}<text x="160" y="110" text-anchor="middle" font-family="Arial,sans-serif" font-size="58" font-weight="800" fill="#f4edff">GG</text>`
    : `${pieces}<path d="m160 37 15 31 35 5-25 25 6 35-31-17-31 17 6-35-25-25 35-5Z" fill="#c0a0ff"/><path d="m147 85 10 10 19-20" fill="none" stroke="#31204f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><radialGradient id="b"><stop stop-color="#362050"/><stop offset="1" stop-color="#171423"/></radialGradient></defs><rect width="320" height="180" fill="url(#b)"/>${content}</svg>`;
}
function fixture(lang) {
  const c = copy[lang];
  const cats = ['gif', 'audio', 'tts', 'gif', 'audio', 'gif'];
  const prices = [0, 5, 25, 10, 50, 100];
  return c.names.map((name, i) => ({
    id: `demo-${i + 1}`, name, category: cats[i], bitsPrice: prices[i],
    sku: prices[i] ? `dimafx_bits_${prices[i]}` : 'dimafx_free',
    description: c.descriptions[i], mediaType: cats[i] === 'gif' ? 'image/png' : 'audio',
    ...(cats[i] === 'gif' ? { thumbnailUrl: `${origin}/demo/${['confetti', '', '', 'gg', '', 'cheer'][i]}.svg`, mediaUrl: `${origin}/demo/${['confetti', '', '', 'gg', '', 'cheer'][i]}.svg` } : {}),
    ...(cats[i] === 'tts' ? { tts: { mode: 'custom', language: lang } } : {}),
    channelName: 'DemoStreamer',
  }));
}
async function runtime(lang, file, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [], requests = [];
  await context.addInitScript(() => {
    window.demoCheckoutCalls = 0;
    window.Twitch = { ext: {
      actions: { requestIdShare() {} },
      onAuthorized(fn) { window.demoAuthorize = fn; },
      onContext(fn) { setTimeout(() => fn({ theme: 'dark' }, ['theme'])); },
      bits: { useBits() { window.demoCheckoutCalls++; throw new Error('Checkout is forbidden during asset rendering'); }, onTransactionComplete() {}, onTransactionCancelled() {} },
    } };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push({ method: route.request().method(), url: url.href });
    assert.equal(route.request().method(), 'GET', 'Listing captures must never mutate data');
    if (url.origin === origin && url.pathname.startsWith('/api/v1/')) {
      let data;
      if (url.pathname.endsWith('/overlay-status')) data = { connected: true };
      else if (url.pathname.endsWith('/me')) data = { identityShared: true, inventory: { balance: 0, items: [{ channelExtensionItemID: 'demo-2', quantity: 1 }, { channelExtensionItemID: 'demo-4', quantity: 1 }], config: { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' } } };
      else if (url.pathname.endsWith('/items')) data = fixture(lang);
      else throw new Error(`Unexpected fixture API: ${url.pathname}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: false, data }) });
    }
    if (url.origin === origin && url.pathname.startsWith('/demo/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: thumbnail(path.basename(url.pathname, '.svg'), lang) });
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: fontCss });
    if (url.hostname === 'extension-files.twitch.tv') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    const local = url.pathname.slice(1);
    if (url.origin === origin && sources.has(local)) return route.fulfill({ status: 200, contentType: local.endsWith('.html') ? 'text/html' : local.endsWith('.css') ? 'text/css' : local.endsWith('.js') ? 'text/javascript' : 'image/png', body: sources.get(local) });
    throw new Error(`Network access forbidden: ${url.href}`);
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/${file}?language=${lang}`);
  await page.waitForFunction(() => typeof window.demoAuthorize === 'function');
  await page.evaluate(() => window.demoAuthorize({ token: 'listing-fixture-only', channelId: '999983' }));
  await page.waitForFunction(() => overlayConnected && identityShared && products.length === 6);
  await page.locator('.fx-tile').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Actual UI has no horizontal overflow');
  return { context, page, errors, requests };
}
async function capture(lang, type) {
  console.log(`Capturing ${lang} ${type}`);
  const dimensions = type === 'store' ? { width: 524, height: 584 } : type === 'saved' ? { width: 334, height: 330 } : { width: 390, height: 620 };
  const { context, page, errors, requests } = await runtime(lang, type === 'saved' ? 'panel.html' : 'mobile.html', dimensions);
  if (type === 'saved') await page.locator('.nav-tab').nth(1).click();
  if (type === 'voice') {
    await page.locator('.fx-tile[data-id="demo-3"] .price-btn').click();
    await page.locator('#preview-drawer.open').waitFor();
    await page.locator('#tts-text-input').fill(copy[lang].voiceMessage);
    await page.locator('#tts-text-input').blur();
    assert.equal(await page.locator('.drawer-buy-btn.bits').isEnabled(), true, 'Actual custom-voice form accepts a fixture message');
  }
  if (type === 'store') {
    const bottom = await page.locator('.fx-tile').last().boundingBox();
    const tabs = await page.locator('.fx-tabs').boundingBox();
    assert.ok(bottom.y + bottom.height <= tabs.y + 1, 'All six catalog tiles and their price buttons fit above navigation');
  }
  await page.evaluate(() => Promise.all([...document.images].filter(i => i.getBoundingClientRect().top < innerHeight && i.getBoundingClientRect().bottom > 0).map(i => i.decode())));
  const filename = `${lang}-${type}.png`;
  const buffer = await page.screenshot({ path: path.join(here, 'captures', filename), animations: 'disabled', scale: 'css' });
  assert.equal(await page.evaluate(() => window.demoCheckoutCalls), 0, 'No Twitch checkout initiated');
  assert.deepEqual(errors, [], 'Actual runtime has no uncaught errors');
  results.push({ capture: filename, viewport: dimensions, checkoutCalls: 0, mutations: requests.filter(r => r.method !== 'GET').length });
  await context.close();
  return dataImage(buffer);
}
const globalCss = `${fontCss}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:'Plus Jakarta Sans',sans-serif;color:#f5f7fb;background:#0f1115;font-weight:500}svg{width:24px;height:24px}.art{position:relative;width:100%;height:100%;overflow:hidden;background:radial-gradient(ellipse at 84% 7%,#28184199 0,transparent 48%),#0f1115}.art:after{content:'';position:absolute;z-index:0;inset:0;background-image:linear-gradient(#ffffff02 1px,transparent 1px),linear-gradient(90deg,#ffffff02 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(black,transparent)}.art>*{position:relative;z-index:1}.brand{display:flex;align-items:center;gap:12px;font-size:29px;font-weight:800;letter-spacing:-1.1px}.brand img{width:37px;height:37px;object-fit:contain}.brand b{font-weight:800;color:#c4b5fd}.top{display:flex;justify-content:space-between;align-items:center}.demo{font-size:11px;letter-spacing:.2px;color:#a7b0c2;padding:7px 11px;border:1px solid #ffffff12;border-radius:99px}.live{display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef44441a;margin-left:9px;vertical-align:middle}.label{font-size:10px;font-weight:800;letter-spacing:1.7px;color:#a7b0c2}.frame{overflow:hidden;border:1px solid #ffffff24;border-radius:17px;background:#0f1115;box-shadow:0 20px 60px #0006}.frame img{display:block;width:100%;height:auto}.categories{display:flex;align-items:center;gap:20px;font-size:12px;color:#a7b0c2}.category{display:flex;align-items:center;gap:6px}.category svg{width:16px;height:16px;color:#c4b5fd}.footer{position:absolute;left:44px;right:44px;bottom:21px;display:flex;justify-content:space-between;align-items:center}.footer .fine{font-size:10px;color:#7f8a9e}h1,p{margin:0}h1{font-weight:800;letter-spacing:-1.6px;line-height:1.14}p{color:#a7b0c2;line-height:1.65}`;
const brand = () => `<div class="brand"><img src="${brandImage}" alt=""><span>Dima<b>FX</b><i class="live"></i></span></div>`;
const categoryList = (lang, active = false) => `<div class="categories">${['sounds', 'visuals', 'voice'].map((name, i) => `<span class="category" ${active && i === 2 ? 'style="color:#f5f7fb"' : ''}>${icon(name)}${copy[lang].categories[i]}</span>`).join('')}</div>`;
async function artboard(file, width, height, body, css = '') {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await context.route('**/*', route => { throw new Error(`Artboard attempted network access: ${route.request().url()}`); });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="UTF-8"><style>${globalCss}${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
  const metrics = await page.evaluate(() => [...document.querySelectorAll('h1,p,.label,.demo')].map(e => ({ text: e.innerText, width: e.clientWidth, scroll: e.scrollWidth })));
  assert.ok(metrics.every(m => m.scroll <= m.width + 1), `No text clips in ${file}: ${JSON.stringify(metrics)}`);
  await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
  await context.close();
}
async function logos() {
  const page = await browser.newPage();
  await page.setContent('<canvas></canvas>');
  // Strengthen the source mark's faint alpha without redrawing its artwork.
  // This is equivalent to six source-over passes of the original white mark;
  // contours, proportions and negative space remain those of the source PNG.
  brandImage = await page.evaluate(async source => {
    const img = new Image(); img.src = source; await img.decode();
    const canvas = document.querySelector('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
      pixels.data[i + 3] = Math.round(255 * (1 - Math.pow(1 - pixels.data[i + 3] / 255, 6)));
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  }, brandImage);
  for (const [name, size, transparent] of [['logo-100x100.png', 100, false], ['taskbar-icon-24x24.png', 24, false], ['logo-transparent-100x100.png', 100, true]]) {
    const data = await page.evaluate(async ({ brandImage, size, transparent }) => {
      const img = new Image(); img.src = brandImage; await img.decode();
      const canvas = document.querySelector('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!transparent) { ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, size, size); }
      const pad = size === 24 ? 2 : 10, ratio = Math.min((size - 2 * pad) / img.naturalWidth, (size - 2 * pad) / img.naturalHeight);
      const w = img.naturalWidth * ratio, h = img.naturalHeight * ratio;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      return canvas.toDataURL('image/png');
    }, { brandImage, size, transparent });
    await fs.writeFile(path.join(output, name), Buffer.from(data.split(',')[1], 'base64'));
  }
  await page.close();
}
async function verifyOutputs() {
  const expected = [['logo-100x100.png', 100, 100], ['taskbar-icon-24x24.png', 24, 24], ['logo-transparent-100x100.png', 100, 100], ...['en', 'es'].flatMap(lang => [[`${lang}/discovery-300x200.png`, 300, 200], [`${lang}/screenshot-01-store-1024x768.png`, 1024, 768], [`${lang}/screenshot-02-voice-1024x768.png`, 1024, 768]])];
  const page = await browser.newPage();
  const verified = [];
  for (const [name, width, height] of expected) {
    const bytes = await fs.readFile(path.join(output, name));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${name} is PNG`);
    assert.equal(bytes.readUInt32BE(16), width, `${name} width`);
    assert.equal(bytes.readUInt32BE(20), height, `${name} height`);
    assert.ok(bytes.length < 10 * 1024 * 1024, `${name} below 10 MB`);
    const opaque = await page.evaluate(async src => {
      const img = new Image(); img.src = src; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
      return true;
    }, dataImage(bytes));
    if (!name.includes('transparent')) assert.ok(opaque, `${name} opaque`);
    verified.push({ file: name, width, height, bytes: bytes.length, opaque, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await page.close();
  return verified;
}
try {
  await fs.mkdir(path.join(here, 'captures'), { recursive: true });
  await logos();
  for (const lang of ['en', 'es']) {
    await fs.mkdir(path.join(output, lang), { recursive: true });
    const c = copy[lang];
    const [store, saved, voice] = [await capture(lang, 'store'), await capture(lang, 'saved'), await capture(lang, 'voice')];
    await artboard(`${lang}/discovery-300x200.png`, 300, 200,
      `<main class="art discovery">${brand()}<h1>${c.discovery}</h1>${categoryList(lang)}<div class="corner"></div></main>`,
      `.discovery{padding:21px 24px;background:radial-gradient(ellipse at 105% 100%,#59339388,transparent 65%),#0f1115}.discovery .brand{gap:9px;font-size:25px;letter-spacing:-.8px}.discovery .brand img{width:31px;height:31px}.discovery .live{width:5px;height:5px;margin-left:8px}.discovery h1{font-size:25px;line-height:1.18;letter-spacing:-.9px;margin-top:18px}.discovery .categories{gap:12px;font-size:9px;margin-top:17px}.discovery .category{gap:4px}.discovery .category svg{width:12px;height:12px}.corner{position:absolute;right:-28px;top:33px;width:100px;height:100px;border:1px solid #a78bfa1f;border-radius:50%;box-shadow:0 0 0 17px #a78bfa07,0 0 0 34px #a78bfa04;z-index:0}`);
    await artboard(`${lang}/screenshot-01-store-1024x768.png`, 1024, 768,
      `<main class="art store"><div class="top">${brand()}<span class="demo">${c.demo}</span></div><h1>${c.storeTitle}</h1><p class="subtitle">${c.storeSub}</p><div class="showcase"><section class="main-ui"><div class="label">${c.storeLabel}</div><div class="frame"><img src="${store}" alt="Actual DimaFX storefront"></div></section><section class="saved-ui"><h2>${c.savedTitle}</h2><div class="label">${c.savedLabel}</div><div class="frame"><img src="${saved}" alt="Actual saved items screen"></div></section></div><div class="footer">${categoryList(lang)}<span class="fine">DimaFX · ${lang === 'en' ? 'Panel & mobile' : 'Panel y móvil'}</span></div></main>`,
      `.store{padding:29px 44px}.store h1{font-size:34px;margin-top:20px}.subtitle{font-size:12px;margin-top:7px}.showcase{display:grid;grid-template-columns:480px 336px;gap:38px;margin-top:15px}.main-ui .label{margin-bottom:10px}.saved-ui{padding-top:57px}.saved-ui h2{font-size:21px;font-weight:700;line-height:1.4;letter-spacing:-.5px;margin:0 0 20px}.saved-ui .label{margin-bottom:10px}.store .frame{border-radius:15px}.store .footer{bottom:16px}`);
    await artboard(`${lang}/screenshot-02-voice-1024x768.png`, 1024, 768,
      `<main class="art voice"><div class="top">${brand()}<span class="demo">${c.demo}</span></div><section class="story"><span class="label">${c.voiceLabel}</span><h1>${c.voiceTitle}</h1><p class="voice-sub">${c.voiceSub}</p><div class="wave">${Array.from({ length: 23 }, (_, i) => `<i style="--h:${[18, 29, 42, 24, 59, 76, 54, 92, 66, 47, 82, 108, 80, 53, 72, 45, 62, 31, 43, 26, 34, 19, 10][i]}px"></i>`).join('')}</div><p class="identity">${icon('voice')}<span>${c.voiceNote}</span></p></section><div class="voice-ui"><div class="frame"><img src="${voice}" alt="Actual custom voice message form"></div></div><div class="footer">${categoryList(lang, true)}<span class="fine">DimaFX · ${lang === 'en' ? 'Custom voice' : 'Voz personalizada'}</span></div></main>`,
      `.voice{padding:29px 44px;background:radial-gradient(ellipse at 80% 50%,#38244a66,transparent 58%),#0f1115}.story{position:absolute;left:52px;top:171px;width:440px}.story .label{color:#c4b5fd}.story h1{font-size:43px;line-height:1.15;margin-top:19px;letter-spacing:-1.8px}.voice-sub{font-size:17px;margin-top:22px}.wave{display:flex;align-items:center;gap:5px;height:116px;margin-top:20px;width:284px;mask-image:linear-gradient(90deg,transparent,#000 10%,#000 85%,transparent)}.wave i{display:block;flex:1;height:var(--h);border-radius:9px;background:linear-gradient(#c4b5fd,#7c3aed);opacity:.65}.identity{display:flex;align-items:center;gap:10px;font-size:11px;margin-top:17px;line-height:1.7}.identity svg{width:20px;height:20px;color:#a78bfa}.voice-ui{position:absolute;left:547px;top:97px;width:392px}.voice-ui .frame{border-radius:20px}.voice .footer{bottom:18px}`);
  }
  const pngs = await verifyOutputs();
  await fs.writeFile(path.join(here, 'verification.json'), JSON.stringify({ runtimeFiles: Object.fromEntries([...sources].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])), brandSource: 'dimasite/public/assets/brand/mark-on-dark.png', brandSha256: createHash('sha256').update(mark).digest('hex'), captures: results, pngs, externalNetworkRequests: 0 }, null, 2) + '\n');
  console.log('PASS: 9 listing PNG sizes, file limits and opaque backgrounds; 6 authentic UI captures, full store rows, 0 runtime errors, 0 mutations, 0 checkout calls, 0 external network requests.');
} finally { await browser.close(); }
