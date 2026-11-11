import express, { type Response } from "express";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { getChannelAccessContext } from "../../middleware/admin.middleware.js";
import {
    getChannelTierInfo,
    getOrCreatePersonality,
    getTierLimits,
    invalidatePersonalityCache,
    updateChannelPersonality,
    type UpdatePersonalityRequest
} from "../services/ai_personality.service.js";

interface AddKnownUserRequest {
    username?: string;
    description?: string;
    relationship?: string;
}

const router = express.Router();

router.get('/:channelID', authMiddleware as any, async (req: any, res: Response) => {
        const channelID = Array.isArray(req.params.channelID) ? req.params.channelID[0] : req.params.channelID;

        const access = await getChannelAccessContext(req.user?.id, channelID, 'ai:view');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }

        try {
            const user = await getChannelTierInfo(channelID);
            
            if (!user) {
                return res.status(404).json({
                    error: true,
                    message: 'Channel not found',
                    status: 404
                });
            }

            const personality = await getOrCreatePersonality(channelID, user);
            const tierInfo = getTierLimits(user.plan_tier as string | undefined);
            const response = (personality as any).toObject();
            (response as any).tier = tierInfo;

            return res.status(200).json({
                error: false,
                data: response
            });

        } catch (error) {
            console.error('Error in GET /:channelID:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString(),
                channelID
            });

            return res.status(500).json({
                error: true,
                message: 'Error fetching channel personality',
                status: 500
            });
        }
    });

router.put('/:channelID', authMiddleware as any, async (req: any, res: Response) => {
        const channelID = Array.isArray(req.params.channelID) ? req.params.channelID[0] : req.params.channelID;
        const body = req.body as UpdatePersonalityRequest;

        const access = await getChannelAccessContext(req.user?.id, channelID, 'ai:manage');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }

        try {
            const user = await getChannelTierInfo(channelID);
            
            if (!user) {
                return res.status(404).json({
                    error: true,
                    message: 'Channel not found',
                    status: 404
                });
            }

            const response = await updateChannelPersonality(channelID, user, body);

            return res.status(200).json({
                error: false,
                data: response
            });

        } catch (error) {
            console.error('Error in PUT /:channelID:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString(),
                channelID
            });

            return res.status(500).json({
                error: true,
                message: error instanceof Error ? error.message : 'Error updating channel personality',
                status: 500
            });
        }
    });

router.post('/:channelID/known-users', authMiddleware as any, async (req: any, res: Response) => {
        const channelID = Array.isArray(req.params.channelID) ? req.params.channelID[0] : req.params.channelID;
        const body = req.body as AddKnownUserRequest;

        const access = await getChannelAccessContext(req.user?.id, channelID, 'ai:manage');
        if (!access.allowed) {
            return res.status(403).json({
                error: true,
                message: 'You do not have access to this channel',
                status: 403
            });
        }

        if (!body.username) {
            return res.status(400).json({
                error: true,
                message: 'Username is required',
                status: 400
            });
        }

        try {
            const user = await getChannelTierInfo(channelID);
            
            if (!user) {
                return res.status(404).json({
                    error: true,
                    message: 'Channel not found',
                    status: 404
                });
            }

            const personality = await getOrCreatePersonality(channelID, user);

            const currentCount = personality.knownUsers ? personality.knownUsers.length : 0;
            
            if (user.plan_tier !== 'pro') {
                if (user.plan_tier === 'premium' && currentCount >= 10) {
                    return res.status(400).json({
                        error: true,
                        message: 'Premium channels can only have up to 10 known users',
                        status: 400,
                        type: 'tier_limit'
                    });
                }
                
                if (user.plan_tier !== 'premium' && currentCount >= 3) {
                    return res.status(400).json({
                        error: true,
                        message: 'Free channels can only have up to 3 known users',
                        status: 400,
                        type: 'tier_limit'
                    });
                }
            }

            const knownUsersArray = (personality as any).knownUsers || [];
            const existingIndex = knownUsersArray.findIndex((u: any) => u.username === body.username);
            
            if (existingIndex >= 0) {
                knownUsersArray[existingIndex] = {
                    username: body.username,
                    description: body.description || '',
                    relationship: body.relationship || '',
                    lastInteraction: new Date()
                };
            } else {
                knownUsersArray.push({
                    username: body.username,
                    description: body.description || '',
                    relationship: body.relationship || '',
                    lastInteraction: new Date()
                });
            }

            (personality as any).knownUsers = knownUsersArray;
            (personality as any).updatedAt = new Date();
            await (personality as any).save();

            // Invalidate cache so next read gets fresh data
            await invalidatePersonalityCache(channelID);

            return res.status(200).json({
                error: false,
                data: personality
            });

        } catch (error) {
            console.error('Error in POST /:channelID/known-users:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString(),
                channelID
            });

            return res.status(500).json({
                error: true,
                message: error instanceof Error ? error.message : 'Error updating known user',
                status: 500
            });
        }
    });

export const aiPersonalityRoute = router;
