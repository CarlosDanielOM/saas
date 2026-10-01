import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { RedemptionRewardSchema } from '/app/dist/schemas/redemption_reward.schema.js';
import { redemptionHandler } from '/app/dist/handlers/redemption.handler.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';
import { createDefaultChannelTtsSettings, upsertChannelTtsSettings } from '/app/dist/schemas/channel_tts_settings.schema.js';
import { getTtsEmoteNames } from '/app/dist/utils/tts/emote_names.util.js';

await getMongoDBConnection('TtsSettingsCheck');
const redis = await getDragonflyClient('TtsSettingsCheck');
const channelID = '99118801';
await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'ttsfixture', plan_tier: 'premium' });
await redis.set('app:twitch:token', 'test-only');
const catalogCalls = [];
const originalFetch = globalThis.fetch;
let channelUnavailable = false;
globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.twitch.tv' && url.pathname.startsWith('/helix/chat/emotes')) {
        catalogCalls.push(url.pathname);
        const global = url.pathname.endsWith('/global');
        return new Response(JSON.stringify(global ? { data: [{ name: 'Kappa' }] }
            : channelUnavailable ? { error: 'Unavailable' }
            : { data: [...Array.from({ length: 50 }, (_, i) => ({ name: `fixture${i}` })), { name: 'ethand14Gojoseggs' }] }), {
            status: !global && channelUnavailable ? 503 : 200, headers: { 'Content-Type': 'application/json' }
        });
    }
    return originalFetch(input, options);
};
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const speech = () => calls().filter(call => call.speech);
const chats = () => calls().filter(call => call.chat);
const text = `Ahuevo ya vengo voy al baño ${Array(19).fill('ethand14Gojoseggs').join(' ')}`;
const event = { id: 'redemption-test', broadcaster_user_id: channelID, broadcaster_user_login: 'ttsfixture',
    broadcaster_user_name: 'TTS Fixture', user_id: 'viewer', user_login: 'viewer', user_name: 'Viewer',
    user_input: text, status: 'unfulfilled', redeemed_at: new Date().toISOString(),
    reward: { id: 'tts-reward', title: 'TTS', prompt: '', cost: 100 } };
const reward = await RedemptionRewardSchema.create({ channelID, channel: 'ttsfixture', eventsubID: 'test',
    rewardID: event.reward.id, title: 'TTS', originalCost: 100, cost: 100, message: '$(tts &t)' });

async function run(name, input = text) {
    await RedemptionRewardSchema.updateOne({ _id: reward._id }, { $set: {
        message: `$(${name} ${['tts.clone', 'tts.fish'].includes(name) ? 'rias_gremory ' : ''}&t)`
    } });
    assert.equal((await redemptionHandler({ ...event, user_input: input }, true)).error, false);
}
for (const name of ['tts', 'tts.speak', 'tts.ai', 'tts.clone', 'tts.fish']) {
    const settings = createDefaultChannelTtsSettings(channelID);
    settings.provider = 'fish';
    settings.filters.expressiveTags.angry = false;
    await upsertChannelTtsSettings(channelID, settings);
    let before = speech().length;
    await run(name);
    assert.equal(speech().length, before + 1, name);
    assert.equal(speech().at(-1).speech.text, 'Ahuevo ya vengo voy al baño', name);
    await run(name, '[angry] Hello Kappa ethand14Gojoseggs [happy]');
    assert.equal(speech().at(-1).speech.text, name === 'tts.speak' ? 'Hello' : 'Hello [happy]', name);
    before = speech().length;
    await run(name, 'Kappa ethand14Gojoseggs');
    assert.equal(speech().length, before, 'emote-only redemption never queues speech');
    assert.match(chats().at(-1).chat.message, /No speakable text/);
    settings.filters.skipEmotes = false;
    await upsertChannelTtsSettings(channelID, settings);
    await run(name, 'Hello ethand14Gojoseggs');
    assert.equal(speech().at(-1).speech.text, 'Hello ethand14Gojoseggs', 'disabled filter preserves emotes');
    settings.enabled = false;
    await upsertChannelTtsSettings(channelID, settings);
    before = speech().length;
    await run(name, 'Hello');
    assert.equal(speech().length, before, 'disabled TTS never queues speech');
}
assert.equal(catalogCalls.length, 2, 'one global and one complete channel lookup, cached across redemptions');
assert.ok((await getTtsEmoteNames(channelID)).includes('ethand14Gojoseggs'), 'catalog is not capped at 40 names');
channelUnavailable = true;
assert.deepEqual(await getTtsEmoteNames('unavailable'), ['Kappa'], 'global catalog survives channel provider failure');
await getTtsEmoteNames('unavailable');
assert.equal(catalogCalls.length, 3, 'failed provider is cached briefly');

// Confirm existing chat fragment filtering still works without a catalog request.
await upsertChannelTtsSettings(channelID, createDefaultChannelTtsSettings(channelID));
const before = catalogCalls.length;
await parseSpecialCommands('$(tts &t)', { channelID, argument: 'Hello NativeEmote', literalArguments: true,
    eventData: { chatter_user_id: 'viewer', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
        message: { text: '!s Hello NativeEmote', fragments: [{ type: 'emote', text: 'NativeEmote' }] } } });
assert.equal(speech().at(-1).speech.text, 'Hello');
assert.equal(catalogCalls.length, before);
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
    '/app/dist/utils/ast_parser/tts_settings.test.js', '/app/dist/utils/tts/normalize_tts_message.util.test.js'], {
    stdio: 'inherit', timeout: 60000
});
console.log(`PASS ${process.env.SAAS_TARGET}: actual redemption handler, exact reported text, all TTS variants, emotion settings, emote-only/disabled filters, complete cached catalogs, provider failure and chat regression`);
process.exit(0);
