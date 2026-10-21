// Shared request-time TypeScript utilities are the independent parity oracle.
// Never load the retired scheduled entrypoint or real moderation providers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.equal(uri.port, '27017');
assert.match(uri.pathname, /^\/raid_sessions_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
assert.match(process.argv[2] || '', /^\/tmp\/raid-sessions-fixture-[0-9]+-[0-9]+\.json$/);
process.env.OBSERVABILITY_DISABLED = 'true';
globalThis.fetch = async () => { throw new Error('External requests forbidden in raid sessions reference'); };
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire('/app/package.json'), mongoose = require('mongoose');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
let redis;
try {
    await (await import('/app/dist/utils/databases/mongodb.database.js')).getMongoDBConnection('RaidSessionsIsolatedReference');
    redis = await (await import('/app/dist/utils/databases/dragonfly.database.js')).getDragonflyClient('RaidSessionsIsolatedReference');
    const raid = await import('/app/dist/utils/raid_sessions.js');
    const actions = await import('/app/dist/utils/follow_defense_actions.js');
    let result = null;
    if (input.mode === 'tick') {
        await raid.extendRaidHistoryRetention(); await raid.backfillRaidSession(); await raid.processRaidModerationRequests();
    } else if (input.mode === 'follow') result = await raid.recordRaidFollow(input.follow);
    else if (input.mode === 'session') result = await raid.recordRaidSession(input.marker);
    else if (input.mode === 'cancel') await actions.cancelFollowDefenseActions(input.channelID);
    else if (input.mode === 'execute') {
        const calls = [];
        for (let i = 0; i < (input.steps || 1); i++) {
            await actions.processFollowDefenseAction(async action => {
                calls.push({ id: action._id, followerID: action.followerID, requestID: action.raidRequestID });
                return { error: false, message: 'fixture banned', status: 200 };
            });
            if (i + 1 < input.steps) await new Promise(resolve => setTimeout(resolve, 220));
        }
        result = calls;
    } else throw new Error('Unsupported raid reference operation');
    console.log('RAID_SESSIONS_REFERENCE:' + JSON.stringify(result));
} finally { await mongoose.disconnect(); if (redis?.isOpen) redis.destroy(); }
