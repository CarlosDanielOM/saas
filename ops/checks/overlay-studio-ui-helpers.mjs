// Shared helpers for browser checks of the full-screen Overlay Studio (not a check itself).
// The studio keeps some parts behind a tab, drawer or menu: the Test drawer, the Overlay tab,
// the overlay switcher, the OBS link panel and the studio menu (theme/language). Phones show one
// panel per bottom tab. These helpers open the requested part on either layout.
// Checks import this file by absolute path because saas-ops verify runs checks from a copy.

const visible = (page, selector) => page.locator(selector).first().isVisible().catch(() => false);
const isPhone = page => visible(page, '.studio-mtabs');
const phoneTab = (page, tab) => page.locator(`.studio-mtabs [data-tab="${tab}"]`).click();

/** Closes an open studio popover (switcher, OBS panel, menu) so the next click reaches the page. */
export async function closeStudioMenus(page) {
  if (await page.locator('app-overlay-editor .pop:not([hidden]):not(.lf-setup[hidden])').count()) await page.keyboard.press('Escape');
  await page.locator('app-overlay-editor .pop-backdrop').waitFor({ state: 'detached' }).catch(() => {});
}

/**
 * Makes a studio part visible: 'test' (Try it drawer/tab), 'overlay' (overlay or design settings),
 * 'layer' (selected layer settings), 'layers', 'add', 'designs', 'timeline', 'obs' (OBS link panel)
 * or 'scenes' (overlay switcher).
 */
export async function openStudio(page, part) {
  const phone = await isPhone(page);
  if (part !== 'obs' && part !== 'scenes') await closeStudioMenus(page);
  switch (part) {
    case 'test':
      if (!(await visible(page, '.tester'))) { if (phone) await phoneTab(page, 'test'); else await page.locator('.tb--test').click(); }
      return page.locator('.tester').waitFor();
    case 'overlay':
      if (!(await visible(page, '.studio-overlay'))) { if (phone) await phoneTab(page, 'more'); else await page.locator('.studio-rtab[data-tab="overlay"]').click(); }
      return page.locator('.studio-overlay').waitFor();
    case 'layer':
      if (!(await visible(page, '.studio-pane.properties'))) { if (phone) await phoneTab(page, 'edit'); else await page.locator('.studio-rtab[data-tab="layer"]').click(); }
      return page.locator('.studio-pane.properties').waitFor();
    case 'layers':
      if (phone && !(await visible(page, '.layers'))) await phoneTab(page, 'layers');
      return page.locator('.layers').waitFor();
    case 'add':
      if (phone) { if (!(await visible(page, '.palette-item'))) await phoneTab(page, 'add'); }
      else if (!(await visible(page, '.palette-item'))) await page.locator('.studio-add .studio-pane__toggle').click();
      return page.locator('.palette-item').first().waitFor();
    case 'designs':
      if (phone && !(await visible(page, '.designs'))) await phoneTab(page, 'layers');
      return page.locator('.designs').waitFor();
    case 'timeline':
      if (phone && !(await visible(page, '.studio__timeline'))) await phoneTab(page, 'edit');
      return page.locator('.studio__timeline').waitFor();
    case 'obs':
      if (!(await visible(page, '.lf-setup'))) await page.locator('.studio-status').click();
      return page.locator('.lf-setup').waitFor();
    case 'scenes':
      if (!(await visible(page, '.scene-tabs'))) await page.locator('.scene-switch').click();
      return page.locator('.scene-tabs').waitFor();
    default: throw new Error('Unknown studio part: ' + part);
  }
}

/** Switches to an overlay by its id through the overlay switcher. */
export async function switchStudioScene(page, id) {
  await openStudio(page, 'scenes');
  await page.locator(`.scene-tab[data-id="${id}"]`).click();
  await page.locator('.scene-tabs').waitFor({ state: 'detached' });
}

/** The id of the overlay being edited (scene mode only). */
export const studioSceneId = page => page.locator('.name-field input').getAttribute('data-scene-id');

/** Toggles 'lang' or 'theme' from the studio menu (the site navbar is hidden while the studio is open). */
export async function studioToggle(page, which) {
  await closeStudioMenus(page);
  await page.locator('.studio-menu-btn').click();
  await page.locator(which === 'lang' ? '.studio-language' : '.studio-theme').click();
  await closeStudioMenus(page);
}
