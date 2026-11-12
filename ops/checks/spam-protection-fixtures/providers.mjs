// Strict isolated provider boundary: existing boot/Twitch mocks plus ad review fixtures.
import './base-providers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = globalThis.fetch;
const replays = JSON.parse(fs.readFileSync('/tmp/saas-fixtures/classifier-replay.json', 'utf8')).cases;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'openrouter.ai' || url.pathname !== '/api/alpha/decisions') return base(input, options);
    const request = JSON.parse(options.body);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('HTTP-Referer'), 'https://domdimabot.com');
    assert.equal(headers.get('X-OpenRouter-Title'), 'DomDimaBot');
    assert.ok(typeof request.user === 'string' && request.user);
    if (!request.questions.unsafe) return base(input, options);
    assert.ok(['openai/gpt-6-luna-decisions', 'respan/span-01-lite'].includes(request.model));
    assert.equal(request.state.output.role, 'assistant');
    const state = { targetMessage: { text: request.state.output.content }, precedingMessages: request.state.input.map(message => JSON.parse(message.content)) };
    const text = state.targetMessage.text;
    // Which broadcaster the worker named in the self-promotion question, and that no other question got it.
    const named = question => question?.instructions.match(/The broadcaster of this chat is "([a-z0-9_]*)"\.$/)?.[1] ?? null;
    assert.ok(Object.entries(request.questions).every(([key, question]) => key === 'self_promotion' || named(question) === null));
    fs.appendFileSync('/tmp/saas-fixtures/calls.jsonl', JSON.stringify({ spamReview: text, state, model: request.model, user: request.user, broadcaster: named(request.questions.self_promotion), at: Date.now() }) + '\n');
    if (text.includes('TIMEOUT')) await new Promise(resolve => setTimeout(resolve, 4500));
    if (text.includes('SLOW')) await new Promise(resolve => setTimeout(resolve, 700));
    if (text.includes('UNAVAILABLE')) return new Response('{}', { status: 503 });
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    const replay = request.model === 'openai/gpt-6-luna-decisions' && replays.find(item => item.messageText === text
        && JSON.stringify(item.context.map(message => message.message)) === JSON.stringify(state.precedingMessages.map(message => message.message)));
    if (replay) {
        const answers = Object.fromEntries(Object.keys(request.questions).map(category => [category, {
            type: 'noul', noul: category === 'unsafe' ? 1 - replay.scores.safe : replay.scores[category]
        }]));
        return json({ model: replay.model, provider: 'OpenAI', id: `replay-${replay.label}`, answers,
            usage: { cost: replay.cost, input_tokens: replay.inputTokens } });
    }
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
        if (text.includes('CONTRADICT')) score = 0.99;
        return [key, { type: 'noul', noul: score }];
    }));
    const highest = Math.max(...Object.values(answers).map(answer => answer.noul));
    const safe = text.includes('CONTRADICT') ? 0.96 : text.includes('SAFE-WINS') ? 0.99 : text.includes('TIED') ? 0.95 : text.includes('UNCERTAIN') ? 0.5 : highest > 0.1 ? 0.01 : 0.995;
    answers.unsafe = { type: 'noul', noul: 1 - safe };
    // Luna runs on our own OpenAI key: OpenRouter reports 0 and lists the provider charge apart.
    const usage = request.model === 'openai/gpt-6-luna-decisions' ? { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.000155 }, input_tokens: 500 }
        : { cost: request.model === 'respan/span-01-lite' ? 0 : 0.000021, input_tokens: 500 };
    return json({ model: request.model, provider: request.model.startsWith('openai/') ? 'OpenAI' : 'Respan', id: 'synthetic-spam', answers, usage });
};
