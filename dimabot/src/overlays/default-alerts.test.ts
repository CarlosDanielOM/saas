import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeScene, matchingVariant, selectAlertLayout, type AlertDesign } from './model.js';
import { makeDefaultDesign } from './default-alerts.js';
import { designsWithLibraryUrls, OVERLAY_LIBRARY } from './library.js';
import { isUntouchedStarter, legacyStarterDesign, upgradeDefaultAlerts, type StudioDoc } from './default-alerts-migration.js';
import { buildPublished, liveStatus } from './publish.js';
import { sampleEvent, parseTemplate } from './ast.js';

process.env.SECRET_KEY ??= 'a'.repeat(32);
const { validateState, OverlayError } = await import('./store.js');
const empty = { schemaVersion: 1 as const, revision: 0, scenes: [], designs: [] };
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, (v as Record<string, unknown>)[key]])) : v);
const save = (design: AlertDesign) => validateState(JSON.parse(JSON.stringify({ writer: 2, scenes: [makeScene('main', 'My overlay', design.id)], designs: [design] })), empty).designs[0];
const withoutRevision = ({ revision: _revision, ...design }: AlertDesign) => design;

for (const language of ['en', 'es'] as const) test(`the ${language} default design survives a Studio save unchanged`, () => {
  const design = makeDefaultDesign('starter', 'My alerts', language);
  assert.equal(canonical(withoutRevision(save(design))), canonical(withoutRevision(design)));
  for (const layout of [...Object.values(design.events), ...design.variants!.sub!.map(v => v.layout)]) {
    assert.ok(layout.widgets.length <= 60);
    for (const w of layout.widgets) if (w.kind === 'text') assert.doesNotThrow(() => parseTemplate(w.text ?? ''), w.text);
  }
});

test('library pictures and sounds: OBS gets their URLs, saves keep only the id', () => {
  const design = makeDefaultDesign('starter', 'My alerts', 'en');
  const [served] = designsWithLibraryUrls([design]);
  const badge = served.events.follow.widgets.find(w => w.id === 'badge')!;
  assert.equal(badge.library, 'dima-follow-badge');
  assert.equal(badge.mediaUrl, '/overlay-library/v1/badge-follow.webp');
  assert.equal(served.events.raid.sounds![0].url, '/overlay-library/v1/sound-raid.mp3');
  assert.equal(served.events.raid.sound!.url, '/overlay-library/v1/sound-raid.mp3');
  assert.equal(served.variants!.sub![0].layout.sounds![0].url, '/overlay-library/v1/sound-gift.mp3');
  assert.equal(design.events.follow.widgets.find(w => w.id === 'badge')!.mediaUrl, undefined, 'the stored design is not changed');
  // An editor that sends the served copy back stores the plain ids again.
  assert.equal(canonical(withoutRevision(save(served))), canonical(withoutRevision(design)));
  for (const item of Object.values(OVERLAY_LIBRARY)) assert.match(item.file, /^v1\/[a-z0-9]+-[a-z]+\.(webp|mp3)$/);
});

test('library ids must exist and match the object kind', () => {
  const broken = (edit: (design: AlertDesign) => void) => { const design = makeDefaultDesign('starter', 'My alerts', 'en'); edit(design); return () => save(design); };
  assert.throws(broken(d => { d.events.follow.widgets[0].library = 'dima-follow-nope'; }), OverlayError);
  assert.throws(broken(d => { d.events.follow.widgets[0].library = 'dima-follow-sound'; }), OverlayError);
  assert.throws(broken(d => { d.events.follow.sounds![0].library = 'dima-follow-badge'; }), OverlayError);
  assert.throws(broken(d => { const text = d.events.follow.widgets.find(w => w.kind === 'text')!; text.library = 'dima-follow-badge'; }), OverlayError);
  assert.throws(broken(d => { d.events.follow.sounds![0].library = '__proto__'; }), OverlayError);
  // A link typed in an older editor (which keeps the unknown library id) wins; the library's own URL does not.
  const typed = makeDefaultDesign('starter', 'My alerts', 'en');
  Object.assign(typed.events.follow.widgets.find(w => w.id === 'badge')!, { mediaUrl: 'https://example.com/pic.png' });
  const typedBadge = save(typed).events.follow.widgets.find(w => w.id === 'badge')!;
  assert.deepEqual([typedBadge.mediaUrl, typedBadge.library], ['https://example.com/pic.png', undefined]);
  // A Studio asset picked by an editor that still sends the library id wins.
  const design = makeDefaultDesign('starter', 'My alerts', 'en'), A = 'a'.repeat(24);
  Object.assign(design.events.follow.widgets.find(w => w.id === 'badge')!, { assetId: A });
  Object.assign(design.events.follow.sounds![0], { assetId: A });
  const saved = save(design).events.follow;
  assert.deepEqual([saved.widgets.find(w => w.id === 'badge')!.assetId, saved.widgets.find(w => w.id === 'badge')!.library], [A, undefined]);
  assert.deepEqual([saved.sounds![0].assetId, saved.sounds![0].library], [A, undefined]);
});

test('gifted subs: their own look, tier looks for the rest, old designs unchanged', () => {
  const design = makeDefaultDesign('starter', 'My alerts', 'en');
  const gift = sampleEvent('sub', 'Luna', 5, 'gift'), sub = sampleEvent('sub', 'Luna', 1, '1000');
  assert.equal(matchingVariant(design, 'sub', gift)?.id, 'gifted-subs');
  assert.equal(matchingVariant(design, 'sub', sub), undefined);
  assert.equal(selectAlertLayout(design, 'sub', sub), design.events.sub);
  // A design with a Tier 1 look and no gift look keeps playing the Tier 1 look for gifts, as before.
  const tiers: AlertDesign = { ...design, variants: { sub: [{ id: 't1', name: 'Tier 1', enabled: true, tier: '1000', layout: design.events.follow }] } };
  assert.equal(matchingVariant(tiers, 'sub', gift)?.id, 't1');
  assert.equal(matchingVariant(tiers, 'sub', sub)?.id, 't1');
  // A disabled gift look falls back to the tier looks.
  const off: AlertDesign = { ...design, variants: { sub: [{ ...design.variants!.sub![0], enabled: false }, tiers.variants!.sub![0]] } };
  assert.equal(matchingVariant(off, 'sub', gift)?.id, 't1');
  const bad = (variant: Record<string, unknown>) => () => save({ ...design, variants: { sub: [{ ...design.variants!.sub![0], ...variant } as never] } });
  // An older editor that picks a tier keeps the unknown `gift` field: the tier wins instead of the save failing.
  const tiered = save({ ...design, variants: { sub: [{ ...design.variants!.sub![0], tier: '2000' }] } }).variants!.sub![0];
  assert.deepEqual([tiered.tier, tiered.gift], ['2000', undefined]);
  assert.throws(bad({ gift: false }), OverlayError);
  assert.throws(bad({ gift: undefined }), /subscription tier/);
  assert.throws(bad({ gift: true, tier: 'gift' }), /subscription tier/);
});

test('$(gift.count) prints the subs in one gift', async () => {
  const { renderTemplate } = await import('./ast.js');
  assert.equal(await renderTemplate('$(gift.count)', '1', sampleEvent('sub', 'Luna', 5, 'gift')), '5');
  assert.equal(await renderTemplate('$(gift.count)', '1', sampleEvent('sub', 'Luna', 3, '1000')), '0');
});

test('migration: only untouched starters change, drafts and OBS stay in step', () => {
  assert.ok(isUntouchedStarter(legacyStarterDesign()));
  assert.ok(isUntouchedStarter({ ...legacyStarterDesign(), revision: 9, variants: {} }));
  const edited = legacyStarterDesign(); edited.events.follow.widgets[1].x += 1;
  assert.equal(isUntouchedStarter(edited), false);
  assert.equal(isUntouchedStarter({ ...legacyStarterDesign(), name: 'Mine' }), false);
  const looks = legacyStarterDesign(); looks.variants = { raid: [{ id: 'big', name: 'Big', enabled: true, min: 10, layout: looks.events.raid }] };
  assert.equal(isUntouchedStarter(looks), false);

  const scene = makeScene('main', 'My overlay', 'starter'); scene.publicId = 'p'.repeat(48); scene.revision = 3;
  scene.published = buildPublished(scene, [legacyStarterDesign()], new Map());
  const doc: StudioDoc = { _id: '1', revision: 7, scenes: [scene], designs: [{ ...legacyStarterDesign(), revision: 4 }] };
  const upgrade = upgradeDefaultAlerts(doc, 'es')!;
  assert.deepEqual([upgrade.draft, upgrade.published], [['starter'], ['main']]);
  assert.equal(upgrade.designs[0].revision, 5);
  assert.equal(upgrade.designs[0].events.follow.widgets.find(w => w.id === 'kicker')!.text, 'Nuevo seguidor');
  assert.equal(upgrade.scenes[0].revision, 4);
  assert.deepEqual(liveStatus(upgrade.scenes, upgrade.designs, new Map()), { main: true });
  // Whatever was customised is never replaced; a draft someone changed keeps its published copy too.
  assert.equal(upgradeDefaultAlerts({ ...doc, designs: [edited] }, 'en'), null);
  const pending = upgradeDefaultAlerts({ ...doc, scenes: [{ ...scene, published: buildPublished(scene, [edited], new Map()) }] }, 'en')!;
  assert.deepEqual(pending.published, []);
  assert.equal(pending.scenes[0].revision, 3);
});
