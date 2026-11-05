import { describe, expect, it } from 'vitest';
import { createWidget, getWidgetModule, widgetModuleFor, widgetPalette } from './overlay-widget-registry';
import { validWidgetModuleConfig } from './overlay-widget-contract.generated';
import { readImport } from './custom-widget-import';
import { blobBytes, crc32, readZip, writeZip } from './custom-widget-zip';

const fields = JSON.stringify({ widgetName: { type: 'hidden', value: 'Fixture chat' }, color: { type: 'colorpicker', label: 'Color', value: '#ffffff', group: 'Look' },
  test: { type: 'button', label: 'Test', group: 'Test' }, size: { type: 'slider', min: 0, max: 9, value: 4 } });
const data = JSON.stringify({ color: '#fefefe', size: 12, extra: 'kept' });
const css = '.row { color: {color}; background: url("https://cdn.streamelements.com/uploads/x.png"); }';
const files = [
  { name: 'widget.ini', text: '[HTML]\npath = "html.txt"\n\n[CSS]\npath = "css.txt"\n\n[JS]\npath = "js.txt"\n\n[FIELDS]\npath = "fields.txt"\n\n[DATA]\npath = "data.txt"\n' },
  { name: 'html.txt', text: '<div class="chat"></div>' }, { name: 'css.txt', text: css }, { name: 'js.txt', text: 'window.addEventListener("onWidgetLoad", () => {});' },
  { name: 'fields.txt', text: fields }, { name: 'data.txt', text: data }
];
const picked = (name: string, text: string) => ({ path: name, blob: new Blob([text]) });

describe('custom widget layers', () => {
  it('is a scene-only code widget that stays out of the generic palette', () => {
    const module = getWidgetModule('custom')!;
    expect(module.definition.delivery).toBe('code');
    expect(module.renderer && module.settings && module.sections).toBeTruthy();
    expect(widgetPalette('scene')).not.toContain('custom');
    expect(createWidget('custom', { id: 'custom-1', placement: 'design' })).toBeNull();
    const layer = { ...createWidget('custom', { id: 'custom-1', placement: 'scene' })!, config: { widgetId: 'a'.repeat(24), values: { color: '#000000' } } };
    expect(widgetModuleFor(layer, 'scene')).toBe(module);
    expect(validWidgetModuleConfig({ ...layer, config: { ...layer.config, revision: 3 } }, 'scene')).toBe(true);
    for (const config of [{ widgetId: 'x', values: [] }, { widgetId: 'x', other: 1 }, { widgetId: 'x', values: { big: 'x'.repeat(64_001) } }, { widgetId: 'x', revision: 0 }]) {
      expect(validWidgetModuleConfig({ ...layer, config }, 'scene')).toBe(false);
    }
  });
});

describe('custom widget zip and import', () => {
  it('round-trips stored zips and reads deflated entries', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const entries = await readZip(await blobBytes(writeZip(files)));
    expect(entries.map(entry => entry.name)).toEqual(files.map(file => file.name));
    expect(new TextDecoder().decode(entries[2].data)).toBe(css);
    const deflated = new Uint8Array(await new Response(new Response(css).body!.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const zip = new Uint8Array(await blobBytes(writeZip([{ name: 'css.txt', text: css }])));
    // Rebuild the single entry as method 8 (deflate) to cover the inflate path.
    const name = new TextEncoder().encode('css.txt'), out = new Uint8Array(30 + name.length + deflated.length + 46 + name.length + 22), view = new DataView(out.buffer);
    out.set(zip.subarray(0, 30 + name.length)); view.setUint16(8, 8, true); view.setUint32(18, deflated.length, true); out.set(deflated, 30 + name.length);
    const central = 30 + name.length + deflated.length;
    out.set(zip.subarray(30 + name.length + css.length, 30 + name.length + css.length + 46 + name.length), central);
    view.setUint16(central + 10, 8, true); view.setUint32(central + 20, deflated.length, true);
    const end = central + 46 + name.length;
    out.set(zip.subarray(zip.length - 22), end); view.setUint32(end + 16, central, true);
    const [entry] = await readZip(out.buffer);
    expect(new TextDecoder().decode(entry.data)).toBe(css);
  });

  it('reads a zip package with its widget.ini, settings summary and remote files', async () => {
    const draft = await readImport([{ path: 'Fixture Chat.zip', blob: writeZip(files.map(file => ({ ...file, name: 'pack/' + file.name }))) }]);
    expect(draft.error).toBe('');
    expect(draft.parts.map(part => part.name)).toEqual(['html.txt', 'css.txt', 'js.txt', 'fields.txt', 'data.txt']);
    expect(draft.suggestedName).toBe('Fixture chat');
    expect(draft.summary).toMatchObject({ settings: 3, groups: 3 });
    expect(draft.summary!.streamElements.length).toBe(1);
    expect(draft.source!.css).toBe(css);
  });

  it('matches loose files, leaves missing parts empty and explains blocking problems', async () => {
    const loose = await readImport([picked('index.html', '<p></p>'), picked('style.css', 'p{}'), picked('fields.json', fields)]);
    expect(loose.error).toBe('');
    expect(loose.parts.filter(part => !part.name).map(part => part.file)).toEqual(['js', 'data']);
    expect(loose.source!.data).toBe('');
    expect((await readImport([picked('fields.txt', fields), picked('data.txt', data)])).error).toBe('noCode');
    expect((await readImport([picked('notes.md', '# hi')])).error).toBe('noFiles');
    expect((await readImport([picked('broken.zip', 'not a zip')])).error).toBe('zip');
    const bad = await readImport([picked('html.txt', '<p></p>'), picked('fields.txt', '{oops')]);
    expect(bad.error).toBe('format');
    expect(bad.errorDetail).toContain('fields');
  });
});
