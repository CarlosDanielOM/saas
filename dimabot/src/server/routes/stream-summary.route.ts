import express, { type Response } from "express";
import { Types } from "mongoose";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { hasGlobalChannelOwnerAccess } from "../../middleware/admin.middleware.js";
import type { AuthRequest } from "../../middleware/types.js";
import { ChannelStreamSummarySchema } from "../../schemas/channel_stream_summary.schema.js";
import { AdminSchema } from "../../schemas/admin.schema.js";

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

// GET /stream-summaries/:channelID — List stream summaries with pagination
router.get('/:channelID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID).trim();
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const hasAccess = await checkAccess(requesterID, channelID);
        if (!hasAccess) {
            return res.status(403).json({
                error: true,
                message: 'Forbidden: access denied',
                status: 403
            });
        }

        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
        const skip = Math.max(0, Number(req.query.skip || 0));
        const status = req.query.status ? String(req.query.status).trim() : null;

        const query: Record<string, any> = { channelID };
        if (status) {
            query.status = status;
        }

        const [items, total] = await Promise.all([
            ChannelStreamSummarySchema.find(query)
                .sort({ ended_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
                .exec(),
            ChannelStreamSummarySchema.countDocuments(query).exec()
        ]);

        return res.status(200).json({
            error: false,
            message: 'Stream summaries fetched successfully',
            status: 200,
            data: {
                items,
                total
            }
        });
    } catch (error) {
        console.error('Error in GET /stream-summaries/:channelID:', error);
        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

// GET /stream-summaries/:channelID/:summaryID — Get single detailed stream summary
router.get('/:channelID/:summaryID', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
        const channelID = String(req.params.channelID).trim();
        const summaryID = String(req.params.summaryID).trim();
        const requesterID = req.user?.id;

        if (!requesterID) {
            return res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401
            });
        }

        const hasAccess = await checkAccess(requesterID, channelID);
        if (!hasAccess) {
            return res.status(403).json({
                error: true,
                message: 'Forbidden: access denied',
                status: 403
            });
        }

        if (!Types.ObjectId.isValid(summaryID)) {
            return res.status(400).json({
                error: true,
                message: 'Invalid summary ID',
                status: 400
            });
        }

        const summary = await ChannelStreamSummarySchema.findOne({
            _id: new Types.ObjectId(summaryID),
            channelID
        }).lean().exec();

        if (!summary) {
            return res.status(404).json({
                error: true,
                message: 'Stream summary not found',
                status: 404
            });
        }

        return res.status(200).json({
            error: false,
            message: 'Stream summary fetched successfully',
            status: 200,
            data: summary
        });
    } catch (error) {
        console.error('Error in GET /stream-summaries/:channelID/:summaryID:', error);
        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

export const streamSummaryRoute = router;
