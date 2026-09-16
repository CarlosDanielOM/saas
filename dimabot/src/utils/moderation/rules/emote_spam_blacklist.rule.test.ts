import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmoteSpamRule } from './emote_spam.rule.js';
import { compileBlacklistPattern, evaluateBlacklistRule } from './blacklist.rule.js';

test('emote spam: triggers above the max count', () => {
    const result = evaluateEmoteSpamRule({ maxEmoteCount: 10 }, { emoteCount: 11 });
    assert.equal(result.triggered, true);
    assert.equal(result.emoteCount, 11);
});

test('emote spam: does not trigger at or below the max count', () => {
    assert.equal(evaluateEmoteSpamRule({ maxEmoteCount: 10 }, { emoteCount: 10 }).triggered, false);
    assert.equal(evaluateEmoteSpamRule({ maxEmoteCount: 10 }, { emoteCount: 3 }).triggered, false);
    assert.equal(evaluateEmoteSpamRule({ maxEmoteCount: 10 }, { emoteCount: 0 }).triggered, false);
});

test('blacklist: whole-word match is case-insensitive', () => {
    const pattern = compileBlacklistPattern(['badword']);
    const result = evaluateBlacklistRule({ terms: ['badword'] }, { text: 'you said a BADWORD there' }, pattern);
    assert.equal(result.triggered, true);
});

test('blacklist: does not match inside longer words (Scunthorpe problem)', () => {
    const pattern = compileBlacklistPattern(['ass']);
    assert.equal(evaluateBlacklistRule({ terms: ['ass'] }, { text: 'that is a classic move' }, pattern).triggered, false);
    assert.equal(evaluateBlacklistRule({ terms: ['ass'] }, { text: 'you are an ass' }, pattern).triggered, true);
});

test('blacklist: accent folding works both ways', () => {
    const withAccent = compileBlacklistPattern(['café']);
    assert.equal(evaluateBlacklistRule({ terms: ['café'] }, { text: 'meet at the cafe' }, withAccent).triggered, true);

    const withoutAccent = compileBlacklistPattern(['cafe']);
    assert.equal(evaluateBlacklistRule({ terms: ['cafe'] }, { text: 'meet at the CAFÉ' }, withoutAccent).triggered, true);
});

test('blacklist: multi-word phrases match with flexible whitespace', () => {
    const pattern = compileBlacklistPattern(['buy followers now']);
    assert.equal(evaluateBlacklistRule({ terms: ['buy followers now'] }, { text: 'BUY  FOLLOWERS   NOW cheap' }, pattern).triggered, true);
    assert.equal(evaluateBlacklistRule({ terms: ['buy followers now'] }, { text: 'buy followers tomorrow' }, pattern).triggered, false);
});

test('blacklist: empty term list never triggers and compiles to null', () => {
    assert.equal(compileBlacklistPattern([]), null);
    assert.equal(compileBlacklistPattern(undefined), null);
    assert.equal(compileBlacklistPattern(['  ', '']), null);
    assert.equal(evaluateBlacklistRule({ terms: [] }, { text: 'anything' }, null).triggered, false);
});

test('blacklist: regex special characters in terms are escaped', () => {
    const pattern = compileBlacklistPattern(['free.money']);
    assert.equal(evaluateBlacklistRule({ terms: ['free.money'] }, { text: 'get free.money here' }, pattern).triggered, true);
    assert.equal(evaluateBlacklistRule({ terms: ['free.money'] }, { text: 'get freexmoney here' }, pattern).triggered, false);
});

test('blacklist: unicode whole-word boundaries', () => {
    const pattern = compileBlacklistPattern(['ñoño']);
    assert.equal(evaluateBlacklistRule({ terms: ['ñoño'] }, { text: 'di Nono' }, pattern).triggered, true);
    assert.equal(evaluateBlacklistRule({ terms: ['ñoño'] }, { text: 'añonimo' }, pattern).triggered, false);
});
