// Isolated API behavior check. Run with disposable Mongo/Redis, dummy env in
// ops/checks/ai-chat-fixtures/test-env.json, and its provider mock fixtures.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { encrypt } from '/app/dist/utils/crypto.js';
import { ChannelModerationSettingsSchema } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { moderationSettingsCacheKey, NO_SETTINGS_SENTINEL } from '/app/dist/handlers/moderation.handler.js';

await getMongoDBConnection('auth-activation-check');
const redis = await getDragonflyClient('auth-activation-check');
const channelID = 'saas-auth-activation-1';
const name = 'saas_auth_fixture';
await UsersSchema.create({
  name,
  accounts: [{ type: 'twitch', id: channelID, name, email: '',
    access_token: encrypt('fixture-access'), refresh_token: encrypt('fixture-refresh'),
    access_token_expires_at: Math.floor(Date.now() / 1000) + 3600, actived: false, chat_enabled: false, has_permissions: true, up_to_date_permissions: true }],
  plan_tier: 'free'
});
await redis.set(moderationSettingsCacheKey(channelID), NO_SETTINGS_SENTINEL);
const response = await fetch(`http://127.0.0.1:3000/auth/mock-register?state=${name}`, { redirect: 'manual' });
const body = await response.text();
const settings = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
assert.ok(settings, `registration response ${response.status}: ${body}`);
assert.equal(settings.enabled, true, 'first activation seeds enabled moderation settings');
assert.notEqual(await redis.get(moderationSettingsCacheKey(channelID)), NO_SETTINGS_SENTINEL,
  'first activation replaces stale no-settings cache');
assert.equal(response.status, 302, `mock registration should complete: ${body}`);
const user = await UsersSchema.findOne({ 'accounts.id': channelID }).lean();
assert.equal(user.accounts.find(a => a.id === channelID).actived, true);
await ChannelModerationSettingsSchema.updateOne({ channelID }, { $set: { enabled: false } });
const repeat = await fetch(`http://127.0.0.1:3000/auth/mock-register?state=${name}`, { redirect: 'manual' });
assert.equal(repeat.status, 302, 'subsequent registration completes');
const saved = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
assert.equal(saved.enabled, false, 'subsequent registration preserves a configured moderation switch');
console.log('PASS first activation seeds moderation before cache refresh; repeat activation preserves settings');
process.exit(0);
