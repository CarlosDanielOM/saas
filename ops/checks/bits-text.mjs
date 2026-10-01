import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { createTwitchEventsubApp } from '/app/dist/bot/eventsub.twitch.js';
import { applyChatAnnouncementDomainEvent } from '/app/dist/domain_events/chat_announcement_events.js';
import { cheerHandler } from '/app/dist/handlers/cheer.handler.js';
import { getBitsMessageText } from '/app/dist/utils/bits_message.js';
import { RedemptionRewardSchema } from '/app/dist/schemas/redemption_reward.schema.js';
import { redemptionHandler } from '/app/dist/handlers/redemption.handler.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
    '/app/dist/functions/chats/speech.chat.test.js', '/app/dist/handlers/cheer.handler.test.js',
    '/app/dist/domain_events/chat_announcement_events.test.js', '/app/dist/utils/ast_parser/tts_settings.test.js',
    '/app/dist/utils/tts/normalize_tts_message.util.test.js'], { stdio: 'inherit', timeout: 60000 });

const target = process.env.SAAS_TARGET;
assert.ok(['api', 'bot', 'cron'].includes(target));
assert.equal(process.env.INTERNAL_API_URL, undefined, 'exercise the production worker without an API override');
assert.equal(process.env.ENVIRONMENT, undefined, 'exercise the missing legacy production flag');
assert.equal(process.env.NODE_ENV, 'production');
const channelID = '99004401';
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const speech = () => calls().filter(call => call.speech);
const chat = () => calls().filter(call => call.chat);
async function until(check, label) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out: ${label}`);
}
await getMongoDBConnection('BitsTextCheck');
const redis = await getDragonflyClient('BitsTextCheck');
await Promise.all([DomainEventSchema.init(), DomainEventDeliverySchema.init(), EventsubSchema.init()]);
await UsersSchema.create({ name: 'Bits Fixture', accounts: [{ type: 'twitch', id: channelID,
    name: 'bitsfixture', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${channelID}:data`, {
    id: channelID, name: 'bitsfixture', plan_tier: 'premium', chat_enabled: 'true',
    actived: 'true', has_permissions: 'true'
});
await redis.set('app:twitch:token', 'app-token');
const template = '$(tts.fish rias_gremory &t)';
const config = await EventsubSchema.create({ channelID, type: 'channel.bits.use', enabled: true,
    id: 'bits-test', status: 'enabled', version: '1', channel: 'bitsfixture', cost: 0,
    condition: { broadcaster_user_id: channelID }, created_at: new Date().toISOString(),
    transport: { method: 'webhook', callback: 'https://fixture.test/eventsub' },
    message: template, cheerTiers: [{ name: 'Rias', message: template, min_amount: 5, max_amount: 10000 }] });
const event = { broadcaster_user_id: channelID, broadcaster_user_login: 'bitsfixture', broadcaster_user_name: 'Bits Fixture',
    user_id: '99004402', user_login: 'viewer', user_name: 'Viewer', bits: 5, type: 'cheer', is_anonymous: false };
const text = 'Hello Rias! This is the whole viewer message';

// Existing redemption and command callers still reach the same speech API.
await RedemptionRewardSchema.create({ channelID, channel: 'bitsfixture', eventsubID: 'test',
    rewardID: 'tts-reward', title: 'TTS', originalCost: 100, cost: 100, message: '$(tts &t)' });
assert.equal((await redemptionHandler({ ...event, id: 'redemption-test', user_input: text,
    status: 'unfulfilled', redeemed_at: new Date().toISOString(),
    reward: { id: 'tts-reward', title: 'TTS', prompt: '', cost: 100 }
}, true)).error, false);
assert.equal(speech().at(-1).speech.text, text);
assert.equal(speech().at(-1).url, `http://dima-server:3000/speech/${channelID}`);
const parsed = await parseSpecialCommands('$(tts &t)', { channelID, argument: text, literalArguments: true,
    eventData: { ...event, chatter_user_id: event.user_id, chatter_user_login: event.user_login,
        chatter_user_name: event.user_name, message: { text: `!tts ${text}`, fragments: [] } } });
assert.equal(parsed.parsedText, '');
assert.equal(speech().at(-1).speech.text, text);
assert.equal(speech().at(-1).url, `http://dima-server:3000/speech/${channelID}`);

// Immediate/manual path, legacy payloads, default templates and positional text.
for (const message of [{ text, fragments: [] }, text]) {
    for (const bits of [5, 1]) {
        const before = speech().length;
        assert.equal((await cheerHandler({ ...event, bits, message }, config, true)).error, false);
        assert.equal(speech().length, before + 1);
        assert.equal(speech().at(-1).speech.text, text);
        assert.equal(speech().at(-1).speech.cloneName, 'rias_gremory');
        assert.equal(speech().at(-1).speech.requestedBy.userID, event.user_id);
    }
}
assert.equal(chat().length, 0, 'successful TTS-only templates do not post usage errors');
for (const name of ['tts', 'tts.speak', 'tts.ai', 'tts.clone', 'tts.fish']) {
    const before = speech().length;
    const message = `$(${name} ${['tts.clone', 'tts.fish'].includes(name) ? 'rias_gremory ' : ''}&t)`;
    await cheerHandler({ ...event, message: { text, fragments: [] } }, {
        ...config.toObject(), cheerTiers: [], message
    }, true);
    assert.equal(speech().length, before + 1, name);
    assert.equal(speech().at(-1).speech.text, text, name);
    assert.equal(speech().at(-1).url, `http://dima-server:3000/speech/${channelID}`, name);
}
assert.equal(chat().length, 0, 'all cheer TTS variants reach the internal API without chat errors');
const literal = 'Hello $(user) %(injected 1) &t';
await cheerHandler({ ...event, message: { text: literal, fragments: [] } }, config, true);
assert.equal(speech().at(-1).speech.text, literal, 'viewer syntax stays literal');
const positional = { ...config.toObject(), cheerTiers: [{ name: 'voice', min_amount: 5, max_amount: 5,
    message: '$(tts.fish &p1 &t)' }] };
await cheerHandler({ ...event, message: { text: `rias_gremory ${text}`, fragments: [] } }, positional, true);
assert.equal(speech().at(-1).speech.text, text);
const beforeEmpty = speech().length;
for (const message of [undefined, { text: '', fragments: [] }]) {
    await cheerHandler({ ...event, message }, config, true);
    assert.equal(speech().length, beforeEmpty, 'missing text does not queue speech');
    assert.match(chat().at(-1).chat.message, /^Usage:/);
}
await cheerHandler({ ...event, message: { text, fragments: [] } }, config, false);
assert.equal(speech().length, beforeEmpty, 'disabled chat suppresses immediate cheer');
await cheerHandler({ ...event, message: { text, fragments: [] } }, {
    ...config.toObject(), cheerTiers: [{ name: 'invalid', min_amount: 5, max_amount: 5,
        message: '$(tts.fish invalid_voice &t)' }]
}, true);
assert.equal(chat().at(-1).chat.message, 'Invalid Fish voice');
for (const message of [null, {}, { text: 123 }, false]) assert.equal(getBitsMessageText(message), '');

// Signed provider ingress plus the real durable announcement consumer.
let server;
let webhookURL = 'http://127.0.0.1:3333/eventsub';
if (target !== 'bot') {
    server = createTwitchEventsubApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    webhookURL = `http://127.0.0.1:${server.address().port}/eventsub`;
}
if (target === 'cron') await until(() => calls().some(call => call.worker), 'domain worker started');
for (const [index, message] of [{ text: literal, fragments: [] }, text].entries()) {
    const receipt = `bits-text-${index}`;
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ subscription: { id: 'bits-test', type: 'channel.bits.use', version: '1',
        condition: { broadcaster_user_id: channelID }, transport: { method: 'webhook' } }, event: { ...event, message } });
    const headers = { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': receipt,
        'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Type': 'notification',
        'Twitch-Eventsub-Message-Signature': 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
            .update(receipt).update(timestamp).update(body).digest('hex') };
    const before = speech().length;
    assert.equal((await fetch(webhookURL, { method: 'POST', headers, body })).status, 204);
    const journaled = await DomainEventSchema.findOne({ sourceEventId: receipt }).lean();
    assert.ok(journaled);
    if (target === 'cron') {
        await until(async () => (await DomainEventDeliverySchema.findOne({ eventKey: journaled.eventKey,
            consumer: 'chat-announcements-v1' }).lean())?.status === 'succeeded', 'durable bits speech delivered');
    } else await applyChatAnnouncementDomainEvent(journaled);
    assert.equal(speech().length, before + 1);
    assert.equal(speech().at(-1).speech.text, index === 0 ? literal : text);
    assert.equal(speech().at(-1).speech.cloneName, 'rias_gremory');
    assert.equal((await fetch(webhookURL, { method: 'POST', headers, body })).status, 204);
    assert.equal(speech().length, before + 1, 'duplicate webhook does not queue again');
}
console.log(`PASS ${target}: production API fallback without overrides, all cheer TTS variants, whole bits text, structured/legacy events, Rias tier/default, literal syntax, positional arguments, missing text, invalid voice, disabled chat, signed webhook and durable delivery`);
if (server) await new Promise(resolve => server.close(resolve));
await mongoose.disconnect();
await redis.quit();
process.exit(0);
