import express, { type Request, type Response } from 'express';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks.js';
import { DOMAIN_EVENT_PRODUCERS, ingestDomainEvent } from '../../../domain_events/domain_event_producers.js';
import type { NormalizePolarWebhookInput } from '../../../domain_events/polar_events.js';

export function createPolarWebhookRouter({
    verify = validateEvent,
    ingest = (input: NormalizePolarWebhookInput) => ingestDomainEvent(DOMAIN_EVENT_PRODUCERS.polar, input)
}: {
    verify?: typeof validateEvent;
    ingest?: (input: NormalizePolarWebhookInput) => Promise<unknown>;
} = {}) {
    const router = express.Router();
    router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
        try {
            const secret = process.env.POLARSH_WEBHOOK_SECRET;
            if (!secret) {
                return res.status(500).json({
                    error: true,
                    message: 'POLARSH_WEBHOOK_SECRET not configured',
                    status: 500
                });
            }
            const normalizedHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (Array.isArray(value)) {
                    normalizedHeaders[key] = value.join(',');
                } else if (typeof value === 'string') {
                    normalizedHeaders[key] = value;
                }
            }
            const event = verify(req.body, normalizedHeaders, secret);
            await ingest({ webhookId: normalizedHeaders['webhook-id'] || '', event });
            return res.status(202).send('');
        } catch (error) {
            console.error('PolarSH webhook error:', error);
            if (error instanceof WebhookVerificationError) {
                return res.status(403).send('');
            }
            return res.status(500).json({
                error: true,
                message: 'Internal server error',
                status: 500
            });
        }
    });
    return router;
}

export const polarshWebhook = createPolarWebhookRouter();
