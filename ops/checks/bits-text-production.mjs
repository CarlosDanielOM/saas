// Run with `docker exec -i <affected-container> node --input-type=module < ...`.
// Every side-effect boundary is replaced in this new process: no live data,
// queues, Twitch messages, speech generation or analytics are touched.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const mocks = {
    '/utils/logger.js': 'export const trace = async()=>{}, debug = trace, info = trace, warn = trace, error = trace, fatal = trace;',
    '/utils/tokens.js': 'export const getAppToken = async()=>"fixture", getBotToken = getAppToken, refreshAllTokens = async()=>{}, refreshTwitchToken = async()=>{}, getNewTwitchAppToken = getAppToken;',
    '/utils/posthog_events.js': 'export const trackTts = ()=>{}, identifyStreamer = trackTts, trackCommand = trackTts, trackAiUsageRecorded = trackTts, trackAiOperation = trackTts, shutdownPosthog = async()=>{};'
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        for (const [suffix, source] of Object.entries(mocks)) {
            if (resolved.url.endsWith(suffix)) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
        return resolved;
    }
});
process.env.INTERNAL_API_URL = 'http://tts.mock';
const requests = [];
globalThis.fetch = async (input, options) => {
    assert.match(String(input), /^http:\/\/tts\.mock\/speech\//, 'all other network requests are blocked');
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ error: false, data: { speechID: 'mock' } }), {
        headers: { 'Content-Type': 'application/json' }
    });
};
const { default: TwitchStreamers } = await import('/app/dist/classes/twitch_streamers.class.js');
TwitchStreamers.getTwitchAccountById = async () => ({ id: 'fixture', name: 'fixture', plan_tier: 'premium' });
const { ChannelTtsSettingsSchema } = await import('/app/dist/schemas/channel_tts_settings.schema.js');
ChannelTtsSettingsSchema.findOne = () => ({ lean: async () => ({ enabled: true, defaultLanguage: 'en' }) });
const { cheerHandler } = await import('/app/dist/handlers/cheer.handler.js');
const { applyChatAnnouncementDomainEvent } = await import('/app/dist/domain_events/chat_announcement_events.js');
const { sendTwitchChatMessage } = await import('/app/dist/functions/chats/send_message.chat.js');
const config = { enabled: true, type: 'channel.bits.use', message: '', cheerTiers: [
    { name: 'Rias', message: '$(tts.fish rias_gremory &t)', min_amount: 5, max_amount: 10000 }
] };
for (const message of [{ text: 'Five bits: Hello $(user)!', fragments: [] }, 'Five bits: Hello $(user)!']) {
    const eventData = { broadcaster_user_id: 'fixture', user_id: 'viewer', user_login: 'viewer', user_name: 'Viewer', bits: 5, message };
    const expected = typeof message === 'string' ? message : message.text;
    assert.equal((await cheerHandler(eventData, config, true)).error, false);
    assert.equal(requests.at(-1).text, expected);
    assert.equal(requests.at(-1).cloneName, 'rias_gremory');
    await applyChatAnnouncementDomainEvent({ source: 'twitch-eventsub', channelID: 'fixture',
        type: 'channel.bits.received', payload: { event: eventData },
        metadata: { originalEventType: 'channel.bits.use', durableChatHandled: true }
    }, {
        getStreamer: async () => ({ chat_enabled: 'true' }),
        shouldSkipLegacyBits: async () => false,
        getEventsubConfig: async () => config,
        sendMessage: (channelID, template, context) => sendTwitchChatMessage(channelID, template, null, context)
    });
    assert.equal(requests.at(-1).text, expected);
    assert.equal(requests.at(-1).cloneName, 'rias_gremory');
}
assert.equal(requests.length, 4);
console.log('PASS deployed code: five-bit Rias tier forwards whole structured/legacy viewer text literally through immediate and durable AST paths; all effects mocked');
process.exit(0);
