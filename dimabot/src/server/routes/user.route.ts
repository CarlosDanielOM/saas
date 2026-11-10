import express, { type Request, type Response } from "express";
import UsersSchema from "../../schemas/users.schema.js";
import TwitchStreamers from "../../classes/twitch_streamers.class.js";
import { getTwitchUserByLogin } from "../../functions/users/get_user_by_login.users.js";
import { getScopes } from "../../functions/users/get_scopes.users.js";
import { getDragonflyClient } from "../../utils/databases/dragonfly.database.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { hasGlobalChannelOwnerAccess } from "../../middleware/admin.middleware.js";
import { error as logError } from "../../utils/logger.js";
import { incrementSiteAnalytics, decrementSiteAnalytics } from "../../utils/siteanalytics.js";
import EventsubSchema from "../../schemas/eventsub.schema.js";
import { subscribeTwitchEvent, unsubscribeTwitchEvent } from "../../utils/eventsub.js";

interface UserRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
        try {
            const username = req.query.username as string;

            if (!username) {
                return res.status(400).json({
                    error: true,
                    message: 'Missing username parameter',
                    status: 400
                });
            }

            const userData = await getTwitchUserByLogin(username);

            if (userData.error) {
                return res.status(userData.status || 500).json(userData);
            }

            const dataToSend = {
                username: userData.data!.login,
                id: userData.data!.id,
                display_name: userData.data!.display_name,
                profile_image_url: userData.data!.profile_image_url,
                offline_image_url: userData.data!.offline_image_url,
            };

            return res.status(200).json({
                error: false,
                data: dataToSend,
                status: 200
            });
        } catch (error) {
            console.error('Error in GET /:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString(),
                query: req.query
            });

            res.status(500).json({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });

router.get('/:channelID', async (req: Request, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;

            const streamer = await TwitchStreamers.getTwitchAccountById(channelIdStr);

            if (!streamer) {
                return res.status(404).json({ error: true, message: 'Streamer not found' });
            }

            const streamerResponse = {
                id: streamer.id,
                name: streamer.name,
                actived: streamer.actived,
                chat_enabled: streamer.chat_enabled
            };

            return res.status(200).json({ error: false, streamer: streamerResponse });
        } catch (error) {
            console.error('Error in GET /:channelID:', {
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

router.get('/scopes/:userID', async (req: Request, res: Response) => {
        try {
            const { userID } = req.params;
            const userIdStr = Array.isArray(userID) ? userID[0] : userID;

            const scopesResult = await getScopes(userIdStr);

            if (scopesResult.error) {
                await logError({ error: true, message: 'Error fetching scopes', userID: userIdStr, scopes: scopesResult }, { channelId: userIdStr, destination: 'both' });
                return res.status(scopesResult.status || 500).json(scopesResult);
            }

            return res.status(200).json({
                error: false,
                message: 'Scopes fetched successfully',
                status: 200,
                data: scopesResult.data
            });
        } catch (error) {
            console.error('Error in GET /scopes/:userID:', {
                userID: req.params.userID,
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

router.post('/premium', async (req: Request, res: Response) => {
        try {
            const { channel, channelID } = req.body;

            const user = await UsersSchema.findOne({
                'accounts.name': channel,
                'accounts.id': channelID
            }).select('plan_tier').lean();

            if (!user) {
                return res.status(400).json({ error: true, message: 'Channel not found' });
            }

            let premium: string;
            if (user.plan_tier === 'pro') {
                premium = 'premium_plus';
            } else if (user.plan_tier === 'premium') {
                premium = 'premium';
            } else {
                premium = 'none';
            }

            const message = `Channel is ${premium === 'none' ? 'not premium' : premium}`;

            return res.status(200).json({ error: false, message, premium });
        } catch (error) {
            console.error('Error in POST /premium:', {
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

router.get('/active/:channel', async (req: Request, res: Response) => {
        try {
            const { channel } = req.params;

            const user = await UsersSchema.findOne({ 'accounts.name': channel }).select('accounts').lean();

            if (!user) {
                return res.status(404).json({ message: 'Channel not found', error: true });
            }

            const twitchAccount = user.accounts.find(acc => acc.type === 'twitch');

            if (!twitchAccount) {
                return res.status(404).json({ message: 'Twitch account not found', error: true });
            }

            if (twitchAccount.actived) {
                return res.status(200).json({ message: 'Channel is active', active: true, error: false });
            } else {
                return res.status(200).json({ message: 'Channel is not active', active: false, error: false });
            }
        } catch (error) {
            console.error('Error in GET /active/:channel:', {
                channel: req.params.channel,
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

router.put('/active/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const { active } = req.body;
            const requesterID = (req as UserRequest).user?.id;

            if (!requesterID) {
                return res.status(401).json({ message: 'Authentication required', error: true, status: 401 });
            }

            if (requesterID !== channelIdStr && !(await hasGlobalChannelOwnerAccess(requesterID, channelIdStr))) {
                return res.status(403).json({ message: 'Only the channel owner can toggle active status', error: true, status: 403 });
            }

            if (typeof active !== 'boolean') {
                return res.status(400).json({ message: 'Active parameter must be a boolean', error: true });
            }

            await UsersSchema.findOneAndUpdate(
                { 'accounts.id': channelIdStr },
                { $set: { 'accounts.$.actived': active } }
            );

            if (active) {
                await incrementSiteAnalytics('active', 1);
            } else {
                await decrementSiteAnalytics('active', 1);
            }

            try {
                await fetch('http://localhost:3355/user/active', {
                    method: 'PUT',
                    body: JSON.stringify({ channelID: channelIdStr, active })
                });
            } catch (e) {
                await logError({ error: true, message: "Error on the localhost http request", channelID: channelIdStr, caughtError: e }, { channelId: channelIdStr, destination: 'both' });
            }

            return res.status(200).json({ message: 'Channel active status updated', error: false });
        } catch (error) {
            console.error('Error in PUT /active/:channelID:', {
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

router.post('/chat/:channelID', authMiddleware as any, async (req: UserRequest, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const { enabled } = req.body;
            const requesterID = req.user?.id;

            if (!requesterID) {
                return res.status(401).json({
                    message: 'Authentication required',
                    error: true,
                    status: 401
                });
            }

            if (requesterID !== channelIdStr && !(await hasGlobalChannelOwnerAccess(requesterID, channelIdStr))) {
                return res.status(403).json({
                    message: 'Only the channel owner can toggle chat bot status',
                    error: true,
                    status: 403
                });
            }

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({
                    message: 'Enabled parameter must be a boolean',
                    error: true
                });
            }

            const user = await UsersSchema.findOne({ 'accounts.id': channelIdStr });

            if (!user) {
                return res.status(404).json({
                    message: 'Channel not found',
                    error: true
                });
            }

            let eventsubRemovedCount = 0;
            let eventsubCreated = false;
            let eventsubRemovalFailed = 0;

            if (!enabled) {
                const chatEventsubs = await EventsubSchema.find({
                    channelID: channelIdStr,
                    type: 'channel.chat.message'
                }).lean();

                for (const chatEventsub of chatEventsubs) {
                    const result = await unsubscribeTwitchEvent(chatEventsub.id);
                    if (!(result as any)?.error) {
                        eventsubRemovedCount += 1;
                    } else {
                        eventsubRemovalFailed += 1;
                    }
                }

                if (eventsubRemovalFailed > 0) {
                    return res.status(502).json({
                        message: 'Failed to remove one or more chat event subscriptions',
                        error: true,
                        status: 502,
                        data: {
                            eventsubRemovedCount,
                            eventsubRemovalFailed
                        }
                    });
                }
            } else {
                const existingChatEventsub = await EventsubSchema.findOne({
                    channelID: channelIdStr,
                    type: 'channel.chat.message'
                }).lean();

                if (!existingChatEventsub) {
                    // App token only: a streamer who just signed in has no stored broadcaster
                    // token. Twitch accepts it when they granted `channel:bot` at sign-in (or the
                    // bot is a moderator, which full activation sets up).
                    const response = await subscribeTwitchEvent(
                        channelIdStr,
                        'channel.chat.message',
                        '1',
                        {
                            broadcaster_user_id: channelIdStr,
                            user_id: '698614112'
                        },
                        undefined,
                        { appAuthOnly: true }
                    );

                    if ((response as any)?.error && (response as any)?.status === 403) {
                        // Twitch: "subscription missing proper authorization". Either the streamer
                        // never approved `channel:bot`, or the bot account's own approval is
                        // missing. Only the first can be fixed by the streamer signing in again.
                        const grants = await getScopes(channelIdStr);
                        if (grants.error || !Array.isArray(grants.data)) {
                            // Can't tell which side is missing: don't send the streamer through sign-in again.
                            return res.status(503).json({
                                message: 'Could not check the Twitch approval, please try again',
                                error: true,
                                status: 503,
                                code: 'chat_check_failed'
                            });
                        }
                        const scopes: unknown = grants.data[0]?.scopes;
                        if (Array.isArray(scopes) && scopes.includes('channel:bot')) {
                            console.error('Error in POST /chat/:channelID: Twitch refused chat although channel:bot is granted', {
                                channelID: channelIdStr,
                                message: (response as any)?.message,
                                timestamp: new Date().toISOString()
                            });
                            return res.status(502).json({
                                message: 'Twitch refused the bot for this chat',
                                error: true,
                                status: 502,
                                code: 'chat_join_failed'
                            });
                        }
                        // The site asks the streamer to approve chat access on Twitch and tries again.
                        return res.status(403).json({
                            message: 'Twitch has not allowed the bot in this chat yet',
                            error: true,
                            status: 403,
                            code: 'chat_permission_missing'
                        });
                    }

                    if ((response as any)?.error) {
                        return res.status(400).json({
                            message: (response as any).message || 'Failed to create chat eventsub',
                            error: true,
                            status: (response as any).status || 400
                        });
                    }

                    eventsubCreated = true;
                }
            }

            await UsersSchema.findOneAndUpdate(
                { 'accounts.id': channelIdStr },
                { $set: { 'accounts.$.chat_enabled': enabled } }
            );

            const cache = await getDragonflyClient();
            await cache.hSet(`accounts:twitch:${channelIdStr}:data`, 'chat_enabled', enabled ? 'true' : 'false');

            await TwitchStreamers.updateTwitchAccountsInCache();

            res.status(200).json({
                message: `Chat ${enabled ? 'enabled' : 'disabled'} for channel`,
                error: false,
                status: 200,
                data: {
                    chatEnabled: enabled,
                    eventsubRemovedCount,
                    eventsubCreated,
                    eventsubRemovalFailed
                }
            });
        } catch (error) {
            console.error('Error in POST /chat/:channelID:', {
                channelID: req.params.channelID,
                requesterID: req.user?.id,
                body: req.body,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).json({
                message: 'Error updating chat status',
                error: true
            });
        }
    });

export const userRoute = router;
