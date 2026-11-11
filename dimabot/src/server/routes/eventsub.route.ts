import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import EventsubSchema from "../../schemas/eventsub.schema.js";
import {
    getEquivalentEventsubTypes,
    SUBSCRIPTION_TYPES
} from "../../utils/eventsub.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { getEventsubAccess } from "../../utils/eventsub_access.js";
import { eventsubHandler } from "../../handlers/eventsub.handler.js";
import { normalizeTwitchEventsubDomainEvent } from "../../domain_events/twitch_eventsub_events.js";
import { journalDomainEvent } from "../../utils/domain_events.js";
import type { ICondition } from '../../schemas/eventsub.schema.js';
import { OUTGOING_RAID_EVENT, isRaidEvent, raidConfigType, raidDirection } from '../../utils/raid_direction.js';
import {
    createChannelEventsub,
    dedupeNormalizedEventsubs,
    deleteChannelEventsub,
    normalizeEventsubResponseType,
    updateChannelEventsub
} from '../services/eventsub_config.service.js';

const router = express.Router();

interface EventsubRequest extends Request {
    user?: {
        id?: string;
    };
}

const getAccess = getEventsubAccess;

// GET /eventsubs/standard - Returns the list of standard eventsub types
router.get('/standard', async (req: Request, res: Response) => {
    try {
        const standardTypes = SUBSCRIPTION_TYPES.map(sub => ({
            type: raidConfigType(sub.type, sub.condition),
            version: sub.version,
            condition: sub.condition,
            config: sub.config || null
        }));

        return res.status(200).send({
            error: false,
            data: {
                standardTypes
            },
            status: 200
        });
    } catch (error) {
        console.error('Error in GET /eventsubs/standard:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).send({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

// POST /eventsubs/:channelID/test - Test an event without going through webhook
router.post('/:channelID/test', authMiddleware as any, async (req: EventsubRequest, res: Response) => {
    try {
        const { channelID } = req.params;
        const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
        const requesterID = req.user?.id;
        const body = req.body as { subscription?: Record<string, unknown>; event?: Record<string, unknown> };

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Unauthorized',
                status: 401
            });
        }

        const access = await getAccess(requesterID, channelIdStr, 'eventsubs:manage');
        if (access === 'none') {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to test eventsubs for this channel',
                status: 403
            });
        }

        if (!body.subscription || !body.event) {
            return res.status(400).send({
                error: true,
                message: 'Missing subscription or event data',
                status: 400
            });
        }

        const subscriptionData = body.subscription as any;
        const eventData = body.event as any;

        const conditionData = subscriptionData.condition && typeof subscriptionData.condition === 'object'
            ? subscriptionData.condition as Record<string, unknown>
            : {};
        const outgoing = subscriptionData.type === 'channel.raid' && raidDirection(conditionData as ICondition) === 'outgoing';
        const addressedChannelIDs = [
            eventData.broadcaster_user_id,
            outgoing ? eventData.from_broadcaster_user_id : eventData.to_broadcaster_user_id,
            conditionData.broadcaster_user_id,
            outgoing ? conditionData.from_broadcaster_user_id : conditionData.to_broadcaster_user_id,
            ...(subscriptionData.type === 'user.update' ? [eventData.user_id, conditionData.user_id] : [])
        ].filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
            .map((value) => String(value).trim());
        if (addressedChannelIDs.some((addressedChannelID) => addressedChannelID !== channelIdStr)) {
            return res.status(400).send({
                error: true,
                message: 'Event broadcaster does not match the requested channel',
                status: 400
            });
        }
        eventData.broadcaster_user_id = channelIdStr;
        if (outgoing) eventData.from_broadcaster_user_id = channelIdStr;
        else if ('to_broadcaster_user_id' in eventData) eventData.to_broadcaster_user_id = channelIdStr;
        if (subscriptionData.type === 'user.update') eventData.user_id = channelIdStr;
        if (subscriptionData.condition && typeof subscriptionData.condition === 'object') {
            if ('broadcaster_user_id' in conditionData) conditionData.broadcaster_user_id = channelIdStr;
            if (outgoing) conditionData.from_broadcaster_user_id = channelIdStr;
            else if ('to_broadcaster_user_id' in conditionData) conditionData.to_broadcaster_user_id = channelIdStr;
            if (subscriptionData.type === 'user.update') conditionData.user_id = channelIdStr;
        }

        const durableEvent = normalizeTwitchEventsubDomainEvent({
            messageId: randomUUID(),
            messageTimestamp: new Date().toISOString(),
            subscription: subscriptionData,
            event: eventData,
            source: 'twitch-eventsub-test'
        });
        if (durableEvent) {
            await journalDomainEvent(durableEvent);
        }

        res.status(202).send({
            error: false,
            message: 'Test event accepted and being processed',
            status: 202
        });

        void eventsubHandler(subscriptionData, eventData).catch((handlerError) => {
            console.error('Error in POST /:channelID/test eventsubHandler:', {
                channelID: channelIdStr,
                eventType: subscriptionData.type,
                error: handlerError instanceof Error ? handlerError.message : String(handlerError),
                stack: handlerError instanceof Error ? handlerError.stack : undefined,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Error in POST /:channelID/test:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        res.status(500).send({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

router.get('/:channelID', authMiddleware as any, async (req: EventsubRequest, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const requesterID = req.user?.id;
            const query = req.query;
            const type = query.type as string | null;
            const id = query.id as string | null;

            if (!requesterID) {
                return res.status(401).json({
                    error: true,
                    message: 'Unauthorized',
                    status: 401
                });
            }

            const access = await getAccess(requesterID, channelIdStr);
            if (access === 'none') {
                return res.status(403).json({
                    error: true,
                    message: 'You do not have permission to view eventsubs for this channel',
                    status: 403
                });
            }

            let eventsub;

            if (id) {
                if (!mongoose.isValidObjectId(id)) {
                    return res.status(400).send({
                        error: 'Invalid ID',
                        message: 'ID is not a valid ObjectID',
                        status: 400
                    });
                }
                eventsub = await EventsubSchema.find({ channelID: channelIdStr, _id: id }).lean();
            } else if (type) {
                eventsub = await EventsubSchema.find({
                    channelID: channelIdStr,
                    type: { $in: getEquivalentEventsubTypes(type === OUTGOING_RAID_EVENT ? 'channel.raid' : type) },
                    ...(isRaidEvent(type) ? { [`condition.${type === OUTGOING_RAID_EVENT ? 'from' : 'to'}_broadcaster_user_id`]: channelIdStr } : {})
                }).lean();
            } else {
                eventsub = await EventsubSchema.find({ channelID: channelIdStr }).lean();
            }

            if (!eventsub || eventsub.length === 0) {
                return res.status(404).send({
                    error: 'Not Found',
                    message: 'No eventsub found',
                    status: 404
                });
            }

            return res.status(200).send({
                error: false,
                data: id ? eventsub.map(normalizeEventsubResponseType) : dedupeNormalizedEventsubs(eventsub),
                total: id ? eventsub.length : dedupeNormalizedEventsubs(eventsub).length
            });
        } catch (error) {
            console.error('Error in GET /:channelID:', {
                channelID: req.params.channelID,
                query: req.query,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });

    router.post('/:channelID', authMiddleware as any, async (req: EventsubRequest, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const requesterID = req.user?.id;

            if (!requesterID) {
                return res.status(401).json({
                    error: true,
                    message: 'Unauthorized',
                    status: 401
                });
            }

            const access = await getAccess(requesterID, channelIdStr, 'eventsubs:manage');
            if (access === 'none') {
                return res.status(403).json({
                    error: true,
                    message: 'You do not have permission to manage eventsubs for this channel',
                    status: 403
                });
            }

            const result = await createChannelEventsub(channelIdStr, req.body as Record<string, unknown>);
            return res.status(result.status).send(result.body);
        } catch (error) {
            console.error('Error in POST /:channelID:', {
                channelID: req.params.channelID,
                body: req.body,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });

router.delete('/:channelID/:id', authMiddleware as any, async (req: EventsubRequest, res: Response) => {
        try {
            const { channelID, id } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const idStr = Array.isArray(id) ? id[0] : id;
            const requesterID = req.user?.id;

            if (!requesterID) {
                return res.status(401).json({
                    error: true,
                    message: 'Unauthorized',
                    status: 401
                });
            }

            const access = await getAccess(requesterID, channelIdStr, 'eventsubs:manage');
            if (access === 'none') {
                return res.status(403).json({
                    error: true,
                    message: 'You do not have permission to manage eventsubs for this channel',
                    status: 403
                });
            }

            const result = await deleteChannelEventsub(channelIdStr, idStr);
            return res.status(result.status).send(result.body);
        } catch (error) {
            console.error('Error in DELETE /:channelID/:id:', {
                channelID: req.params.channelID,
                id: req.params.id,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });

router.patch('/:channelID/:id', authMiddleware as any, async (req: EventsubRequest, res: Response) => {
        try {
            const { channelID, id } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const idStr = Array.isArray(id) ? id[0] : id;
            const requesterID = req.user?.id;

            if (!requesterID) {
                return res.status(401).json({
                    error: true,
                    message: 'Unauthorized',
                    status: 401
                });
            }

            const access = await getAccess(requesterID, channelIdStr, 'eventsubs:manage');
            if (access === 'none') {
                return res.status(403).json({
                    error: true,
                    message: 'You do not have permission to manage eventsubs for this channel',
                    status: 403
                });
            }

            const result = await updateChannelEventsub(channelIdStr, idStr, req.body as Record<string, unknown>);
            return res.status(result.status).send(result.body);
        } catch (error) {
            console.error('Error in PATCH /:channelID/:id:', {
                channelID: req.params.channelID,
                id: req.params.id,
                body: req.body,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });

export const eventsubRoute = router;
