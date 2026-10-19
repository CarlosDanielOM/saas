import express, { type Request, type Response } from 'express';
import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import { FollowRelationshipLedgerSchema } from '../../schemas/follow_relationship_ledger.schema.js';
import { StreamSubscriptionLedgerSchema } from '../../schemas/stream_subscription_ledger.schema.js';
import UsersSchema from '../../schemas/users.schema.js';
import { getCachedLiveStatus } from '../../utils/siteanalytics.js';
import { getDashboardAnalytics, getLiveSessionMetrics } from '../../utils/stream_analytics.js';
import EventsubSchema from '../../schemas/eventsub.schema.js';
import { RaidAnalyticsSummarySchema } from '../../schemas/raid_analytics.schema.js';
import { queueRaidSummary } from '../../utils/raid_analytics.js';
import { DashboardActivitySummarySchema } from '../../schemas/dashboard_activity.schema.js';
import { queueDashboardActivity } from '../../utils/dashboard_activity.js';

import { DashboardInsightsSchema } from '../../schemas/dashboard_insights.schema.js';
import { queueDashboardInsights } from '../../utils/dashboard_insights.js';

interface DashboardRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

type PlanTier = 'free' | 'premium' | 'pro';

function normalizePlanTier(planTier: string | undefined): PlanTier {
    if (planTier === 'premium' || planTier === 'pro') {
        return planTier;
    }

    return 'free';
}

const router = express.Router();

router.get('/:channelID/insights', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID), days = Number(req.query.days || 30);
        const raids = String(req.query.raids || 'exclude');
        if (!/^\d{1,30}$/.test(channelID) || ![7, 30].includes(days) || !['include', 'exclude'].includes(raids)) return res.status(400).json({ error: true, message: 'Invalid insights range' });
        if (!req.user || !(await getAccessContext(req.user.id, channelID)).allowed) return res.status(403).json({ error: true, message: 'Dashboard access required' });
        const state = await DashboardInsightsSchema.findById(channelID).maxTimeMS(1500).lean();
        await queueDashboardInsights(channelID);
        res.set('Cache-Control', 'no-store');
        return res.json({ error: false, data: { summary: state?.expiresAt && state.expiresAt > new Date() ? state.payload?.[`${days}:${raids}`] || null : null,
            updatedAt: state?.updatedAt || null, pending: !state?.payload || !state.expiresAt || state.expiresAt <= new Date(),
            stale: Boolean(state?.error || state?.updatedAt && Date.now() - +state.updatedAt > 900000) } });
    } catch (error) { console.error('Dashboard insights read failed', error); return res.status(500).json({ error: true, message: 'Unable to load insights' }); }
});

router.get('/:channelID/activity', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID), days = Number(req.query.days || 7);
        const emoteScope = String(req.query.emoteScope || 'streamer');
        if (!['streamer', 'all'].includes(emoteScope)) return res.status(400).json({ error: true, message: 'Invalid emote scope' });
        if (!/^\d{1,30}$/.test(channelID) || ![7, 30].includes(days)) return res.status(400).json({ error: true, message: 'Invalid activity range' });
        if (!req.user || !(await getAccessContext(req.user.id, channelID)).allowed) return res.status(403).json({ error: true, message: 'Dashboard access required' });
        const state = await DashboardActivitySummarySchema.findById(channelID).maxTimeMS(1500).lean();
        const period = state?.payload?.[String(days)];
        if (!state || !period?.emoteCatalog) await queueDashboardActivity(channelID);
        const summary = period ? { ...period, emotes: emoteScope === 'streamer' ? period.streamerEmotes ?? [] : period.emotes,
            emoteUses: emoteScope === 'streamer' ? period.streamerEmoteUses ?? null : period.emoteUses, emoteScope } : null;
        if (summary) { delete summary.streamerEmotes; delete summary.streamerEmoteUses; }
        res.set('Cache-Control', 'no-store');
        return res.json({ error: false, data: { summary,
            updatedAt: state?.updatedAt || null, pending: !period?.emoteCatalog || Boolean(state?.dirtyAt && state?.updatedAt && +state.dirtyAt > +state.updatedAt),
            stale: Boolean(state?.error || state?.updatedAt && Date.now() - +state.updatedAt > 180000) } });
    } catch (error) { console.error('Dashboard activity read failed', error); return res.status(500).json({ error: true, message: 'Unable to load activity' }); }
});

router.get('/:channelID/raids', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID), days = Number(req.query.days || 7);
        if (!/^\d{1,30}$/.test(channelID) || ![7, 30].includes(days)) return res.status(400).json({ error: true, message: 'Invalid raid range' });
        if (!req.user || !(await getAccessContext(req.user.id, channelID)).allowed) return res.status(403).json({ error: true, message: 'Dashboard access required' });
        const [state, configs] = await Promise.all([
            RaidAnalyticsSummarySchema.findById(channelID).maxTimeMS(1500).lean(),
            EventsubSchema.find({ channelID, type: 'channel.raid' }).select('enabled condition').maxTimeMS(1500).lean()
        ]);
        if (!state) await queueRaidSummary(channelID);
        res.set('Cache-Control', 'no-store');
        return res.json({ error: false, data: { summary: state?.payload?.[String(days)] || null,
            updatedAt: state?.updatedAt || null, pending: !state?.payload || Boolean(state?.dirtyAt && state?.updatedAt && +state.dirtyAt > +state.updatedAt),
            stale: Boolean(state?.error || state?.updatedAt && Date.now() - +state.updatedAt > 180000),
            tracking: { incoming: configs.some(row => row.enabled && row.condition?.to_broadcaster_user_id === channelID),
                outgoing: configs.some(row => row.enabled && row.condition?.from_broadcaster_user_id === channelID) },
            retentionDays: 90, followWindowMinutes: 5 } });
    } catch (error) { console.error('Raid dashboard read failed', error); return res.status(500).json({ error: true, message: 'Unable to load raids' }); }
});

async function getLiveStatus(channelID: string): Promise<{ isLive: boolean; stream: Record<string, unknown> | null; liveSession: Awaited<ReturnType<typeof getLiveSessionMetrics>> }> {
    const live = await getCachedLiveStatus(channelID);
    const currentViewers = live.stream?.viewer_count ?? 0;
    const liveSession = await getLiveSessionMetrics(channelID, {
        currentViewers
    });

    if (!live.isLive || !live.stream) {
        return {
            isLive: false,
            stream: null,
            liveSession: null
        };
    }

    return {
        isLive: true,
        stream: {
            id: '',
            user_id: channelID,
            user_login: '',
            user_name: '',
            game_name: live.stream.game_name || '',
            title: live.stream.title || '',
            viewer_count: currentViewers,
            started_at: live.stream.started_at || '',
            language: '',
            thumbnail_url: '',
            is_mature: false
        },
        liveSession
    };
}

async function getAccessContext(requesterID: string, channelID: string): Promise<{ allowed: boolean; role: 'owner' | 'admin' | 'none' }> {
    return getChannelAccessContext(requesterID, channelID, 'dashboard:view');
}

async function getChannelChatEnabled(channelID: string, fallback: boolean): Promise<boolean> {
    try {
        const user = await UsersSchema.findOne({
            'accounts.id': channelID,
            'accounts.type': 'twitch'
        }).select('accounts').lean();

        if (!user) {
            return fallback;
        }

        const twitchAccount = user.accounts.find((account) => account.type === 'twitch');
        return twitchAccount?.chat_enabled ?? fallback;
    } catch (error) {
        console.error('Error in getChannelChatEnabled:', {
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return fallback;
    }
}

router.get('/:channelID/access', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(channelIdStr);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const access = await getAccessContext(requesterID, channelIdStr);

        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to view this dashboard',
                status: 403
            });
        }

        return res.status(200).json({
            error: false,
            message: 'Access granted',
            status: 200,
            data: {
                allowed: true,
                role: access.role,
                channelID: channelIdStr,
                channelName: streamer.name,
                planTier: normalizePlanTier(streamer.plan_tier)
            }
        });
    } catch (error) {
        console.error('Error in GET /dashboard/:channelID/access:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/:channelID/live-status', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(channelIdStr);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const access = await getAccessContext(requesterID, channelIdStr);
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to view this dashboard',
                status: 403
            });
        }

        const live = await getLiveStatus(channelIdStr);

        return res.status(200).json({
            error: false,
            message: 'Live status fetched successfully',
            status: 200,
            data: {
                isLive: live.isLive,
                role: access.role,
                checkedAt: new Date().toISOString(),
                stream: live.stream,
                liveSession: live.liveSession
            }
        });
    } catch (error) {
        console.error('Error in GET /dashboard/:channelID/live-status:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/:channelID/bootstrap', authMiddleware as any, async (req: DashboardRequest, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(channelIdStr);
        if (!streamer) {
            return res.status(404).json({
                error: true,
                message: 'Streamer not found',
                status: 404
            });
        }

        const access = await getAccessContext(requesterID, channelIdStr);
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to view this dashboard',
                status: 403
            });
        }

        const cacheChatEnabled = streamer.chat_enabled === 'true';
        const [analytics, live, chatEnabled, totalFollowers, totalSubs] = await Promise.all([
            getDashboardAnalytics(channelIdStr, 30),
            getLiveStatus(channelIdStr),
            getChannelChatEnabled(channelIdStr, cacheChatEnabled),
            FollowRelationshipLedgerSchema.countDocuments({
                followed_id: channelIdStr,
                status: 'active'
            }),
            StreamSubscriptionLedgerSchema.countDocuments({
                streamer_id: channelIdStr,
                status: 'active'
            })
        ]);

        const followersGoal = 1000;
        const subsGoal = 1000;

        return res.status(200).json({
            error: false,
            message: 'Dashboard bootstrap fetched successfully',
            status: 200,
            data: {
                role: access.role,
                channel: {
                    id: channelIdStr,
                    name: streamer.name,
                    chatEnabled
                },
                isLive: live.isLive,
                liveStream: live.stream || null,
                liveSession: live.liveSession,
                kpis: analytics.kpis,
                trend: analytics.trend,
                streamHistory: analytics.streamHistory,
                totalFollowers,
                totalSubs,
                monthlyGoals: {
                    followersGoal,
                    followersCurrent: totalFollowers,
                    subsGoal,
                    subsCurrent: totalSubs
                }
            }
        });
    } catch (error) {
        console.error('Error in GET /dashboard/:channelID/bootstrap:', {
            channelID: req.params.channelID,
            requesterID: req.user?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

export const dashboardRoute = router;
