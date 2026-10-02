// Use saas-ops with disposable Mongo/Redis and raid-fixtures provider mocks.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { FollowDefenseSettingsSchema as Settings } from '/app/dist/schemas/follow_defense_settings.schema.js';
import { RaidSessionSchema as Sessions, RaidModerationRequestSchema as Requests } from '/app/dist/schemas/raid_session.schema.js';
import { applyRaidSessionMarker, findRaidSession } from '/app/dist/utils/raid_sessions.js';
import { followDefenseKeys, projectFollowDefenseState, shouldSuppressFollowAlerts } from '/app/dist/utils/follow_defense_queue.js';
import { processDurableFollowDefenseFollow } from '/app/dist/utils/follow_defense.js';

await getMongoDBConnection('raid-mode-check');
const redis = await getDragonflyClient('raid-mode-check');
await Promise.all([Settings.init(), Sessions.init(), Requests.init()]);
let sequence = 0;
for (const resetAttackOnNewRaid of [true, false]) {
    for (const mode of [null, 'normal', 'silent', 'expired-protection', 'protection', 'attack']) {
        const channelID = String(900000000 + ++sequence);
        const keys = followDefenseKeys(channelID);
        const now = Date.now();
        await Settings.create({ channelID, resetAttackOnNewRaid, protectionThresholdB: 3, silentThresholdX: 2, attackThreshold: 4 });
        const initial = mode === null ? null : {
            mode: mode === 'expired-protection' ? 'protection' : mode,
            channelID, channelLogin: 'fixture', channelName: 'Fixture',
            modeStartedAt: now - 2000, burstStartedAt: now - 2000,
            expiresAt: mode === 'expired-protection' ? now - 1 : now + 60000,
            triggeredBy: 'threshold', lastTransitionReason: 'fixture', lastUpdatedAt: now,
            ...(mode === 'attack' ? { raidRequestID: 'previous-raid-request' } : {})
        };
        if (initial) await redis.set(keys.state, JSON.stringify(initial));
        await redis.zAdd(keys.tracked, { value: 'previous-wave', score: now - 2000 });
        const marker = {
            eventID: `raid-mode-${sequence}`, channelID, channelLogin: 'fixture', channelName: 'Fixture',
            raiderChannelID: '123', raiderChannelLogin: 'raider', raiderChannelName: 'Raider', raidViewers: 1000,
            createdAt: now - 1000, expiresAt: now + 299000
        };
        await applyRaidSessionMarker(marker);
        const raw = await redis.get(keys.state);
        const changed = mode === 'protection' || mode === 'attack';
        if (!changed) {
            assert.equal(raw, initial ? JSON.stringify(initial) : null, `${mode}/${resetAttackOnNewRaid}: raid alone must not change mode`);
            assert.deepEqual(await redis.zRange(keys.tracked, 0, -1), ['previous-wave'], 'ignored transition preserves tracked follows');
        } else {
            const state = JSON.parse(raw);
            assert.equal(state.mode, mode === 'attack' && !resetAttackOnNewRaid ? 'attack' : 'protection');
            assert.equal(state.raidRequestID === 'previous-raid-request', false, 'new raid never inherits previous authorization');
            assert.deepEqual(await redis.zRange(keys.tracked, 0, -1), []);
        }
        const session = await findRaidSession(channelID, Date.now());
        assert.ok(session, 'raid history still recorded');
        assert.ok(await redis.get(keys.raid), 'raid marker still prevents automatic raid bans');
        if (mode === null) {
            assert.equal(await shouldSuppressFollowAlerts(channelID), false);
            // An ignored raid retry must not upgrade a later silent wave.
            await projectFollowDefenseState(channelID, { type: 'transition', state: {
                ...initial, mode: 'silent', channelID, channelLogin: 'fixture', channelName: 'Fixture',
                modeStartedAt: now, burstStartedAt: now, expiresAt: now + 60000,
                triggeredBy: 'threshold', lastTransitionReason: 'fixture', lastUpdatedAt: now
            } });
            const silent = await redis.get(keys.state);
            await applyRaidSessionMarker(marker);
            assert.equal(await redis.get(keys.state), silent, 'raid replay cannot activate protection');
            await redis.del([keys.state, keys.tracked]);
            for (let i = 1; i <= 4; i++) {
                await processDurableFollowDefenseFollow({ eventID: `mode-follow-${sequence}-${i}`, channelID,
                    channelLogin: 'fixture', channelName: 'Fixture', followerID: String(i), followerLogin: 'viewer', followerName: 'Viewer',
                    followedAt: new Date().toISOString(), receivedAt: Date.now() });
                const state = JSON.parse(await redis.get(keys.state) || 'null');
                assert.equal(state?.mode || null, i === 1 ? null : i === 2 ? 'silent' : 'protection', 'follow thresholds still activate protection during raids');
            }
            assert.equal((await Requests.countDocuments({ channelID })), 0, 'thresholds never request automatic raid bans');
        }
    }
}
console.log('PASS: raid alone preserves normal/silent/expired modes; active protection/attack honors reset or carryover; history, replay fencing and follow thresholds preserved');
process.exit(0);
