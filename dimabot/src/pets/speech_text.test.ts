import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExpressiveTtsTags } from '../utils/tts/expressive_tts_tags.util.js';
import { filterPetTalkText, refilterDesktopPetText } from './speech_text.js';
import { resolveTtsForCreditStatus } from '../utils/tts/tts_credit_fallback.util.js';

const filters = { skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 30,
    expressiveTags: normalizeExpressiveTtsTags({ happy: true, sad: false }) };
test('pet talk applies emote, link, whitespace, length and tag filters in order', () => {
    assert.equal(filterPetTalkText(' Kappa  [happy] Hi example.com [sad]  there ', 'fish', filters, ['Kappa']).text, '[happy] Hi [link] there');
    assert.equal(filterPetTalkText('Kappa example.com [happy]', 'piper', filters, ['Kappa']).text, '[link]');
    assert.equal(filterPetTalkText('abcdefghijklmnopqrstuvwxyz 123456789', 'piper', filters, []).text, 'abcdefghijklmnopqrstuvwxyz 123');
});
test('filter toggles preserve emotes, links and whitespace and reject empty speech', () => {
    const disabled = { ...filters, skipEmotes: false, stripLinks: false, normalizeWhitespace: false, maxLength: 500 };
    assert.equal(filterPetTalkText('Kappa\nexample.com', 'piper', disabled, ['Kappa']).text, 'Kappa\nexample.com');
    assert.equal(filterPetTalkText('Kappa [sad]', 'fish', filters, ['Kappa']).error, true);
});
test('credit fallback uses its effective provider before replacing links', () => {
    const raw = '[happy] visit example.com';
    const resolved = resolveTtsForCreditStatus({ mode: 'speak', provider: 'fish', text: raw, language: 'en', voice: 'test' }, 'unavailable');
    assert.equal(resolved.provider, 'piper');
    assert.equal(filterPetTalkText(raw, resolved.provider, filters, []).text, 'visit [link]');
});


test('desktop Pet preserves enabled Fish tags and changes them only when effective provider falls back', () => {
    const raw = '[happy] visit example.com';
    const fish = resolveTtsForCreditStatus({ mode: 'speak', provider: 'fish', text: raw, language: 'en', voice: 'test' }, 'available');
    const initial = filterPetTalkText(fish.text, fish.provider, filters, []).text;
    assert.equal(initial, '[happy] visit [link]');
    assert.equal(refilterDesktopPetText(initial, 'fish', filters, []).text, initial);
    assert.equal(refilterDesktopPetText(initial, 'piper', filters, []).text, 'visit [link]');
});
test('pet talk skips emotes from other channels that the chat message tagged', () => {
    const catalog = ['Kappa', 'moonpla2Yay'];
    const tagged = ['pookyDerp', 'evilto8PAM'];
    const text = 'dame esas patas pookyDerp evilto8PAM evilto8PAM moonpla2Yay';
    assert.equal(filterPetTalkText(text, 'piper', { ...filters, maxLength: 500 }, catalog).text, 'dame esas patas pookyDerp evilto8PAM evilto8PAM');
    assert.equal(filterPetTalkText(text, 'piper', { ...filters, maxLength: 500 }, [...catalog, ...tagged]).text, 'dame esas patas');
});
