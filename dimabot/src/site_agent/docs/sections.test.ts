import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateTokens, HeadingSlugger, headingPlainText, normalizeDocsId, parseDocsExport, slugify, subsectionText } from './sections.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const en = parseDocsExport('en', fixture('llms-full.en.txt'));
const es = parseDocsExport('es', fixture('llms-full.es.txt'));

/** All h2/h3 ids on the page, in order, as the live docs site renders them (copied from its HTML). */
function pageAnchors(parsed: typeof en, pageId: string): string[] {
    const page = parsed.pageById.get(pageId)!;
    return page.sections.filter((s) => s.level === 2).flatMap((s) => [s.anchor, ...s.subsections.map((sub) => sub.anchor)]);
}

test('splits the export into pages: header line, in-page h1 and metadata are not pages', () => {
    assert.deepEqual(en.pages.map((p) => p.id), ['/', '/commands/advanced/syntax', '/commands/built-in', '/follow-defense', '/plans', '/tts']);
    assert.deepEqual(es.pages.map((p) => p.id), ['/es', '/es/commands/advanced/syntax', '/es/commands/built-in', '/es/follow-defense', '/es/plans', '/es/tts']);
    const tts = en.pageById.get('/tts')!;
    assert.equal(tts.title, 'Text to Speech');
    assert.equal(tts.url, 'https://docs.domdimabot.com/tts/');
    assert.match(tts.description, /^Set up the speech overlay, pick a voice engine/);
    // "# How can we help?" inside the home page stays text of its intro.
    assert.match(en.sectionById.get('/#_top')!.text, /# How can we help\?/);
    for (const section of en.sections) {
        assert.doesNotMatch(section.text, /^(Source|Language|Documentation index): /m, section.id);
        assert.doesNotMatch(section.text, /\n---$/, `${section.id} keeps the page separator`);
    }
});

test('anchors match the live docs site, including Spanish accents and duplicate headings', () => {
    assert.deepEqual(pageAnchors(en, '/tts'), ['set-up-the-speech-overlay', 'choose-a-voice-engine', 'piper', 'kokoro', 'fish-audio', 'find-and-save-fish-voices',
        'use-a-fish-voice-in-a-command', 'chat-command-s', 'ast-functions', 'queue-and-overlay-behavior', 'message-filters-and-limits', 'voice-tags-fish-audio-only',
        'emotions', 'voice-and-delivery', 'vocal-sounds', 'pauses-and-effects', 'channel-admin-access', 'ai-credits-and-fallbacks']);
    assert.deepEqual(pageAnchors(es, '/es/tts'), ['configurar-la-superposición-de-voz', 'elegir-un-motor-de-voz', 'piper', 'kokoro', 'fish-audio', 'buscar-y-guardar-voces-de-fish',
        'usar-una-voz-de-fish-en-un-comando', 'comando-de-chat-s', 'funciones-ast', 'comportamiento-de-la-cola-y-de-la-superposición', 'filtros-y-límites-de-mensajes',
        'etiquetas-de-voz-solo-fish-audio', 'emociones', 'voz-y-expresión', 'sonidos-vocales', 'pausas-y-efectos', 'acceso-de-administradores-del-canal', 'créditos-de-ia-y-respaldos']);
    // An h3 that repeats an earlier h2 gets "-1".
    assert.deepEqual(pageAnchors(en, '/commands/built-in'), ['turn-them-on-or-change-access', 'info', 'fun-and-games', 'text-to-speech', 'stream-and-shoutouts', 'polls-and-predictions',
        'mods-and-vips', 'manage-commands-from-chat', 'details', 'ruletarusa', 'duels', 'polls-and-predictions-1', 'changing-built-in-settings-with-ec']);
    assert.deepEqual(pageAnchors(es, '/es/commands/built-in'), ['activarlos-o-cambiar-el-acceso', 'información', 'diversión-y-juegos', 'texto-a-voz', 'stream-y-shoutouts',
        'encuestas-y-predicciones', 'mods-y-vips', 'gestionar-comandos-desde-el-chat', 'detalles', 'ruleta-rusa', 'duelos', 'encuestas-y-predicciones-1',
        'cambiar-la-configuración-de-un-comando-integrado-con-ec']);
    // Repeated ### headings across sections of one page.
    assert.ok(en.subsectionById.has('/commands/advanced/syntax#examples-1'));
    assert.ok(en.subsectionById.has('/commands/advanced/syntax#rules-1'));
    assert.ok(es.subsectionById.has('/es/commands/advanced/syntax#ejemplos-1'));
    assert.equal(en.subsectionById.get('/commands/advanced/syntax#rules-1')!.section.id, '/commands/advanced/syntax#command-references');
});

test('slug rules follow github-slugger', () => {
    assert.equal(slugify('AST Execution, Errors & Limits'), 'ast-execution-errors--limits');
    assert.equal(slugify(headingPlainText('Chat command: `!s`')), 'chat-command-s');
    assert.equal(slugify(headingPlainText('`&t` must come last')), 't-must-come-last');
    assert.equal(slugify(headingPlainText('See [the plans](https://docs.domdimabot.com/plans/) **now**')), 'see-the-plans-now');
    assert.equal(slugify('Créditos de IA y respaldos'), 'créditos-de-ia-y-respaldos');
    assert.equal(slugify('¿Qué es? Año ½'), 'qué-es-año-');
    assert.equal(slugify('snake_case stays'), 'snake_case-stays');
    const slugger = new HeadingSlugger();
    assert.deepEqual(['Rules', 'Rules', 'Rules-1', 'Rules'].map((text) => slugger.slug(text)), ['rules', 'rules-1', 'rules-1-1', 'rules-2']);
});

test('sections carry hash, token estimate, level and subsection offsets; tables are compacted', () => {
    const section = en.sectionById.get('/tts#choose-a-voice-engine')!;
    assert.equal(section.level, 2);
    assert.equal(section.heading, 'Choose a voice engine');
    assert.equal(section.pageTitle, 'Text to Speech');
    assert.match(section.hash, /^[0-9a-f]{16}$/);
    assert.equal(section.tokens, estimateTokens(section.text));
    assert.equal(section.tokens, Math.ceil(section.text.length / 4));
    for (const sub of section.subsections) assert.ok(section.text.slice(sub.offset).startsWith(`### ${sub.heading}`), sub.id);
    assert.match(subsectionText(section, section.subsections[0]), /^### Piper\n[\s\S]*$/);
    assert.doesNotMatch(subsectionText(section, section.subsections[0]), /### Kokoro/);
    assert.equal(en.sectionById.get('/tts#_top')!.level, 1);
    for (const s of [...en.sections, ...es.sections]) {
        for (const line of s.text.split('\n')) if (line.startsWith('|')) assert.doesNotMatch(line, / {2,}|-{4,}/, s.id);
    }
    // Same text → same hash; parse is deterministic.
    const again = parseDocsExport('en', fixture('llms-full.en.txt'));
    assert.deepEqual(again.sections.map((s) => [s.id, s.hash]), en.sections.map((s) => [s.id, s.hash]));
});

test('headings inside code fences are code', () => {
    const parsed = parseDocsExport('en', `# DomDimaBot — en

# Demo

A demo page.

Source: https://docs.domdimabot.com/demo/
Language: en
Documentation index: https://docs.domdimabot.com/llms.txt

Intro text.

## Real section

\`\`\`bash
# not a page
## not a section
### not a subsection
\`\`\`

## Real section

Second one.

---
`);
    assert.deepEqual(parsed.sections.map((s) => s.id), ['/demo#_top', '/demo#real-section', '/demo#real-section-1']);
    assert.equal(parsed.sections[1].subsections.length, 0);
    assert.match(parsed.sections[1].text, /## not a section/);
    assert.equal(parsed.sections[2].text, 'Second one.');
    assert.equal(parsed.sections[0].text, 'A demo page.\n\nIntro text.');
});

test('normalizes ids typed as URLs or without slashes', () => {
    assert.equal(normalizeDocsId('https://docs.domdimabot.com/tts/#piper'), '/tts#piper');
    assert.equal(normalizeDocsId('tts#piper'), '/tts#piper');
    assert.equal(normalizeDocsId('/tts/'), '/tts');
    assert.equal(normalizeDocsId('https://docs.domdimabot.com/'), '/');
    assert.equal(normalizeDocsId('/es/tts#cr%C3%A9ditos-de-ia-y-respaldos'), '/es/tts#créditos-de-ia-y-respaldos');
    assert.equal(normalizeDocsId('/es/tts/index.txt'), '/es/tts');
});
