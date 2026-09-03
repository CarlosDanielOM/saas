import express, { type Response } from 'express';
import { Types } from 'mongoose';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { hasGlobalChannelOwnerAccess } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import UsersSchema from '../../schemas/users.schema.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import { ClipRecommendationConfigSchema } from '../../schemas/clip_recommendation_config.schema.js';
import { ClipRecommendationSchema } from '../../schemas/clip_recommendation.schema.js';
import { enqueueClipRecommendationJob } from '../../utils/ai/clip_recommendations/clip_recommendations_queue.js';
import {
    calculateClipRecommendationCredits,
    fetchLatestVodForChannel,
    fetchRecentVodsForChannel,
    fetchVodById
} from '../../utils/ai/clip_recommendations/vod_clip_recommendation_runner.js';

const router = express.Router();

async function checkAccess(requesterID: string, channelID: string): Promise<boolean> {
    if (requesterID === channelID) return true;
    if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) return true;
    const admin = await AdminSchema.findOne({
        channelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: ['*', 'dashboard:view'] }
    }).lean().exec();
    return !!admin;
}

function getRequesterID(req: AuthRequest): string {
    return String(req.user?.id || '').trim();
}

function parseBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
        : fallback;
}

async function getChannelUser(channelID: string) {
    return UsersSchema.findOne({ 'accounts.id': channelID, 'accounts.type': 'twitch' }).lean().exec();
}

router.get('/:channelID/config', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });

        const [config, user] = await Promise.all([
            ClipRecommendationConfigSchema.findOne({ channelID }).lean().exec(),
            getChannelUser(channelID)
        ]);

        return res.status(200).json({
            error: false,
            message: 'Clip recommendation config fetched successfully',
            status: 200,
            data: {
                autoAnalyzeEnabled: Boolean(config?.autoAnalyzeEnabled && user?.plan_tier === 'pro'),
                canAutoAnalyze: user?.plan_tier === 'pro',
                planTier: user?.plan_tier || 'free',
                lastAnalyzedAt: config?.lastAnalyzedAt || null,
                pricing: {
                    baseCredits: 2750,
                    baseMinutes: 60,
                    extraCreditsPerMinute: 50
                }
            }
        });
    } catch (error) {
        console.error('Error in GET /clip-recommendations/:channelID/config:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.put('/:channelID/config', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });

        const user = await getChannelUser(channelID);
        if (!user) return res.status(404).json({ error: true, message: 'User not found', status: 404 });

        if (typeof req.body?.autoAnalyzeEnabled !== 'boolean') {
            return res.status(400).json({ error: true, message: 'autoAnalyzeEnabled must be a boolean', status: 400 });
        }
        const autoAnalyzeEnabled = req.body.autoAnalyzeEnabled;
        if (autoAnalyzeEnabled && user.plan_tier !== 'pro') {
            return res.status(403).json({
                error: true,
                message: 'Automatic VOD clip recommendations are only available on Pro',
                status: 403
            });
        }

        const config = await ClipRecommendationConfigSchema.findOneAndUpdate(
            { channelID },
            { $set: { autoAnalyzeEnabled } },
            { upsert: true, new: true }
        ).lean().exec();

        return res.status(200).json({
            error: false,
            message: 'Clip recommendation config updated successfully',
            status: 200,
            data: config
        });
    } catch (error) {
        console.error('Error in PUT /clip-recommendations/:channelID/config:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });

        const limit = parseBoundedInteger(req.query.limit, 10, 1, 50);
        const skip = parseBoundedInteger(req.query.skip, 0, 0, 10_000);
        const [items, total] = await Promise.all([
            ClipRecommendationSchema.find({ channelID }).sort({ created_at: -1 }).skip(skip).limit(limit).lean().exec(),
            ClipRecommendationSchema.countDocuments({ channelID }).exec()
        ]);

        return res.status(200).json({
            error: false,
            message: 'Clip recommendations fetched successfully',
            status: 200,
            data: { items, total }
        });
    } catch (error) {
        console.error('Error in GET /clip-recommendations/:channelID:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/queue', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });

        const requestedVodId = String(req.body?.vodId || '').trim();
        if (requestedVodId && !/^\d{1,30}$/.test(requestedVodId)) {
            return res.status(400).json({ error: true, message: 'Invalid Twitch VOD ID', status: 400 });
        }
        const [vod, user] = await Promise.all([
            requestedVodId
                ? fetchVodById(requestedVodId, channelID)
                : fetchLatestVodForChannel(channelID),
            getChannelUser(channelID)
        ]);
        if (!user) return res.status(404).json({ error: true, message: 'User not found', status: 404 });
        if (!vod) return res.status(404).json({ error: true, message: 'No recent VOD was found for this channel', status: 404 });

        const durationMinutes = vod.durationMinutes || Number(req.body?.vodDurationMinutes || 0) || 60;
        const estimatedCostCredits = calculateClipRecommendationCredits(durationMinutes);
        const account = user.accounts.find((item) => item.type === 'twitch' && item.id === channelID);
        const result = await enqueueClipRecommendationJob({
            channelID,
            channel: account?.name || user.name || '',
            sessionID: String(req.body?.sessionID || ''),
            streamID: String(req.body?.streamID || ''),
            vodID: vod.id,
            vodUrl: vod.url,
            source: 'manual',
            requestedBy: requesterID,
            vodDurationMinutes: durationMinutes,
            notBeforeUnix: Math.floor(Date.now() / 1000) + 15
        });

        return res.status(result.enqueued ? 202 : 409).json({
            error: !result.enqueued,
            message: result.message,
            status: result.enqueued ? 202 : 409,
            data: {
                ...result,
                vod,
                estimatedCostCredits
            }
        });
    } catch (error) {
        console.error('Error in POST /clip-recommendations/:channelID/queue:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/vods', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });

        const days = parseBoundedInteger(req.query?.days, 7, 1, 60);
        const vods = await fetchRecentVodsForChannel(channelID, days);

        return res.status(200).json({
            error: false,
            message: 'Recent VODs fetched successfully',
            status: 200,
            data: {
                days,
                vods
            }
        });
    } catch (error) {
        console.error('Error in GET /clip-recommendations/:channelID/vods:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/:recommendationID/candidates/:candidateID/:action', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID || '').trim();
        const recommendationID = String(req.params.recommendationID || '').trim();
        const candidateID = String(req.params.candidateID || '').trim();
        const action = String(req.params.action || '').trim();
        const requesterID = getRequesterID(req);
        if (!requesterID) return res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        if (!(await checkAccess(requesterID, channelID))) return res.status(403).json({ error: true, message: 'Forbidden: access denied', status: 403 });
        if (!Types.ObjectId.isValid(recommendationID) || !Types.ObjectId.isValid(candidateID)) {
            return res.status(400).json({ error: true, message: 'Invalid recommendation or candidate ID', status: 400 });
        }
        if (!['confirm', 'deny'].includes(action)) {
            return res.status(400).json({ error: true, message: 'Invalid action', status: 400 });
        }

        const status = action === 'confirm' ? 'confirmed' : 'denied';
        const recommendation = await ClipRecommendationSchema.findOneAndUpdate(
            { _id: new Types.ObjectId(recommendationID), channelID, 'candidates._id': new Types.ObjectId(candidateID) },
            { $set: { 'candidates.$.status': status } },
            { new: true }
        ).lean().exec();

        if (!recommendation) {
            return res.status(404).json({ error: true, message: 'Recommendation candidate not found', status: 404 });
        }

        return res.status(200).json({
            error: false,
            message: `Candidate ${status}`,
            status: 200,
            data: recommendation
        });
    } catch (error) {
        console.error('Error in POST /clip-recommendations candidate action:', error);
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

export const clipRecommendationsRoute = router;
