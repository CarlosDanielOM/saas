// Strict isolated provider boundary: existing boot/Twitch mocks plus ad review fixtures.
import './base-providers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'openrouter.ai' || url.pathname !== '/api/alpha/decisions') return base(input, options);
    const request = JSON.parse(options.body);
    if (!request.questions.unsafe) return base(input, options);
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
    const scores = {
        spam: /buy.*viewers|Compra viewers en viewerstobuydotcom|SCAM SPAM/.test(text) && !/Someone posted|Do not buy/.test(text) ? 0.995 : 0.01,
        ads: /buy.*viewers|Compra viewers en viewerstobuydotcom|Buy my service/.test(text) && !/Someone posted|Do not buy/.test(text) ? 0.995 : 0.01,
        self_promotion: /Follow my channel/.test(text) && !invited ? 0.995 : 0.01,
        profanity: /damn|fuck/i.test(text) ? 0.995 : 0.01,
        insults: /You are a worthless idiot/.test(text) ? 0.995 : 0.01
    };
    const answers = Object.fromEntries(Object.keys(request.questions).filter(key => key !== 'unsafe').map(key => {
        let score = scores[key];
        if (text.includes('UNCERTAIN')) score = 0.5;
        if (text.includes('BORDERLINE')) score = 0.83;
        if (text.includes('DEFAULT85')) score = 0.87;
        if (text.includes('SAFE-WINS') || text.includes('TIED')) score = 0.95;
        return [key, { type: 'noul', noul: score }];
    }));
    const highest = Math.max(...Object.values(answers).map(answer => answer.noul));
    const safe = text.includes('SAFE-WINS') ? 0.99 : text.includes('TIED') ? 0.95 : text.includes('UNCERTAIN') ? 0.5 : highest > 0.1 ? 0.01 : 0.995;
    answers.unsafe = { type: 'noul', noul: 1 - safe };
    return json({ model: request.model, provider: 'Respan', id: 'synthetic-spam', answers,
        usage: { cost: 0, input_tokens: 500 } });
};
