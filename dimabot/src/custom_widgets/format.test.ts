import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildWidgetIni, checkOverrides, externalMedia, fieldValue, groupFields, isStreamElementsHost, matchPackageFiles, parseData, parseFields,
  parseWidgetIni, PackageFormatError, placeholderKeys, readPackage, resolveFieldData, type PackageSource, type WidgetField } from './format.js';

const fixture = new URL('../../../ops/checks/custom-widget-fixtures/sample-chat/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixture), 'utf8');
const sample: PackageSource = { html: read('html.txt'), css: read('css.txt'), js: read('js.txt'), fields: read('fields.txt'), data: read('data.txt') };

test('widget.ini maps parts, and exported names round-trip', () => {
  assert.deepEqual(parseWidgetIni(read('widget.ini')), { html: 'html.txt', css: 'css.txt', js: 'js.txt', fields: 'fields.txt', data: 'data.txt' });
  assert.deepEqual(parseWidgetIni(buildWidgetIni()), parseWidgetIni(read('widget.ini')));
  assert.deepEqual(matchPackageFiles(['pack/HTML.txt', 'pack/css.txt', 'pack/js.txt', 'pack/fields.txt', 'pack/data.txt', 'pack/widget.ini']),
    { html: 'pack/HTML.txt', css: 'pack/css.txt', js: 'pack/js.txt', fields: 'pack/fields.txt', data: 'pack/data.txt' });
  assert.deepEqual(matchPackageFiles(['index.html', 'style.css', 'widget.js', 'fields.json', 'data.json']),
    { html: 'index.html', css: 'style.css', js: 'widget.js', fields: 'fields.json', data: 'data.json' });
  assert.equal(matchPackageFiles(['a.js', 'b.js']).js, undefined, 'ambiguous names are left for the user');
  assert.equal(matchPackageFiles(['main.txt', 'x.js'], { js: 'main.txt' }).js, 'main.txt', 'widget.ini wins');
});

test('fields keep file order, groups, types and reserved names', () => {
  const { fields, issues } = parseFields(sample.fields);
  assert.deepEqual(issues, []);
  assert.equal(fields[0].key, 'widgetName');
  const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
  assert.equal(byKey.testMessage.type, 'button'); assert.equal(byKey.testMessage.value, 'test');
  assert.deepEqual(byKey.nameWeight.options, [{ value: '400', label: 'Regular' }, { value: '700', label: 'Bold' }]);
  assert.equal(byKey.backgroundOpacity.max, 9);
  assert.deepEqual(groupFields(fields).map(g => [g.name, g.fields.length]), [['Test', 1], ['Messages', 5], ['Colors', 5], [null, 4], ['Alerts', 3]]);
  assert(!groupFields(fields).some(g => g.fields.some(f => f.type === 'hidden')), 'hidden fields are not shown');
  const pkg = readPackage(sample);
  assert.equal(pkg.name, 'Sample chat'); assert.equal(pkg.author, 'DomDimaBot');
});

test('HTML5 and unknown types map like StreamElements; bad entries become issues', () => {
  const { fields, issues } = parseFields(JSON.stringify({
    when: { type: 'date' }, range: { type: 'range', min: 0, max: 5 }, shade: { type: 'color', value: '#123' }, odd: { type: 'fontpicker' },
    empty: { type: 'dropdown', options: {} }, 'bad key': { type: 'text' }, notObject: 5, '__proto__': { type: 'text' }, wrong: { type: 'number', value: 'abc' }
  }));
  const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
  assert.deepEqual([byKey.when.type, byKey.when.inputType], ['text', 'date']);
  assert.equal(byKey.range.type, 'slider'); assert.equal(byKey.shade.type, 'colorpicker');
  assert.deepEqual([byKey.odd.type, byKey.odd.sourceType], ['text', 'fontpicker']);
  assert.deepEqual([byKey.empty.type, byKey.empty.sourceType], ['text', 'dropdown']);
  assert.equal(byKey.wrong.value, undefined);
  assert.deepEqual(issues.map(i => i.code).sort(), ['invalid-field', 'invalid-key', 'invalid-value', 'no-options']);
  assert.throws(() => parseFields('[1,2]'), PackageFormatError);
  assert.throws(() => parseFields('{oops'), /isn't valid JSON/);
  assert.deepEqual(parseFields('').fields, [], 'an empty fields file is allowed');
});

test('saved data is repaired on import and extra keys are kept', () => {
  const { fields } = parseFields(sample.fields);
  const { data, issues } = parseData(sample.data, fields);
  assert.deepEqual(issues, []);
  assert.equal(data.messageLimit, 6, 'numbers saved as text');
  assert.equal(data.backgroundOpacity, 9, 'sliders clamp to their range');
  assert.equal(data.nameWeight, '700', 'dropdown values are option keys');
  assert.equal(data.alertSound, null);
  assert.equal(data.accentGlow, '#ec6b93', 'values without a field stay for the widget code');
  const dropped = parseData(JSON.stringify({ textColor: 'red; }</style>', nameWeight: '900', 'a.b': 1 }), fields);
  assert.deepEqual(dropped.data, {}); assert.deepEqual(dropped.issues.map(i => i.code), ['data-value-dropped', 'data-value-dropped', 'invalid-data-key']);
});

test('resolved values: defaults, then package data, then layer changes', () => {
  const pkg = readPackage(sample);
  const values = resolveFieldData(pkg.fields, pkg.data, { textColor: '#000000' });
  assert.equal(values.textColor, '#000000'); assert.equal(values.nameColor, '#f9a8d4'); assert.equal(values.widgetName, 'Sample chat');
  assert.equal(values.alertImage, 'https://cdn.streamelements.com/uploads/fixture-alert.png');
  assert.equal(values.testMessage, undefined, 'buttons have no saved value');
  assert.equal(values.legacyCount, 6);
});

test('strict layer values reject injection-shaped input and drop removed settings', () => {
  const { fields } = parseFields(sample.fields);
  assert.deepEqual(checkOverrides(fields, { textColor: 'hsl(10, 50%, 50%)', textSize: 22, hideCommands: false, gone: 1, testMessage: 'x' }),
    { values: { textColor: 'hsl(10, 50%, 50%)', textSize: 22, hideCommands: false } });
  for (const bad of [{ textColor: '#fff;} body{display:none' }, { textColor: 'url(javascript:1)' }, { msgFont: "Roboto'); @import url(x" }, { nameWeight: '900' },
    { textSize: '22' }, { hideCommands: 'yes' }, { backgroundOpacity: 10 }, { alertImage: 'javascript:alert(1)' }, { alertImage: 'http://insecure.example/a.png' },
    { alertImage: 'https://user:pass@example.com/a.png' }, { ignoredUsers: 'x'.repeat(20_001) }]) {
    assert('error' in checkOverrides(fields, bad), JSON.stringify(bad).slice(0, 60));
  }
  assert('error' in checkOverrides(fields, []));
  const media: WidgetField = { key: 'pics', type: 'image-input', label: 'Pics', multiple: true };
  assert.deepEqual(fieldValue(media, ['https://a.example/1.png'], 'strict'), { ok: true, value: ['https://a.example/1.png'] });
  assert.deepEqual(fieldValue(media, 'https://a.example/1.png', 'import'), { ok: true, value: ['https://a.example/1.png'] });
  assert.equal(fieldValue(media, 'https://a.example/1.png', 'strict').ok, false);
});

test('placeholders and remote files are found for the import summary', () => {
  assert.deepEqual(placeholderKeys('a {x} b {{ y }} c { } d {z-1}'), ['x', 'y', 'z-1']);
  const pkg = readPackage(sample);
  const media = externalMedia(sample, pkg.data);
  const hosted = media.filter(m => isStreamElementsHost(m.host));
  assert.deepEqual(hosted.map(m => [m.kind, m.in]), [['image', ['css']], ['image', ['data']]]);
  assert(media.some(m => m.kind === 'font' && m.host === 'fonts.googleapis.com'));
});

test('package size limits', () => {
  assert.throws(() => readPackage({ ...sample, js: 'x'.repeat(1_000_001) }), /js file is too large/);
  assert.throws(() => readPackage({ ...sample, html: 'x'.repeat(500_000), css: 'x'.repeat(500_000), js: 'x'.repeat(999_000) }), /too large together/);
});

test('widget.json: engine, api version, uses and StreamElements inference', async () => {
  const { parseManifest, inferManifest } = await import('./format.js');
  const dima = readFileSync(new URL('../dima-chat/widget.json', fixture), 'utf8');
  const parsed = parseManifest(dima);
  assert.deepEqual(parsed.manifest, { engine: 'dima', api: 1, uses: ['chat', 'alerts', 'store', 'counters', 'session'], name: 'Dima sample chat', author: 'DomDimaBot', version: '1.0.0', description: 'Chat bubbles with emotes, a follow/Bits banner and a saved alert counter.' });
  assert.deepEqual(parseManifest('{"uses":["chat","chat","telepathy"]}'), { manifest: { engine: 'dima', api: 1, uses: ['chat'] }, issues: [{ code: 'unknown-use', detail: 'telepathy' }] });
  assert.throws(() => parseManifest('{"api":2}'), /newer widget engine/);
  assert.throws(() => parseManifest('{"engine":"obs"}'), /engine/);
  assert.throws(() => parseManifest('[]'), /JSON object/);
  assert.deepEqual(inferManifest(sample).uses, ['chat', 'alerts']);
  assert.deepEqual(inferManifest({ html: '', js: 'SE_API.store.set("x",1); window.addEventListener("onSessionUpdate", f); SE_API.counters.get("d")' }).uses, ['store', 'counters', 'session']);
  const withManifest = readPackage({ ...sample, manifest: dima });
  assert.equal(withManifest.manifest.engine, 'dima'); assert.equal(withManifest.name, 'Dima sample chat', 'widget.json name wins over widgetName');
  assert.equal(readPackage(sample).manifest.inferred, true);
  assert.throws(() => readPackage({ ...sample, manifest: 'x'.repeat(16_001) }), /widget.json is too large/);
});
