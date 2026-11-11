import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearDocsCache } from '../../utils/ai/docs_assistant/docs_source.js';
import { paginate, readDocs, readParsedDocs, READ_PAGE_TOKENS, topicText, type DocsReadSuccess } from './read.js';
import { parseDocsExport } from './sections.js';
import { clearParsedDocsCache } from './source.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const en = parseDocsExport('en', fixture('llms-full.en.txt'));
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    clearDocsCache();
    clearParsedDocsCache();
});

const ok = (result: ReturnType<typeof readParsedDocs>) => {
    assert.ok(!('error' in result), JSON.stringify(result));
    return result as DocsReadSuccess;
};

test('reads one section with its url and subsections', () => {
    const result = ok(readParsedDocs(en, { id: '/tts#choose-a-voice-engine' }));
    assert.equal(result.scope, 'section');
    assert.equal(result.title, 'Text to Speech');
    assert.equal(result.section, 'Choose a voice engine');
    assert.equal(result.url, 'https://docs.domdimabot.com/tts/#choose-a-voice-engine');
    assert.equal(result.text, en.sectionById.get('/tts#choose-a-voice-engine')!.text);
    assert.deepEqual(result.subsections, ['/tts#piper', '/tts#kokoro', '/tts#fish-audio', '/tts#find-and-save-fish-voices', '/tts#use-a-fish-voice-in-a-command']);
    assert.deepEqual([result.page, result.pages, result.nextPage], [1, 1, undefined]);
});

test('a subsection id returns just that subsection and its parent', () => {
    const result = ok(readParsedDocs(en, { id: 'https://docs.domdimabot.com/tts/#kokoro' }));
    assert.equal(result.id, '/tts#kokoro');
    assert.equal(result.parent, '/tts#choose-a-voice-engine');
    assert.match(result.text, /^### Kokoro\n/);
    assert.doesNotMatch(result.text, /### Fish Audio/);
    assert.equal(result.url, 'https://docs.domdimabot.com/tts/#kokoro');
});

test('topic = the whole page with its section list; a bare path defaults to topic', () => {
    const result = ok(readParsedDocs(en, { id: '/plans' }));
    assert.equal(result.scope, 'topic');
    assert.equal(result.url, 'https://docs.domdimabot.com/plans/');
    assert.deepEqual(result.sections!.map((s) => s.id), ['/plans#_top', '/plans#monthly-plans', '/plans#limits', '/plans#module-access']);
    assert.match(result.text, /^Compare the Free, Premium, and Pro plans/);
    assert.match(result.text, /\n## Limits\n/);
    const fromSection = ok(readParsedDocs(en, { id: '/plans#limits', scope: 'topic' }));
    assert.equal(fromSection.text, result.text);
});

test('long text is paged at about 12k tokens with nextPage', () => {
    const paragraph = 'Every command can use functions to change the reply based on who typed it and what they wrote. '.repeat(20);
    const body = Array.from({ length: 30 }, (_, i) => `## Part ${i + 1}\n\n${paragraph}\n\n${paragraph}`).join('\n\n');
    const big = parseDocsExport('en', `# Big\n\nA large page.\n\nSource: https://docs.domdimabot.com/big/\nLanguage: en\n\n${body}\n`);
    const first = ok(readParsedDocs(big, { id: '/big' }));
    assert.ok(first.pages >= 3, `${first.pages} pages`);
    assert.equal(first.nextPage, 2);
    assert.ok(first.tokens <= READ_PAGE_TOKENS);
    let joined = first.text;
    for (let page = 2; page <= first.pages; page++) {
        const next = ok(readParsedDocs(big, { id: '/big', page }));
        assert.ok(next.tokens <= READ_PAGE_TOKENS);
        assert.match(next.text, /^## Part \d+/, 'pages start at a section boundary');
        assert.equal(next.nextPage, page < first.pages ? page + 1 : undefined);
        joined += `\n\n${next.text}`;
    }
    assert.equal(joined.replace(/\s+/g, ' '), topicText(big.pageById.get('/big')!).replace(/\s+/g, ' '), 'pages add up to the whole page');
    assert.equal((joined.match(/## Part /g) ?? []).length, 30);
    assert.deepEqual(readParsedDocs(big, { id: '/big', page: first.pages + 1 }), { error: 'page_out_of_range', message: `This result has ${first.pages} pages.` });
    // Splits fall back to blank lines, then line breaks, then a hard cut.
    for (const page of paginate('word '.repeat(30_000), 10_000)) assert.ok(page.length <= 10_000);
});

test('with a byte cap, every page fits it once JSON-encoded', () => {
    const paragraph = 'Línea con acentos y "comillas" para medir bytes reales en JSON. '.repeat(30);
    const body = Array.from({ length: 20 }, (_, i) => `## Parte ${i + 1}\n\n${paragraph}\n\n${paragraph}`).join('\n\n');
    const big = parseDocsExport('es', `# Grande\n\nPágina grande.\n\nSource: https://docs.domdimabot.com/es/grande/\nLanguage: es\n\n${body}\n`);
    const first = ok(readParsedDocs(big, { id: '/es/grande', maxBytes: 16_000 }));
    assert.ok(first.pages > ok(readParsedDocs(big, { id: '/es/grande' })).pages, 'smaller pages than the 12k-token default');
    for (let page = 1; page <= first.pages; page++) {
        const result = readParsedDocs(big, { id: '/es/grande', page, maxBytes: 16_000 });
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_000, `page ${page}`);
    }
    const section = ok(readParsedDocs(big, { id: '/es/grande#parte-3', maxBytes: 2_000 }));
    assert.ok(section.pages > 1 && Buffer.byteLength(JSON.stringify(section)) <= 2_000);
});

test('unknown ids explain and list close ids', () => {
    const wrongAnchor = readParsedDocs(en, { id: '/tts#voices' });
    assert.ok('error' in wrongAnchor && wrongAnchor.error === 'not_found');
    assert.ok(wrongAnchor.closest!.includes('/tts#choose-a-voice-engine'), 'the page\'s own sections');
    const wrongPage = readParsedDocs(en, { id: '/tss#piper' });
    assert.ok('error' in wrongPage);
    assert.ok(wrongPage.closest!.slice(0, 3).some((id) => id.startsWith('/tts')), JSON.stringify(wrongPage.closest));
    const noPage = readParsedDocs(en, { id: '/nothing-here', scope: 'topic' });
    assert.ok('error' in noPage && /No docs page/.test(noPage.message));
});

test('readDocs: the id prefix picks the language; lang rescues a Spanish anchor on an English path', async () => {
    const files: Record<string, string> = { '/llms-full.txt': fixture('llms-full.en.txt'), '/es/llms-full.txt': fixture('llms-full.es.txt') };
    globalThis.fetch = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path in files ? new Response(files[path]) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    const spanish = await readDocs({ id: '/es/tts#créditos-de-ia-y-respaldos', lang: 'en' });
    assert.ok(!('error' in spanish));
    assert.equal(spanish.lang, 'es');
    assert.equal(spanish.url, 'https://docs.domdimabot.com/es/tts/#créditos-de-ia-y-respaldos');
    const mixed = await readDocs({ id: '/tts#elegir-un-motor-de-voz', lang: 'es' });
    assert.ok(!('error' in mixed));
    assert.equal(mixed.id, '/es/tts#elegir-un-motor-de-voz');
    const english = await readDocs({ id: '/tts#piper', lang: 'es' });
    assert.ok(!('error' in english) && english.lang === 'en', 'an id that exists keeps its language');
    const missing = await readDocs({ id: '/tts#nope', lang: 'es' });
    assert.ok('error' in missing && missing.closest!.every((id) => id.startsWith('/tts')), 'the error is about the id that was asked for');
});
