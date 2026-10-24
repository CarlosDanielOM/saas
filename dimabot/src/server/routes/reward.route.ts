import express, { type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { RedemptionRewardSchema, type IRedemptionReward } from '../../schemas/redemption_reward.schema.js';
import { getTwitchStreamerHeaderById } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import { createRewardWithEventsub, patchTwitchReward } from '../services/reward_creation.service.js';
import { isTwitchOnlyRewardUpdate, validateRewardSettings } from '../../utils/twitch_reward_body.util.js';

const router = express.Router();

router.get('/twitch/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'rewards:view');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }

        const params = new URLSearchParams();
        params.append('broadcaster_id', channelIdStr);

        const streamerHeaderResult = await getTwitchStreamerHeaderById(channelIdStr);

        if (streamerHeaderResult.error || !streamerHeaderResult.header) {
            return res.status(500).json({
                error: true,
                message: streamerHeaderResult.message,
                status: 500
            });
        }

        const response = await fetch(
            getTwitchHelixUrl('channel_points/custom_rewards', params.toString()),
            {
                headers: streamerHeaderResult.header as unknown as Record<string, string>
            }
        );

        const data = await response.json();

        if (data.error) {
            return res.status(400).json({
                error: 'Bad Request',
                message: data.error,
                status: 400
            });
        }

        return res.status(200).json({
            error: false,
            data: data.data,
            total: data.total
        });
    } catch (error) {
        console.error('Error in GET /twitch/:channelID:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'rewards:view');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }

        const { type, id } = req.query;

        if (id) {
            if (!mongoose.Types.ObjectId.isValid(id as string)) {
                return res.status(400).json({
                    error: true,
                    message: 'Invalid ID',
                    status: 400
                });
            }
            const reward = await RedemptionRewardSchema.find({ channelID: channelIdStr, _id: id });
            return res.status(200).json({
                data: reward,
                total: reward.length
            });
        } else if (type) {
            const rewards = await RedemptionRewardSchema.find({ channelID: channelIdStr, type: type });
            return res.status(200).json({
                data: rewards,
                total: rewards.length
            });
        } else {
            const rewards = await RedemptionRewardSchema.find({ channelID: channelIdStr });
            return res.status(200).json({
                data: rewards,
                total: rewards.length
            });
        }
    } catch (error) {
        console.error('Error in GET /:channelID:', {
            channelID: req.params.channelID,
            query: req.query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.post('/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'rewards:manage');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }
        const body = req.body;

        if (!body.title || body.cost === undefined) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Title and cost are required',
                status: 400
            });
        }

        if (body.title.length > 45) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Title is too long',
                status: 400
            });
        }

        if (body.cost < 0) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Cost must be greater than 0',
                status: 400
            });
        }

        const settingsError = validateRewardSettings(body);
        if (settingsError) {
            return res.status(400).json({
                error: 'Bad Request',
                message: settingsError,
                status: 400
            });
        }

        const correlationId = `reward-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await createRewardWithEventsub({
            channelID: channelIdStr,
            body,
            correlationId
        });

        if (result.error || !result.data) {
            return res.status(result.status).json({
                error: true,
                message: result.message,
                status: result.status
            });
        }

        return res.status(201).json({
            error: false,
            data: result.data
        });
    } catch (error) {
        console.error('Error in POST /:channelID:', {
            channelID: req.params.channelID,
            body: req.body,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.delete('/:channelID/:id', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const { channelID, id } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'rewards:manage');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }
        const rewardIdStr = Array.isArray(id) ? id[0] : id;

        let reward = await RedemptionRewardSchema.findOne({ channelID: channelIdStr, rewardID: rewardIdStr });
        if (!reward) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Reward not found',
                status: 404
            });
        }

        const streamerHeaderResult = await getTwitchStreamerHeaderById(channelIdStr);

        if (streamerHeaderResult.error || !streamerHeaderResult.header) {
            return res.status(500).json({
                error: true,
                message: streamerHeaderResult.message,
                status: 500
            });
        }

        let params = new URLSearchParams();
        params.append('broadcaster_id', channelIdStr);
        params.append('id', rewardIdStr);

        let response = await fetch(
            getTwitchHelixUrl('channel_points/custom_rewards', params.toString()),
            {
                method: 'DELETE',
                headers: streamerHeaderResult.header as unknown as Record<string, string>
            }
        );

        if (response.status !== 204) {
            const data = await response.json();
            console.log(`Error deleting reward ${rewardIdStr} for ${channelIdStr}: ${data.error}`);
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Error deleting reward',
                status: 400
            });
        }

        try {
            await RedemptionRewardSchema.deleteOne({ channelID: channelIdStr, rewardID: rewardIdStr });
        } catch (error) {
            console.error('Error deleting reward: ', error);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: 'Error deleting reward',
                status: 500
            });
        }

        return res.status(200).json({
            error: false,
            message: 'Reward deleted',
            status: 200
        });
    } catch (error) {
        console.error('Error in DELETE /:channelID/:id:', {
            channelID: req.params.channelID,
            id: req.params.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.patch('/:channelID/:id', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const { channelID, id } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'rewards:manage');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }
        const rewardIdStr = Array.isArray(id) ? id[0] : id;
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        const settingsError = validateRewardSettings(body);
        if (settingsError) {
            return res.status(400).json({
                error: 'Bad Request',
                message: settingsError,
                status: 400
            });
        }

        let reward = await RedemptionRewardSchema.findOne({ channelID: channelIdStr, rewardID: rewardIdStr });
        if (!reward) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Reward not found',
                status: 404
            });
        }

        const updatedReward = await patchTwitchReward(channelIdStr, body, rewardIdStr);
        if (!updatedReward || updatedReward.error) {
            return res.status(400).json({
                error: 'Bad Request',
                message: updatedReward?.message || updatedReward?.error || 'Twitch rejected the reward update',
                status: 400
            });
        }

        // Limits, pause, colour and queue settings live only on Twitch: nothing to store.
        if (isTwitchOnlyRewardUpdate(body)) {
            return res.status(200).json({
                error: false,
                data: reward,
                twitch: updatedReward
            });
        }

        try {
            let updatedRewardDB = await RedemptionRewardSchema.findOneAndUpdate(
                { channelID: channelIdStr, rewardID: rewardIdStr },
                body,
                { new: true }
            );

            return res.status(200).json({
                error: false,
                data: updatedRewardDB,
                twitch: updatedReward
            });
        } catch (error) {
            console.error('Error updating reward: ', error);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: 'Error updating reward',
                status: 500
            });
        }
    } catch (error) {
        console.error('Error in PATCH /:channelID/:id:', {
            channelID: req.params.channelID,
            id: req.params.id,
            body: req.body,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

export const rewardRoute = router;
