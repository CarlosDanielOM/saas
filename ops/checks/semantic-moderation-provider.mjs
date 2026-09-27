// Optional live-provider smoke: run inside a verified backend image with its
// OpenRouter credential. Uses synthetic text only; no DB, Twitch or credit writes.
import assert from 'node:assert/strict';
import { evaluateSemanticDecision } from '/app/dist/utils/moderation/semantic.js';
import { parseAdvancedRule, findBlacklistMatches } from '/app/dist/utils/moderation/advanced.js';
const profanity = 'The author of targetMessage uses profanity in a negative or hostile way, rather than as positive praise.';
const nickname = 'The final message uses the nickname Rinn to refer to a person. A message that discusses the nickname or asks others not to use it does not count.';
const anyMention = 'The final message contains any mention of the nickname Rinn, including quoting it, discussing it, or discouraging its use.';
const cases = [
    ['negative', profanity, 'You are a fucking idiot', 'violation'],
    ['positive', profanity, 'That was fucking awesome, pretty good headshot', 'allow'],
    ['nickname-use', nickname, 'Yeah, Rinn is losing the game', 'violation'],
    ['nickname-discourage', nickname, "Don't call her Rinn", 'allow'],
    ['nickname-any', anyMention, "Don't call her Rinn", 'violation'],
    ['context', profanity, 'That was fucking awesome, pretty good headshot', 'allow', [{ username: 'other', message: 'You are a fucking idiot', messageID: 'prior', timestamp: 1 }]],
    ['examples', profanity, 'That was fucking awesome, pretty good headshot', 'allow', [], [{ message: 'That was fucking awesome', label: 'allow' }, { message: 'You are a fucking idiot', label: 'violation' }]]
];
for (const [label, policy, messageText, expected, context = [], examples = []] of cases) {
    const patterns = parseAdvancedRule({ type: 'blacklist', patterns: [{ id: 'candidate', source: policy.includes('Rinn') ? 'r+i+(?:n+i+)*n+' : 'f(?:u|a)?ck(?:ing|y)?' }] }).patterns;
    const result = await evaluateSemanticDecision({ rule: { semantic: { enabled: true, policy, examples, onUncertain: 'allow_and_log' } },
        username: 'test', messageText, context, matches: findBlacklistMatches(messageText, ['fuck'], patterns), deadline: new Date(Date.now() + 4000) });
    console.log(JSON.stringify({ label, verdict: result.verdict, status: result.status, scores: result.scores, model: result.model, inputTokens: result.inputTokens, providerCost: result.cost }));
    assert.equal(result.verdict, expected, label);
}
console.log('PASS Span integration: synthetic profanity, policy-dependent nickname, context, and examples');
