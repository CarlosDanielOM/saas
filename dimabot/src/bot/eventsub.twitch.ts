import crypto from 'crypto';
import express from 'express';
import type { ITwitchEventData, ITwitchSubscriptionData } from '../interfaces/twitch/eventsub.interface.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { endEventsubHandlerMetric, observeEventsubNotification, startEventsubHandlerMetric } from '../utils/observability/bot_runtime_metrics.js';
import { normalizeTwitchEventsubDomainEvent } from '../domain_events/twitch_eventsub_events.js';
import { journalDomainEvent } from '../utils/domain_events.js';

const EVENTSUB_MESSAGE_DEDUPE_TTL_SECONDS = Math.max(300, Number(process.env.TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS || 600));
const EVENTSUB_MESSAGE_MAX_AGE_MS = Math.max(60_000, Number(process.env.TWITCH_EVENTSUB_MESSAGE_MAX_AGE_MS || 10 * 60 * 1000));
const EVENTSUB_PORT = 3333;

export function createTwitchEventsubApp() {
    if (!getSecret()) {
        throw new Error('TWITCH_EVENTSUB_SECRET is not set');
    }
    const app = express();

    const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLocaleLowerCase();
    const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLocaleLowerCase();
    const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLocaleLowerCase();
    const MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'.toLocaleLowerCase();

    //? Notification message types
    const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
    const MESSAGE_TYPE_NOTIFICATION = 'notification';
    const MESSAGE_TYPE_REVOCATION = 'revocation';

    //? Prepend this string to the HMAC that's created from the message
    const HMAC_PREFIX = 'sha256=';
    const HMAC_DIGEST = 'hex';

    app.use(express.raw({ type: 'application/json' }));

    async function claimEventsubMessage(messageId: string): Promise<boolean> {
        if (!messageId) {
            return true;
        }

        try {
            const cache = await getDragonflyClient('TwitchEventsubWebhook');
            const dedupeKey = `twitch:eventsub:message:${messageId}`;
            const result = await cache.set(dedupeKey, new Date().toISOString(), {
                NX: true,
                EX: EVENTSUB_MESSAGE_DEDUPE_TTL_SECONDS
            });

            return result === 'OK';
        } catch (error) {
            console.error('Failed to claim EventSub message dedupe key:', {
                messageId,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            return true;
        }
    }

    app.post('/eventsub', async (req, res) => {
        const messageId = String(req.headers[TWITCH_MESSAGE_ID] || '');
        const messageTimestamp = String(req.headers[TWITCH_MESSAGE_TIMESTAMP] || '');
        const messageSignature = String(req.headers[TWITCH_MESSAGE_SIGNATURE] || '');
        const secret = getSecret();
        const hmac = HMAC_PREFIX + getHmac(secret, messageId, messageTimestamp, req.body);

        if (verifyMessage(hmac, messageSignature) && isFreshMessageTimestamp(messageTimestamp)) {
            let notification: any;
            try {
                notification = JSON.parse(req.body.toString('utf8'));
            } catch {
                res.sendStatus(400);
                return;
            }

            const eventType = String(notification?.subscription?.type || 'unknown');
            const payloadBytes = Buffer.isBuffer(req.body)
                ? req.body.length
                : Buffer.byteLength(String(req.body || ''));

            const messageType = String(req.headers[MESSAGE_TYPE] || '');

            if (MESSAGE_TYPE_VERIFICATION === messageType) {
                if (typeof notification.challenge !== 'string') {
                    res.sendStatus(400);
                    return;
                }
                res.set('Content-Type', 'text/plain').status(200).send(notification.challenge);
                return;
            }

            if (MESSAGE_TYPE_REVOCATION === messageType) {
                if (!notification.subscription) {
                    res.sendStatus(400);
                    return;
                }
                const { revocationHandler } = await import('../handlers/revocation.handler.js');
                const revocationResult = await revocationHandler(notification.subscription as ITwitchSubscriptionData);
                res.sendStatus(revocationResult.error ? 503 : 204);
                return;
            }

            if (MESSAGE_TYPE_NOTIFICATION === messageType) {
                if (!messageId) {
                    res.sendStatus(400);
                    return;
                }
                if (!notification.subscription || !notification.event) {
                    res.sendStatus(400);
                    return;
                }
                observeEventsubNotification(eventType, payloadBytes);

                let durableEvent;
                try {
                    durableEvent = normalizeTwitchEventsubDomainEvent({
                        messageId,
                        messageTimestamp,
                        subscription: notification.subscription,
                        event: notification.event
                    });
                } catch (normalizationError) {
                    console.error('Invalid durable EventSub notification:', {
                        eventType,
                        messageId,
                        error: normalizationError instanceof Error ? normalizationError.message : String(normalizationError),
                        timestamp: new Date().toISOString()
                    });
                    res.sendStatus(400);
                    return;
                }

                if (durableEvent) {
                    try {
                        const journalResult = await journalDomainEvent(durableEvent);
                        if (!journalResult.inserted) {
                            res.sendStatus(204);
                            return;
                        }
                    } catch (journalError) {
                        console.error('Failed to durably journal EventSub notification:', {
                            eventType,
                            messageId,
                            error: journalError instanceof Error ? journalError.message : String(journalError),
                            stack: journalError instanceof Error ? journalError.stack : undefined,
                            timestamp: new Date().toISOString()
                        });
                        res.sendStatus(503);
                        return;
                    }
                } else {
                    const claimed = await claimEventsubMessage(messageId);
                    if (!claimed) {
                        res.sendStatus(204);
                        return;
                    }
                }

                const tracker = startEventsubHandlerMetric(eventType);
                res.sendStatus(204);
                void import('../handlers/eventsub.handler.js')
                    .then(({ eventsubHandler }) => eventsubHandler(
                        notification.subscription as ITwitchSubscriptionData,
                        notification.event as ITwitchEventData
                    ))
                    .then(() => {
                        endEventsubHandlerMetric(tracker, false);
                    })
                    .catch((handlerError) => {
                        endEventsubHandlerMetric(tracker, true);
                        console.error('Error handling EventSub notification:', {
                            eventType,
                            messageId,
                            error: handlerError instanceof Error ? handlerError.message : String(handlerError),
                            stack: handlerError instanceof Error ? handlerError.stack : undefined,
                            timestamp: new Date().toISOString()
                        });
                    });
            } else {
                res.sendStatus(204);
                console.log(`Unknown message type: ${messageType}`);
            }
        } else {
            console.log('Message verification failed');
            console.log('403 Forbidden');
            res.sendStatus(403);
        }
    });

    function getSecret(): string {
        return String(process.env.TWITCH_EVENTSUB_SECRET || '');
    }

    function getHmac(secret: string, messageId: string, timestamp: string, body: Buffer): string {
        return crypto.createHmac('sha256', secret)
            .update(messageId)
            .update(timestamp)
            .update(body)
            .digest(HMAC_DIGEST);
    }

    function verifyMessage(hmac: string, verifySignature: string): boolean {
        if (!hmac || !verifySignature || hmac.length !== verifySignature.length) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
    }

    function isFreshMessageTimestamp(timestamp: string): boolean {
        const parsed = new Date(timestamp).getTime();
        if (!Number.isFinite(parsed)) {
            return false;
        }
        return Math.abs(Date.now() - parsed) <= EVENTSUB_MESSAGE_MAX_AGE_MS;
    }

    return app;
}

export const twitchEventsub = () => {
    const app = createTwitchEventsubApp();
    return app.listen(EVENTSUB_PORT, () => {
        console.log(`App listening on port ${EVENTSUB_PORT}`);
    });
}
