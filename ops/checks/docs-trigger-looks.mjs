// saas-ops docs check: trigger looks, several sounds per alert, video sound and the alert timeline are documented in
// English and es-MX with the labels the app shows, the Triggers and Media Library pages agree with them, and the
// pages render cleanly on phone/desktop in dark and light.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL');
const text = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;|&#x27;|’/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const page = async path => { const response = await fetch(`${base}/${path}`); assert.equal(response.status, 200, path); const html = await response.text(); return { html, text: text(html) }; };
const pages = {
  '': {
    studio: ['Alert timeline', 'Trigger looks', 'Add sound', 'up to 10 sounds', 'Stops at (s)', 'Change sound', 'Play its sound', 'Loop', 'stays on its last frame',
      'Start delay (seconds)', 'Ends at (seconds)', 'Play timeline', 'Design look', 'Edit look', 'Save look', 'Remove look', 'Look settings', 'up to 120 seconds',
      'master volume', 'older trigger overlay link', '$(user)', 'Viewer', 'sample name', 'Trigger to test (here and in OBS)', 'Any trigger'],
    triggers: ['Trigger looks', 'Design look', 'Edit look', 'master volume', '$(user)', 'Viewer', 'an image, a GIF, a sound or a video'],
    library: ['a trigger look'], anchor: '/overlay-studio/#trigger-looks',
    stale: [/you cannot use them as triggers/i, /plain file is audio or video/i, /Choose sound/]
  },
  'es/': {
    studio: ['Línea de tiempo de la alerta', 'Diseños de triggers', 'Agregar sonido', 'hasta 10 sonidos', 'Cambiar sonido', 'Reproducir su sonido', 'Repetir en bucle',
      'Retraso inicial (segundos)', 'Termina en (segundos)', 'Reproducir línea de tiempo', 'Crear diseño', 'Editar diseño', 'Guardar diseño', 'Quitar diseño',
      'Ajustes del diseño', '120 segundos', '$(user)', 'Viewer', 'Trigger para probar (aquí y en OBS)', 'Cualquier trigger'],
    triggers: ['Diseños de triggers', 'Crear diseño', 'Editar diseño', '$(user)', 'Viewer', 'una imagen, un GIF, un sonido o un video'],
    library: ['diseño de trigger'], anchor: '/es/overlay-studio/#dise',
    stale: [/no puedes usarlos como triggers/i, /es audio o video/i]
  }
};
for (const [prefix, expected] of Object.entries(pages)) {
  const studio = await page(`${prefix}overlay-studio/`), triggers = await page(`${prefix}triggers/`), library = await page(`${prefix}media-library/`);
  for (const fact of expected.studio) assert.ok(studio.text.includes(fact), `${prefix}overlay-studio: missing "${fact}"`);
  for (const fact of expected.triggers) assert.ok(triggers.text.includes(fact), `${prefix}triggers: missing "${fact}"`);
  for (const fact of expected.library) assert.ok(library.text.toLowerCase().includes(fact.toLowerCase()), `${prefix}media-library: missing "${fact}"`);
  assert.ok(triggers.html.includes(expected.anchor), `${prefix}triggers links to the look section of Overlay Studio`);
  for (const stale of expected.stale) for (const [name, doc] of [['overlay-studio', studio], ['triggers', triggers]]) assert.ok(!stale.test(doc.text), `${prefix}${name}: stale statement ${stale}`);
  // The linked heading really exists on the Overlay Studio page.
  const id = decodeURIComponent(triggers.html.match(new RegExp(`overlay-studio/#([^"'&]+)`))?.[1] ?? '');
  assert.ok(id && (studio.html.includes(`id="${id}"`) || studio.html.includes(`id="${encodeURIComponent(id)}"`)), `${prefix}overlay-studio has the heading #${id}`);
  // Machine-readable copy carries the new section too.
  const txt = await fetch(`${base}/${prefix}overlay-studio/index.txt`);
  if (txt.status === 200) assert.ok((await txt.text()).includes('$(user)'), `${prefix}overlay-studio/index.txt: look section`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
try {
  for (const prefix of ['', 'es/']) for (const path of ['overlay-studio/', 'triggers/']) for (const width of [320, 1280]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('starlight-theme', theme), theme);
    const tab = await context.newPage();
    tab.on('pageerror', error => errors.push(error.message));
    await tab.route('**/docs-assistant/**', route => route.abort());
    const response = await tab.goto(`${base}/${prefix}${path}`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    await tab.locator('main .sl-markdown-content').waitFor();
    assert.equal(await tab.getAttribute('html', 'data-theme'), theme);
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${prefix}${path} ${width}/${theme}: ${overflow}px page overflow`);
    await context.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(errors, []);
console.log('PASS docs: trigger looks, several sounds, video sound and the alert timeline (EN + es-MX) with app labels, Triggers and Media Library agree, 320/1280 × dark/light without overflow or page errors');
