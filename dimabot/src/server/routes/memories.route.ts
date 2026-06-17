import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import {
    listChannelMemories,
    setChannelMemoryStatus,
    updateChannelMemory,
    deleteChannelMemoryPermanently,
    type IListChannelMemoriesParams,
    type ISetChannelMemoryStatusParams,
    type IUpdateChannelMemoryParams,
    type IDeleteChannelMemoryPermanentlyParams
} from "../../utils/ai/memory/memory.service.js";
import type {
    MemoryStatus,
    MemoryType,
    MemoryRisk
} from "../../schemas/channel_ai_memory.schema.js";

const router = express.Router();

function getStringParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] || '';
    }
    return value || '';
}

// GET /memories/:channelID — List memories with filters
router.get('/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelID = getStringParam(req.params.channelID);

        // Parse query params
        const statusParam = String(req.query.status || '');
        const typeParam = String(req.query.type || '');
        const riskParam = String(req.query.risk || '');
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
        const skip = Math.max(0, Number(req.query.skip || 0));

        const statuses: MemoryStatus[] | undefined = statusParam
            ? (statusParam.split(',').map(s => s.trim()) as MemoryStatus[])
            : undefined;

        const types: MemoryType[] | undefined = typeParam
            ? (typeParam.split(',').map(t => t.trim()) as MemoryType[])
            : undefined;

        const risks: MemoryRisk[] | undefined = riskParam
            ? (riskParam.split(',').map(r => r.trim()) as MemoryRisk[])
            : undefined;

        const params: IListChannelMemoriesParams = {
            channelID,
            statuses,
            type: types && types.length === 1 ? types[0] : undefined,
            limit,
            skip
        };

        const result = await listChannelMemories(params);

        if (result.error) {
            res.status(500).json({
                error: true,
                message: result.message || "Failed to list memories"
            });
            return;
        }

        res.status(200).json({
            error: false,
            data: {
                items: result.items,
                total: result.total
            }
        });
    } catch (err) {
        console.error(`Error in GET /memories/:channelID:`, {
            channelID: req.params.channelID,
            query: req.query,
            error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
            error: true,
            message: "Internal server error"
        });
    }
});

// GET /memories/:channelID/:memoryId — Get single memory
router.get('/:channelID/:memoryId', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelID = getStringParam(req.params.channelID);
        const memoryId = getStringParam(req.params.memoryId);

        if (!Types.ObjectId.isValid(memoryId)) {
            res.status(400).json({ error: true, message: "Invalid memory ID" });
            return;
        }

        const params: IListChannelMemoriesParams = {
            channelID,
            statuses: [],
            limit: 200,
            skip: 0
        };

        const { listChannelMemories: listFn } = await import("../../utils/ai/memory/memory.service.js");
        const result = await listFn(params);

        const memory = result.items.find(m => String(m._id) === memoryId);

        if (!memory) {
            res.status(404).json({ error: true, message: "Memory not found" });
            return;
        }

        res.status(200).json({
            error: false,
            data: memory
        });
    } catch (err) {
        console.error(`Error in GET /memories/:channelID/:memoryId:`, {
            channelID: req.params.channelID,
            memoryId: req.params.memoryId,
            error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
            error: true,
            message: "Internal server error"
        });
    }
});

// PATCH /memories/:channelID/:memoryId — Edit memory fields
router.patch('/:channelID/:memoryId', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelID = getStringParam(req.params.channelID);
        const memoryId = getStringParam(req.params.memoryId);
        const { content, summary, type, risk } = req.body as {
            content?: string;
            summary?: string;
            type?: MemoryType;
            risk?: MemoryRisk;
        };

        if (!Types.ObjectId.isValid(memoryId)) {
            res.status(400).json({ error: true, message: "Invalid memory ID" });
            return;
        }

        // Validate type
        const validTypes: MemoryType[] = ['preference', 'running_joke', 'known_user_fact', 'channel_lore', 'boundary'];
        if (type && !validTypes.includes(type)) {
            res.status(400).json({ error: true, message: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
            return;
        }

        // Validate risk
        const validRisks: MemoryRisk[] = ['low', 'medium', 'high'];
        if (risk && !validRisks.includes(risk)) {
            res.status(400).json({ error: true, message: `Invalid risk. Must be one of: ${validRisks.join(', ')}` });
            return;
        }

        const params: IUpdateChannelMemoryParams = {
            channelID,
            memoryID: memoryId,
            content,
            summary,
            type,
            risk
        };

        const result = await updateChannelMemory(params);

        if (result.error || !result.memory) {
            res.status(404).json({
                error: true,
                message: result.message || "Memory not found"
            });
            return;
        }

        res.status(200).json({
            error: false,
            data: result.memory
        });
    } catch (err) {
        console.error(`Error in PATCH /memories/:channelID/:memoryId:`, {
            channelID: req.params.channelID,
            memoryId: req.params.memoryId,
            error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
            error: true,
            message: "Internal server error"
        });
    }
});

// PATCH /memories/:channelID/:memoryId/status — Change memory status
router.patch('/:channelID/:memoryId/status', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelID = getStringParam(req.params.channelID);
        const memoryId = getStringParam(req.params.memoryId);
        const { status, reason } = req.body as {
            status: MemoryStatus;
            reason?: string;
        };

        if (!Types.ObjectId.isValid(memoryId)) {
            res.status(400).json({ error: true, message: "Invalid memory ID" });
            return;
        }

        const validStatuses: MemoryStatus[] = ['candidate', 'pending_review', 'confirmed', 'rejected', 'archived'];
        if (!status || !validStatuses.includes(status)) {
            res.status(400).json({
                error: true,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
            return;
        }

        const reviewer = {
            source: 'streamer' as const,
            username: String((req as any).user?.login || 'unknown'),
            userID: String((req as any).user?.id || 'unknown')
        };

        const params: ISetChannelMemoryStatusParams = {
            channelID,
            memoryID: memoryId,
            status,
            reviewReason: reason || '',
            reviewer
        };

        const result = await setChannelMemoryStatus(params);

        if (result.error || !result.memory) {
            res.status(404).json({
                error: true,
                message: result.message || "Memory not found"
            });
            return;
        }

        res.status(200).json({
            error: false,
            data: result.memory
        });
    } catch (err) {
        console.error(`Error in PATCH /memories/:channelID/:memoryId/status:`, {
            channelID: req.params.channelID,
            memoryId: req.params.memoryId,
            error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
            error: true,
            message: "Internal server error"
        });
    }
});

// DELETE /memories/:channelID/:memoryId — Permanently delete memory
router.delete('/:channelID/:memoryId', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelID = getStringParam(req.params.channelID);
        const memoryId = getStringParam(req.params.memoryId);

        if (!Types.ObjectId.isValid(memoryId)) {
            res.status(400).json({ error: true, message: "Invalid memory ID" });
            return;
        }

        const params: IDeleteChannelMemoryPermanentlyParams = {
            channelID,
            memoryID: memoryId
        };

        const result = await deleteChannelMemoryPermanently(params);

        if (result.error) {
            res.status(404).json({
                error: true,
                message: result.message || "Memory not found"
            });
            return;
        }

        res.status(200).json({
            error: false,
            message: "Memory deleted successfully"
        });
    } catch (err) {
        console.error(`Error in DELETE /memories/:channelID/:memoryId:`, {
            channelID: req.params.channelID,
            memoryId: req.params.memoryId,
            error: err instanceof Error ? err.message : String(err)
        });
        res.status(500).json({
            error: true,
            message: "Internal server error"
        });
    }
});

export const memoriesRoute = router;
