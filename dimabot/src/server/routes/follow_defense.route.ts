import { getDefenseBaseline } from '../../utils/follow_defense_baseline.js';
import express, { type Request, type Response } from 'express';
import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import { FollowAttackLogSchema } from '../../schemas/follow_attack_log.schema.js';
import { FollowDefenseSettingsSchema, type FollowDefenseLanguage, type IFollowDefenseSettings } from '../../schemas/follow_defense_settings.schema.js';
import { cancelFollowDefenseActions, getFollowDefenseActionCounts } from '../../utils/follow_defense_actions.js';
import { FollowHateRaidSourceSchema } from '../../schemas/follow_hate_raid_source.schema.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import {
    followDefenseKeys,
    getFollowDefenseStatus,
    triggerFollowDefenseAttackMode,
    type FollowDefenseRaidMarker,
    type FollowDefenseState
} from '../../utils/follow_defense_queue.js';

interface FollowDefenseRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

interface FollowDefenseSettingsResponse {
    channelID: string;
    channel: string;
    enabled: boolean;
    silentModeEnabled: boolean;
    protectionModeEnabled: boolean;
    attackModeEnabled: boolean;
    resetAttackOnNewRaid: boolean;
    silentThresholdX: number;
    silentWindowYSeconds: number;
    protectionThresholdB: number;
    attackThreshold: number | null;
    silentDurationSeconds: number;
    baselineFollowsPerHour: number | null;
    language: FollowDefenseLanguage;
    settingsVersion: number;
}

const router = express.Router();

const DEFAULT_SETTINGS = {
    enabled: true,
    silentModeEnabled: true,
    protectionModeEnabled: true,
    attackModeEnabled: true,
    resetAttackOnNewRaid: true,
    silentThresholdX: 10,
    silentWindowYSeconds: 5,
    protectionThresholdB: 100,
    attackThreshold: null as number | null,
    silentDurationSeconds: 60,
    baselineFollowsPerHour: null as number | null,
    language: 'en' as FollowDefenseLanguage,
    settingsVersion: 1
};

const BOOLEAN_FIELDS = new Set([
    'enabled',
    'silentModeEnabled',
    'protectionModeEnabled',
    'attackModeEnabled', 'resetAttackOnNewRaid'
]);

const NUMBER_FIELDS = new Set([
    'silentThresholdX',
    'silentWindowYSeconds',
    'protectionThresholdB',
    'attackThreshold',
    'silentDurationSeconds',
    'baselineFollowsPerHour'
]);

function getParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || '';
}

function parseJson<T>(value: string | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

async function getAccessContext(requesterID: string, channelID: string): Promise<{ allowed: boolean; role: 'owner' | 'admin' | 'none' }> {
    return getChannelAccessContext(requesterID, channelID, 'dashboard:view');
}

async function validateAccess(req: FollowDefenseRequest, res: Response, channelID: string): Promise<{ allowed: true; role: 'owner' | 'admin'; channelName: string } | null> {
    const requesterID = req.user?.id;

    if (!requesterID) {
        res.status(401).json({
            error: true,
            message: 'Authentication required',
            status: 401
        });
        return null;
    }

    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    if (!streamer) {
        res.status(404).json({
            error: true,
            message: 'Streamer not found',
            status: 404
        });
        return null;
    }

    const access = await getAccessContext(requesterID, channelID);
    if (!access.allowed) {
        res.status(403).json({
            error: true,
            message: 'You do not have permission to manage Follow Defense for this channel',
            status: 403
        });
        return null;
    }

    return {
        allowed: true,
        role: access.role === 'owner' ? 'owner' : 'admin',
        channelName: streamer.name || ''
    };
}

function toSettingsResponse(settings: IFollowDefenseSettings | FollowDefenseSettingsResponse): FollowDefenseSettingsResponse {
    return {
        channelID: settings.channelID,
        channel: settings.channel || '',
        enabled: settings.enabled ?? DEFAULT_SETTINGS.enabled,
        silentModeEnabled: settings.silentModeEnabled ?? DEFAULT_SETTINGS.silentModeEnabled,
        protectionModeEnabled: settings.protectionModeEnabled ?? DEFAULT_SETTINGS.protectionModeEnabled,
        attackModeEnabled: settings.attackModeEnabled ?? DEFAULT_SETTINGS.attackModeEnabled,
        resetAttackOnNewRaid: settings.resetAttackOnNewRaid ?? true,
        silentThresholdX: settings.silentThresholdX || DEFAULT_SETTINGS.silentThresholdX,
        silentWindowYSeconds: settings.silentWindowYSeconds || DEFAULT_SETTINGS.silentWindowYSeconds,
        protectionThresholdB: settings.protectionThresholdB || DEFAULT_SETTINGS.protectionThresholdB,
        attackThreshold: settings.attackThreshold ?? null,
        silentDurationSeconds: settings.silentDurationSeconds || DEFAULT_SETTINGS.silentDurationSeconds,
        baselineFollowsPerHour: settings.baselineFollowsPerHour ?? null,
        language: settings.language === 'es' ? 'es' : 'en',
        settingsVersion: settings.settingsVersion || DEFAULT_SETTINGS.settingsVersion
    };
}

async function cacheSettings(settings: FollowDefenseSettingsResponse): Promise<void> {
    const cache = await getDragonflyClient('followDefenseRoute.cacheSettings');
    await cache.set(followDefenseKeys(settings.channelID).settings, JSON.stringify(settings));
}

async function getOrCreateSettings(channelID: string, channelName: string): Promise<FollowDefenseSettingsResponse> {
    const settings = await FollowDefenseSettingsSchema.findOneAndUpdate({
        channelID
    }, {
        $setOnInsert: {
            channelID,
            channel: channelName,
            ...DEFAULT_SETTINGS
        }
    }, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
    });

    const response = toSettingsResponse(settings.toObject() as IFollowDefenseSettings);
    await cacheSettings(response);
    return response;
}

function buildSettingsPatch(body: Record<string, unknown>): Partial<IFollowDefenseSettings> {
    const patch: Partial<IFollowDefenseSettings> = {};

    for (const [key, value] of Object.entries(body)) {
        if (BOOLEAN_FIELDS.has(key)) {
            if (typeof value === 'boolean') {
                (patch as Record<string, unknown>)[key] = value;
            }
            continue;
        }

        if (NUMBER_FIELDS.has(key)) {
            if ((key === 'baselineFollowsPerHour' || key === 'attackThreshold') && (value === null || (typeof value === 'string' && value.trim() === ''))) {
                patch[key] = null;
                continue;
            }

            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 0) {
                (patch as Record<string, unknown>)[key] = Math.round(parsed);
            }
            continue;
        }

        if (key === 'language' && (value === 'en' || value === 'es')) {
            patch.language = value;
        }
    }

    return patch;
}

async function getTrackedCount(channelID: string): Promise<number> {
    const cache = await getDragonflyClient('followDefenseRoute.getTrackedCount');
    return cache.zCard(followDefenseKeys(channelID).tracked);
}

async function getRaidMarker(channelID: string): Promise<FollowDefenseRaidMarker | null> {
    const cache = await getDragonflyClient('followDefenseRoute.getRaidMarker');
    const marker = parseJson<FollowDefenseRaidMarker>(await cache.get(followDefenseKeys(channelID).raid));
    if (!marker || marker.expiresAt <= Date.now()) return null;
    return marker;
}

async function buildStatus(channelID: string, channelName: string): Promise<Record<string, unknown>> {
    const now = Date.now();
    const state = await getFollowDefenseStatus(channelID);
    const activeState: FollowDefenseState = state && (!state.expiresAt || state.expiresAt > now) ? state : {
        mode: 'normal',
        channelID,
        channelLogin: channelName.toLowerCase(),
        channelName,
        modeStartedAt: 0,
        burstStartedAt: 0,
        expiresAt: 0,
        triggeredBy: 'threshold',
        lastTransitionReason: 'normal',
        lastUpdatedAt: now
    };

    return {
        ...activeState,
        trackedCount: await getTrackedCount(channelID),
        dynamicBaseline: await getDefenseBaseline(channelID),
        moderationQueue: await getFollowDefenseActionCounts(channelID),
        raid: await getRaidMarker(channelID)
    };
}

router.get('/:channelID/settings', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        const settings = await getOrCreateSettings(channelID, access.channelName);

        return res.status(200).json({
            error: false,
            message: 'Follow Defense settings fetched successfully',
            status: 200,
            role: access.role,
            data: settings
        });
    } catch (error) {
        console.error('Error in GET /follow-defense/:channelID/settings:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.patch('/:channelID/settings', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        await getOrCreateSettings(channelID, access.channelName);
        if (Object.hasOwn(req.body, 'attackThreshold')) {
            const value = req.body.attackThreshold;
            if (value !== null && value !== '' && !(typeof value === 'string' && value.trim() === '')
                && ((typeof value !== 'number' && typeof value !== 'string') || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
                return res.status(400).json({ error: true, message: 'Attack threshold must be a positive integer or empty for dynamic sensitivity', status: 400 });
            }
        }
        const patch = buildSettingsPatch(req.body as Record<string, unknown>);
        if (patch.resetAttackOnNewRaid !== undefined && !(await getChannelAccessContext(req.user!.id, channelID, 'moderation:manage')).allowed) {
            return res.status(403).json({ error: true, message: 'Moderation permission required' });
        }

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({
                error: true,
                message: 'No valid settings fields provided',
                status: 400
            });
        }

        const updated = await FollowDefenseSettingsSchema.findOneAndUpdate({
            channelID
        }, {
            $set: {
                ...patch,
                channel: access.channelName
            }
        }, {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true
        });

        const settings = toSettingsResponse(updated.toObject() as IFollowDefenseSettings);
        if (patch.enabled === false || patch.attackModeEnabled === false || patch.protectionModeEnabled === false) {
            await cancelFollowDefenseActions(channelID);
        }
        await cacheSettings(settings);

        return res.status(200).json({
            error: false,
            message: 'Follow Defense settings updated successfully',
            status: 200,
            role: access.role,
            data: settings
        });
    } catch (error) {
        console.error('Error in PATCH /follow-defense/:channelID/settings:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            body: req.body,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/status', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        return res.status(200).json({
            error: false,
            message: 'Follow Defense status fetched successfully',
            status: 200,
            data: await buildStatus(channelID, access.channelName)
        });
    } catch (error) {
        console.error('Error in GET /follow-defense/:channelID/status:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/attack', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;
        if (!(await getChannelAccessContext(req.user!.id, channelID, 'moderation:manage')).allowed) return res.status(403).json({ error: true, message: 'Moderation permission required' });

        const settings = await getOrCreateSettings(channelID, access.channelName);
        if (!settings.enabled || !settings.attackModeEnabled) {
            return res.status(409).json({
                error: true,
                message: 'Follow Defense attack mode is disabled for this channel',
                status: 409
            });
        }

        await triggerFollowDefenseAttackMode(channelID, access.channelName.toLowerCase(), access.channelName);

        const current = await getFollowDefenseStatus(channelID);
        const mode = current && current.expiresAt > Date.now() ? current.mode : 'normal';
        return res.status(202).json({
            error: false,
            message: mode === 'attack' ? 'Attack mode activation queued' : 'Recorded raid followers queued for moderation',
            status: 202,
            data: {
                success: true,
                mode, historicalOnly: mode !== 'attack'
            }
        });
    } catch (error) {
        console.error('Error in POST /follow-defense/:channelID/attack:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        const status = Number((error as { status?: number }).status) || 500;
        return res.status(status).json({ error: true, message: status < 500 ? (error as Error).message : 'Internal server error', status });
    }
});

router.post('/:channelID/reset', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        const cache = await getDragonflyClient('followDefenseRoute.reset');
        const keys = followDefenseKeys(channelID);
        await cancelFollowDefenseActions(channelID);
        await cache.del([keys.state, keys.tracked, keys.recent, keys.summary, keys.summaryLock]);
        await cache.zRem(keys.summaries, channelID);
        await cache.zRem(keys.activeChannels, channelID);

        return res.status(200).json({
            error: false,
            message: 'Follow Defense mode reset successfully',
            status: 200,
            data: {
                success: true,
                mode: 'normal'
            }
        });
    } catch (error) {
        console.error('Error in POST /follow-defense/:channelID/reset:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/attacks', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10)));
        const skip = (page - 1) * limit;

        const [entries, total] = await Promise.all([
            FollowAttackLogSchema.find({ targetChannelID: channelID }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            FollowAttackLogSchema.countDocuments({ targetChannelID: channelID })
        ]);

        return res.status(200).json({
            error: false,
            message: 'Follow Defense attack logs fetched successfully',
            status: 200,
            data: {
                entries: entries.map((entry) => ({
                    id: String(entry._id),
                    channelID: entry.targetChannelID,
                    channelLogin: entry.targetChannelLogin,
                    channelName: entry.targetChannelName,
                    triggeredMode: entry.modeTriggered,
                    triggeredBy: entry.triggeredBy,
                    totalFollows: entry.totalFollows,
                    velocity: entry.velocity,
                    isRaid: entry.isRaid,
                    raiderChannelID: entry.raidInfo?.raiderChannelID,
                    raiderChannelLogin: entry.raidInfo?.raiderChannelLogin,
                    raiderChannelName: entry.raidInfo?.raiderChannelName,
                    bannedCount: entry.trackedFollows.filter((follow) => follow.banned).length,
                    createdAt: new Date(entry.createdAt).getTime()
                })),
                total,
                page,
                limit
            }
        });
    } catch (error) {
        console.error('Error in GET /follow-defense/:channelID/attacks:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/hate-raids', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10)));
        const skip = (page - 1) * limit;

        const [sources, total] = await Promise.all([
            FollowHateRaidSourceSchema.find({ targetChannelID: channelID }).sort({ count: -1, lastSeenAt: -1 }).skip(skip).limit(limit).lean(),
            FollowHateRaidSourceSchema.countDocuments({ targetChannelID: channelID })
        ]);

        return res.status(200).json({
            error: false,
            message: 'Follow Defense hate raid sources fetched successfully',
            status: 200,
            data: {
                sources: sources.map((source) => ({
                    id: String(source._id),
                    raiderChannelID: source.raiderChannelID,
                    raiderChannelLogin: source.raiderChannelLogin,
                    raiderChannelName: source.raiderChannelName,
                    count: source.count,
                    firstSeen: new Date(source.firstSeenAt).getTime(),
                    lastSeen: new Date(source.lastSeenAt).getTime()
                })),
                total,
                page,
                limit
            }
        });
    } catch (error) {
        console.error('Error in GET /follow-defense/:channelID/hate-raids:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});


router.get('/:channelID/raid-sessions', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        if (!await validateAccess(req, res, channelID)) return;
        const { RaidSessionSchema: Sessions, RaidFollowerSchema: Followers, RaidModerationRequestSchema: Requests } = await import('../../schemas/raid_session.schema.js');
        const { FollowDefenseActionSchema: Actions } = await import('../../schemas/follow_defense_action.schema.js');
        const page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page)) || 1));
        const filter = { channelID, expiresAt: { $gt: new Date() } };
        const { getRaidHistoryAccess } = await import('../../utils/raid_sessions.js');
        const [sessions, total, permission, access] = await Promise.all([
            Sessions.find(filter).sort({ startedAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20).lean(),
            Sessions.countDocuments(filter), getChannelAccessContext(req.user!.id, channelID, 'moderation:manage'), getRaidHistoryAccess(channelID)
        ]);
        const ids = sessions.map(s => s._id);
        const [counts, outcomes, requests, state] = await Promise.all([
            Followers.aggregate<{ _id: string; count: number }>([{ $match: { channelID, sessionID: { $in: ids } } }, { $group: { _id: '$sessionID', count: { $sum: 1 } } }]),
            Actions.aggregate([{ $match: { channelID, raidSessionID: { $in: ids }, kind: 'ban' } }, { $sort: { createdAt: -1 } },
                { $group: { _id: { session: '$raidSessionID', user: '$followerID' }, status: { $first: '$status' } } },
                { $group: { _id: { session: '$_id.session', status: '$status' }, count: { $sum: 1 } } }]),
            Requests.find({ channelID, sessionID: { $in: ids }, status: { $in: ['pending', 'active'] }, expiresAt: { $gt: new Date() } }).select('sessionID').lean(), getFollowDefenseStatus(channelID)
        ]);
        return res.json({ error: false, data: { sessions: sessions.map(s => ({ ...s, id: s._id,
            totalFollows: counts.find(c => c._id === s._id)?.count || 0,
            collecting: !s.endedAt && s.captureUntil.getTime() > Date.now(),
            banning: requests.some(r => r.sessionID === s._id),
            canIncludeFuture: !s.endedAt && s.captureUntil.getTime() > Date.now() && state?.mode !== 'normal' && (state?.expiresAt || 0) > Date.now() && state?.raidSessionID === s._id,
            outcomes: Object.fromEntries(outcomes.filter(o => o._id.session === s._id).map(o => [o._id.status, o.count]))
        })), total, page, limit: 20, canBan: permission.allowed, planTier: access.planTier,
            canBanSession: permission.allowed && access.canBanSession, canBanIndividual: permission.allowed && access.canBanIndividual } });
    } catch (error) { return res.status(500).json({ error: true, message: 'Unable to load raid sessions' }); }
});

router.get('/:channelID/raid-sessions/:sessionID/followers', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID), sessionID = getParam(req.params.sessionID);
        if (!await validateAccess(req, res, channelID)) return;
        const { RaidSessionSchema: Sessions, RaidFollowerSchema: Followers } = await import('../../schemas/raid_session.schema.js');
        const { FollowDefenseActionSchema: Actions } = await import('../../schemas/follow_defense_action.schema.js');
        if (!await Sessions.exists({ _id: sessionID, channelID, expiresAt: { $gt: new Date() } })) return res.status(404).json({ error: true, message: 'Raid session expired or not found' });
        const page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page)) || 1));
        const filter = { channelID, sessionID };
        const [followers, total] = await Promise.all([
            Followers.find(filter).sort({ followedAt: 1, _id: 1 }).skip((page - 1) * 50).limit(50).lean(), Followers.countDocuments(filter)
        ]);
        const outcomes = await Actions.find({ channelID, raidSessionID: sessionID, followerID: { $in: followers.map(f => f.userID) }, kind: 'ban' })
            .sort({ createdAt: -1 }).select('followerID status lastMessage').lean();
        return res.json({ error: false, data: { followers: followers.map(f => ({ id: f._id, userID: f.userID, login: f.login, name: f.name, followedAt: f.followedAt,
            banStatus: outcomes.find(o => o.followerID === f.userID)?.status || 'unrequested' })), total, page, limit: 50 } });
    } catch { return res.status(500).json({ error: true, message: 'Unable to load raid followers' }); }
});

router.post('/:channelID/raid-sessions/:sessionID/bans', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID), sessionID = getParam(req.params.sessionID);
        if (!await validateAccess(req, res, channelID)) return;
        if (!(await getChannelAccessContext(req.user!.id, channelID, 'moderation:manage')).allowed) return res.status(403).json({ error: true, message: 'Moderation permission required' });
        const { confirmed, requestID, userID = '', includeFuture = false } = req.body || {};
        if (confirmed !== true || typeof requestID !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestID)
            || typeof userID !== 'string' || (userID && !/^\d{1,25}$/.test(userID)) || typeof includeFuture !== 'boolean') {
            return res.status(400).json({ error: true, message: 'Confirmation and valid request identity are required' });
        }
        const { requestRaidBans } = await import('../../utils/raid_sessions.js');
        const request = await requestRaidBans(channelID, sessionID, req.user!.id, requestID, userID, includeFuture);
        return res.status(202).json({ error: false, message: 'Raid moderation queued', data: { requestID: request._id, status: request.status } });
    } catch (error) {
        const status = Number((error as { status?: number }).status) || 500;
        return res.status(status).json({ error: true, message: status < 500 ? (error as Error).message : 'Unable to queue raid moderation' });
    }
});

export const followDefenseRoute = router;
