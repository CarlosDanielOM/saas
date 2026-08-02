import express, { type Request, type Response } from 'express';
import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import { FollowAttackLogSchema } from '../../schemas/follow_attack_log.schema.js';
import { FollowDefenseSettingsSchema, type FollowDefenseLanguage, type IFollowDefenseSettings } from '../../schemas/follow_defense_settings.schema.js';
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
    silentThresholdX: number;
    silentWindowYSeconds: number;
    protectionThresholdB: number;
    attackThreshold: number;
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
    silentThresholdX: 10,
    silentWindowYSeconds: 5,
    protectionThresholdB: 100,
    attackThreshold: 500,
    silentDurationSeconds: 60,
    baselineFollowsPerHour: null as number | null,
    language: 'en' as FollowDefenseLanguage,
    settingsVersion: 1
};

const BOOLEAN_FIELDS = new Set([
    'enabled',
    'silentModeEnabled',
    'protectionModeEnabled',
    'attackModeEnabled'
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
        silentThresholdX: settings.silentThresholdX || DEFAULT_SETTINGS.silentThresholdX,
        silentWindowYSeconds: settings.silentWindowYSeconds || DEFAULT_SETTINGS.silentWindowYSeconds,
        protectionThresholdB: settings.protectionThresholdB || DEFAULT_SETTINGS.protectionThresholdB,
        attackThreshold: settings.attackThreshold || DEFAULT_SETTINGS.attackThreshold,
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
            if (key === 'baselineFollowsPerHour' && (value === null || value === '')) {
                patch.baselineFollowsPerHour = null;
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
        const patch = buildSettingsPatch(req.body as Record<string, unknown>);

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

        const settings = await getOrCreateSettings(channelID, access.channelName);
        if (!settings.enabled || !settings.attackModeEnabled) {
            return res.status(409).json({
                error: true,
                message: 'Follow Defense attack mode is disabled for this channel',
                status: 409
            });
        }

        await triggerFollowDefenseAttackMode(channelID, access.channelName.toLowerCase(), access.channelName);

        return res.status(202).json({
            error: false,
            message: 'Attack mode activation queued',
            status: 202,
            data: {
                success: true,
                mode: 'attack'
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

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/reset', authMiddleware as any, async (req: FollowDefenseRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID);
        if (!access) return;

        const cache = await getDragonflyClient('followDefenseRoute.reset');
        const keys = followDefenseKeys(channelID);
        await cache.del([keys.state, keys.tracked, keys.recent]);
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

export const followDefenseRoute = router;
