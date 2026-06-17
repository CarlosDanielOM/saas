import express, { type Request, type Response } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { hasGlobalChannelOwnerAccess } from '../../middleware/admin.middleware.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import UsersSchema from '../../schemas/users.schema.js';
import {
  createBillingCheckout,
  createCustomerPortalSession,
  getBillingContext,
  getAiCredits
} from '../../utils/billing.js';

type TargetPlan = 'premium' | 'pro';
type BillingAction = 'auto' | 'new' | 'upgrade' | 'change' | 'reactivate';

const router = express.Router();

async function getAuthenticatedUser(req: Request) {
    const authReq = req as Request & { user?: { id?: string } };
    const twitchUserId = authReq.user?.id;

    if (!twitchUserId) {
        return null;
    }

    return await UsersSchema.findOne({
        'accounts.id': twitchUserId,
        'accounts.type': 'twitch'
    });
}

async function hasDashboardCreditAccess(requesterID: string, channelID: string): Promise<boolean> {
    if (requesterID === channelID) {
        return true;
    }

    if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) {
        return true;
    }

    const admin = await AdminSchema.findOne({
        channelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: ['*', 'dashboard:view'] }
    }).lean();

    return Boolean(admin);
}

function getStringQueryParam(value: unknown): string {
    if (Array.isArray(value)) {
        return String(value[0] || '').trim();
    }

    return typeof value === 'string' ? value.trim() : '';
}

router.get('/context', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const user = await getAuthenticatedUser(req);

        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const targetPlanRaw = req.query.targetPlan;
        const targetPlan = (Array.isArray(targetPlanRaw) ? targetPlanRaw[0] : targetPlanRaw) as TargetPlan | undefined;

        if (targetPlan && !['premium', 'pro'].includes(targetPlan)) {
            return res.status(400).json({
                error: true,
                message: 'Invalid targetPlan. Use premium or pro.',
                status: 400
            });
        }

        const actionRaw = req.query.action;
        const action = (Array.isArray(actionRaw) ? actionRaw[0] : actionRaw) as BillingAction | undefined;

        if (action && !['auto', 'new', 'upgrade', 'change', 'reactivate'].includes(action)) {
            return res.status(400).json({
                error: true,
                message: 'Invalid action. Use auto, new, upgrade, change, or reactivate.',
                status: 400
            });
        }

        const context = await getBillingContext(user, targetPlan, action || 'auto');

        return res.status(200).json({
            error: false,
            message: 'Billing context fetched successfully',
            status: 200,
            data: context
        });
    } catch (error) {
        console.error('Error in GET /billing/context:', {
            query: req.query,
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

router.post('/checkout', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const user = await getAuthenticatedUser(req);

        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const { targetPlan, action, promoCode, successUrl, returnUrl, referralCode } = req.body as {
            targetPlan?: TargetPlan;
            action?: BillingAction;
            promoCode?: string;
            successUrl?: string;
            returnUrl?: string;
            referralCode?: string;
        };

        if (!targetPlan || !['premium', 'pro'].includes(targetPlan)) {
            return res.status(400).json({
                error: true,
                message: 'targetPlan is required and must be premium or pro',
                status: 400
            });
        }

        if (action && !['auto', 'new', 'upgrade', 'change', 'reactivate'].includes(action)) {
            return res.status(400).json({
                error: true,
                message: 'Invalid action. Use auto, new, upgrade, change, or reactivate.',
                status: 400
            });
        }

        const checkout = await createBillingCheckout({
            user,
            targetPlan,
            action: action || 'auto',
            promoCode,
            successUrl,
            returnUrl,
            referralCode
        });

        return res.status(201).json({
            error: false,
            message: 'Checkout created successfully',
            status: 201,
            data: {
                checkoutUrl: checkout.checkoutUrl,
                checkoutId: checkout.checkoutId,
                scenario: checkout.scenario,
                appliedDiscount: {
                    id: checkout.selectedDiscountId,
                    code: checkout.selectedDiscountCode,
                    reason: checkout.selectedDiscountReason
                },
                allowDiscountCodes: checkout.allowDiscountCodes
            }
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const status = /invalid|required|already subscribed/i.test(errorMessage) ? 400 : 500;

        console.error('Error in POST /billing/checkout:', {
            body: req.body,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(status).json({
            error: true,
            message: status === 400 ? errorMessage : 'Internal server error',
            status
        });
    }
});

router.post('/portal', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const user = await getAuthenticatedUser(req);

        if (!user) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const { returnUrl } = req.body as { returnUrl?: string };

        const session = await createCustomerPortalSession({
            user,
            returnUrl
        });

        return res.status(201).json({
            error: false,
            message: 'Customer portal session created successfully',
            status: 201,
            data: {
                sessionId: session.sessionId,
                url: session.url,
                expiresAt: session.expiresAt
            }
        });
    } catch (error) {
        console.error('Error in POST /billing/portal:', {
            body: req.body,
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

router.get('/ai-credits', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const requester = await getAuthenticatedUser(req);

        if (!requester) {
            return res.status(404).json({
                error: true,
                message: 'User not found',
                status: 404
            });
        }

        const authReq = req as Request & { user?: { id?: string } };
        const requesterID = authReq.user?.id || '';
        const requestedChannelID = getStringQueryParam(req.query.channelID) || requesterID;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const canViewCredits = await hasDashboardCreditAccess(requesterID, requestedChannelID);
        if (!canViewCredits) {
            return res.status(403).json({
                error: true,
                message: 'You do not have permission to view this channel credits',
                status: 403
            });
        }

        const targetUser = requesterID === requestedChannelID
            ? requester
            : await UsersSchema.findOne({
                'accounts.id': requestedChannelID,
                'accounts.type': 'twitch'
            });

        if (!targetUser) {
            return res.status(404).json({
                error: true,
                message: 'Target user not found',
                status: 404
            });
        }

        const credits = await getAiCredits(targetUser, requestedChannelID);

        return res.status(200).json({
            error: false,
            message: 'AI credits fetched successfully',
            status: 200,
            data: credits
        });
    } catch (error) {
        console.error('Error in GET /billing/ai-credits:', {
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

export const billingRoute = router;
