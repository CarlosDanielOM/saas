import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPackage } from './custom-widget-format.generated';
import { CODE_FILES, codeDraftKey, dismissCodeDraft, latestCodeDraft, removeCodeDraft, toPackage, writeCodeDraft, type CodeFiles } from './custom-widget-code-drafts';
import { starterFiles, type StarterTexts } from './custom-widget-templates';
import { checkCode, errorLine } from './overlay-custom-widget-code.component';

const texts: StarterTexts = { groupLook: 'Look', groupChat: 'Chat', groupAlerts: 'Alerts', accent: 'Accent', text: 'Text', size: 'Size', max: 'Max', alerts: 'Alerts on',
  follow: '{name} followed!', sub: '{name} subscribed!', gift: '{name} gifted {amount}!', bits: '{name} cheered {amount}!', raid: '{name} raids with {amount}!' };
const issueText = () => 'skipped';

describe('code editor starters', () => {
  it('Dima starter: a widget.json for chat + alerts, settings that parse without issues', () => {
    const files = starterFiles('dima', 'My chat', texts), pkg = readPackage(toPackage(files));
    expect(pkg.issues).toEqual([]);
    expect(pkg.manifest).toMatchObject({ engine: 'dima', api: 1, name: 'My chat', uses: ['chat', 'alerts'] });
    expect(pkg.fields.map(field => field.key)).toEqual(['accentColor', 'textColor', 'fontSize', 'maxMessages', 'showAlerts']);
    expect(files.js).toContain("Dima.on('fields'");
    expect(files.js).toContain('"follow": "{name} followed!"');
  });
  it('StreamElements starter: no widget.json, inferred as a StreamElements widget reading chat + alerts', () => {
    const files = starterFiles('streamelements', 'x', texts), pkg = readPackage(toPackage(files));
    expect(files.manifest).toBe('');
    expect(pkg.issues).toEqual([]);
    expect(pkg.manifest).toMatchObject({ engine: 'streamelements', uses: ['chat', 'alerts'], inferred: true });
    expect(files.css).toContain('{accentColor}');
  });
});

describe('code editor checks', () => {
  const base = (): CodeFiles => starterFiles('dima', 'x', texts);
  it('reports broken JSON as a blocking problem on its tab, with the line', () => {
    const files = { ...base(), fields: '{\n  "a": { "type": "text" },\n  oops\n}' };
    const result = checkCode(files, issueText);
    expect(result.pkg).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ tab: 'fields', blocking: true, line: 3 });
    expect(checkCode({ ...base(), manifest: '{"engine":"other"}' }, issueText).problems[0]).toMatchObject({ tab: 'manifest', blocking: true });
    expect(checkCode({ ...base(), js: 'x'.repeat(1_000_001) }, issueText).problems[0]).toMatchObject({ tab: 'js', blocking: true });
  });
  it('lists skipped values as non-blocking problems on their tab', () => {
    const result = checkCode({ ...base(), data: '{ "bad key!": 1, "maxMessages": "lots" }' }, issueText);
    expect(result.pkg).not.toBeNull();
    expect(result.problems.map(problem => [problem.tab, problem.key, problem.blocking])).toEqual([['data', 'bad key!', false], ['data', 'maxMessages', false]]);
  });
  it('turns JSON error positions into lines', () => {
    expect(errorLine('{\n"a": 1,\n}', 'Unexpected token } in JSON at position 10')).toBe(3);
    expect(errorLine('', 'Expected property name (line 4 column 2)')).toBe(4);
    expect(errorLine('', 'no hint')).toBeNull();
  });
});

describe('code editor drafts', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** A Storage with real key()/length, so drafts can be listed. */
  const storage = () => {
    const items = new Map<string, string>();
    return { items, api: { get length() { return items.size; }, key: (i: number) => [...items.keys()][i] ?? null, getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } } };
  };
  it('each editor session keeps its own draft; opening offers the newest; removing one leaves the others', () => {
    const { items, api } = storage(); vi.stubGlobal('localStorage', api);
    const files = starterFiles('dima', 'x', texts), now = Date.now();
    const tabA = codeDraftKey('1', 'w'.repeat(24), 'aaaa'), tabB = codeDraftKey('1', 'w'.repeat(24), 'bbbb');
    expect(writeCodeDraft(tabA, { files, base: 2, at: now - 1000, name: 'A' })).toBe(true);
    expect(writeCodeDraft(tabB, { files: { ...files, css: 'b' }, base: 2, at: now, name: 'B' })).toBe(true);
    expect(latestCodeDraft('1', 'w'.repeat(24))).toMatchObject({ key: tabB, name: 'B' });
    expect(latestCodeDraft('1', 'w'.repeat(24), tabB)).toMatchObject({ key: tabA, name: 'A' }); // a session skips its own key
    expect(latestCodeDraft('2', 'w'.repeat(24))).toBeNull();
    expect(latestCodeDraft('1', 'new')).toBeNull();
    removeCodeDraft(tabB);
    expect(latestCodeDraft('1', 'w'.repeat(24))?.key).toBe(tabA);
    // Broken and month-old drafts are dropped while looking.
    items.set(codeDraftKey('1', 'w'.repeat(24), 'cccc'), JSON.stringify({ files: { html: 1 }, base: 1, at: now }));
    items.set(codeDraftKey('1', 'w'.repeat(24), 'dddd'), JSON.stringify({ files, base: 1, at: now - 31 * 24 * 3600_000 }));
    expect(latestCodeDraft('1', 'w'.repeat(24))?.key).toBe(tabA);
    expect([...items.keys()].sort()).toEqual([tabA]);
    expect(Object.keys(toPackage(files)).sort()).toEqual([...CODE_FILES].sort());
    expect('manifest' in toPackage({ ...files, manifest: '  ' })).toBe(false);
  });
  it('taking over or discarding another session\'s draft hides that saved state without deleting it; newer work from that tab shows again', () => {
    const { items, api } = storage(); vi.stubGlobal('localStorage', api);
    const files = starterFiles('dima', 'x', texts), key = codeDraftKey('1', 'new', 'aaaa');
    const now = Date.now();
    writeCodeDraft(key, { files, base: 0, at: now - 1000 });
    const found = latestCodeDraft('1', 'new')!;
    dismissCodeDraft(found);
    expect(latestCodeDraft('1', 'new')).toBeNull();
    expect(items.has(key)).toBe(true); // still there for its own tab
    writeCodeDraft(key, { files: { ...files, css: 'newer' }, base: 0, at: now });
    expect(latestCodeDraft('1', 'new')?.files.css).toBe('newer');
  });
  it('reports when the browser refuses to store, and copes without storage', () => {
    vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} });
    expect(writeCodeDraft('k', { files: starterFiles('dima', 'x', texts), base: 0, at: 1 })).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    expect(latestCodeDraft('1', 'new')).toBeNull();
    expect(() => removeCodeDraft('k')).not.toThrow();
  });
});
