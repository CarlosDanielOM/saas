// Strict isolated provider boundary: existing boot/Twitch mocks plus ad review fixtures.
import './base-providers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'openrouter.ai' || url.pathname !== '/api/alpha/decisions') return base(input, options);
    const request = JSON.parse(options.body);
    if (!request.questions.violation.criteria.true.includes('clear unsolicited advertisement')) return base(input, options);
    assert.equal(request.model, 'respan/span-01-lite');
    const state = JSON.parse(request.state);
    const text = state.targetMessage.text;
    fs.appendFileSync('/tmp/saas-fixtures/calls.jsonl', JSON.stringify({ spamReview: text, state, model: request.model, at: Date.now() }) + '\n');
    if (text.includes('TIMEOUT')) await new Promise(resolve => setTimeout(resolve, 4500));
    if (text.includes('SLOW')) await new Promise(resolve => setTimeout(resolve, 700));
    if (text.includes('UNAVAILABLE')) return new Response('{}', { status: 503 });
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (text.includes('INVALID')) return json({ answers: { violation: { type: 'noul', noul: 'yes' } } });
    const invited = state.precedingMessages.some(message => message.isBroadcaster && message.message.includes('share your channel'));
    const advertising = (/buy.*viewers/.test(text) || /Follow my channel/.test(text) && !invited) && !/Someone posted|Do not buy/.test(text);
    const score = text.includes('UNCERTAIN') ? 0.5 : text.includes('BORDERLINE') ? 0.89 : advertising ? 0.995 : 0.01;
    return json({ model: request.model, provider: 'Respan', id: 'synthetic-spam',
        answers: { violation: { type: 'noul', noul: score } }, usage: { cost: 0, input_tokens: 500 } });
};
