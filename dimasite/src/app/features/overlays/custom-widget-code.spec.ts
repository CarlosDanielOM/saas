import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPackage } from './custom-widget-format.generated';
import { CODE_FILES, clearCodeDraft, readCodeDraft, toPackage, writeCodeDraft, type CodeFiles } from './custom-widget-code-drafts';
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
  it('keeps unsaved work per channel and widget, ignoring broken entries', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } });
    const files = starterFiles('dima', 'x', texts);
    expect(writeCodeDraft('1', 'new', { files, base: 0, at: 5, name: 'Mine' })).toBe(true);
    expect(readCodeDraft('1', 'new')).toEqual({ files, base: 0, at: 5, name: 'Mine' });
    expect(readCodeDraft('2', 'new')).toBeNull();
    items.set('dimasite.cw-code.v1.1.w', JSON.stringify({ files: { html: 1 }, base: 1, at: 1 }));
    expect(readCodeDraft('1', 'w')).toBeNull();
    clearCodeDraft('1', 'new');
    expect(readCodeDraft('1', 'new')).toBeNull();
    expect(Object.keys(toPackage(files)).sort()).toEqual([...CODE_FILES].sort());
    expect('manifest' in toPackage({ ...files, manifest: '  ' })).toBe(false);
  });
  it('reports when the browser refuses to store', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} });
    expect(writeCodeDraft('1', 'new', { files: starterFiles('dima', 'x', texts), base: 0, at: 1 })).toBe(false);
  });
});
