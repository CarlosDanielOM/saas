import { variationMode, variationTerms, variationAllowSpaces, withVariationSpacing, compileRuleVariations, buildVariation } from '../../utils/moderation/variations.js';
import { requestVariationJob, variationJobView, VariationError } from '../../utils/moderation/variation_jobs.js';
import { ModerationVariationJob } from '../../schemas/moderation_variation.schema.js';
import express, { type Request, type Response } from 'express';
import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import { ChannelModerationSettingsSchema } from '../../schemas/channel_moderation_settings.schema.js';
import { ModerationActionLogSchema } from '../../schemas/moderation_action_log.schema.js';
import { error as logError } from '../../utils/logger.js';
import Users from '../../schemas/users.schema.js';
import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { paidModeration, MODERATION_VISIBLE_DAYS } from '../../utils/moderation/advanced.js';
import { spamProtectionSettings } from '../../utils/moderation/spam.js';
import { ModerationSettingsError, readModerationSettings, saveModerationSettings } from '../services/moderation_settings.service.js';

interface ModerationRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

const router = express.Router();

function getParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || '';
}

async function validateAccess(req: ModerationRequest, res: Response, channelID: string, permission: string | string[]): Promise<{ channelName: string } | null> {
    const requesterID = req.user?.id;

    if (!requesterID) {
        res.status(401).json({ error: true, message: 'Authentication required', status: 401 });
        return null;
    }

    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    if (!streamer) {
        res.status(404).json({ error: true, message: 'Streamer not found', status: 404 });
        return null;
    }

    const access = await getChannelAccessContext(requesterID, channelID, permission);
    if (!access.allowed) {
        res.status(403).json({ error: true, message: 'You do not have permission to manage moderation for this channel', status: 403 });
        return null;
    }

    return { channelName: streamer.name || '' };
}

router.get('/:channelID/settings', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID, 'moderation:view');
        if (!access) return;

        const settings = await readModerationSettings(channelID, access.channelName);

        return res.status(200).json({
            error: false,
            message: 'Moderation settings',
            status: 200,
            data: { ...settings, spamProtection: spamProtectionSettings(settings), rules: settings.rules.map(compileRuleVariations) }
        });
    } catch (err) {
        await logError({ function: 'moderationRoute.getSettings', error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: true, message: 'Unable to load moderation settings', status: 500 });
    }
});

router.put('/:channelID/settings', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID, 'moderation:manage');
        if (!access) return;

        const body = (req.body || {}) as Record<string, unknown>;
        let updated: Awaited<ReturnType<typeof saveModerationSettings>>;
        try { updated = await saveModerationSettings(channelID, access.channelName, body); }
        catch (error) {
            if (error instanceof ModerationSettingsError) return res.status(error.status).json({ error: true, message: error.message, status: error.status });
            throw error;
        }

        return res.status(200).json({
            error: false,
            message: 'Moderation settings saved',
            status: 200,
            data: updated.toObject()
        });
    } catch (err) {
        if (err instanceof VariationError) return res.status(err.status).json({ error: true, status: err.status, message: err.message });
        await logError({ function: 'moderationRoute.putSettings', error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: true, message: 'Unable to save moderation settings', status: 500 });
    }
});

router.post('/:channelID/variations', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        if (!await validateAccess(req, res, channelID, 'moderation:manage')) return;
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
        if (!paidModeration(owner?.plan_tier)) return res.status(403).json({ error: true, message: 'Word variations require Premium or Pro', status: 403 });
        let terms: string[], mode: ReturnType<typeof variationMode>, allowSpaces: boolean;
        try { terms = variationTerms(req.body?.terms); mode = variationMode({ mode: req.body?.mode }); allowSpaces = variationAllowSpaces(req.body?.allowSpaces); }
        catch (error) { return res.status(400).json({ error: true, status: 400, message: error instanceof Error ? error.message : 'Invalid variation request' }); }
        const prior = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
        const data = mode === 'broad' ? await requestVariationJob(channelID, terms, prior?.rules || [])
            : { id: '', state: 'completed', error: '', entries: mode === 'common' ? terms.map(term => buildVariation(term)) : [] };
        return res.json({ error: false, status: 200, data: { ...data, entries: data.entries.map(entry => withVariationSpacing(entry, allowSpaces, mode)) } });
    } catch (error) {
        if (error instanceof VariationError) return res.status(error.status).json({ error: true, status: error.status, message: error.message });
        await logError({ function: 'moderationRoute.variations', error: error instanceof Error ? error.message : String(error) });
        return res.status(503).json({ error: true, status: 503, message: 'Could not prepare word variations. Your saved rules are unchanged.' });
    }
});
router.get('/:channelID/variations/:jobID', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        if (!await validateAccess(req, res, channelID, 'moderation:manage')) return;
        if (req.query.allowSpaces !== undefined && !['true', 'false'].includes(String(req.query.allowSpaces))) return res.status(400).json({ error: true, status: 400, message: 'Invalid spacing option' });
        const job = await ModerationVariationJob.findOne({ _id: getParam(req.params.jobID), channelID }).lean();
        if (!job) return res.status(404).json({ error: true, status: 404, message: 'Variation request not found' });
        return res.json({ error: false, status: 200, data: { ...variationJobView(job), entries: variationJobView(job).entries.map(entry => withVariationSpacing(entry, req.query.allowSpaces === 'true', 'broad')) } });
    } catch {
        return res.status(503).json({ error: true, status: 503, message: 'Could not load word variations' });
    }
});

router.get('/:channelID/logs', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID, 'moderation:view');
        if (!access) return;

        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
        const skip = Math.min(100000, Math.max(0, Math.floor(Number(req.query.skip) || 0)));
        const filter = { channelID, createdAt: { $gte: new Date(Date.now() - MODERATION_VISIBLE_DAYS * 86400000) } };

        const [logs, total] = await Promise.all([
            ModerationActionLogSchema.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            ModerationActionLogSchema.countDocuments(filter)
        ]);

        return res.status(200).json({
            error: false,
            message: 'Moderation action logs',
            status: 200,
            data: { logs, total, limit, skip }
        });
    } catch (err) {
        await logError({ function: 'moderationRoute.getLogs', error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: true, message: 'Unable to load moderation logs', status: 500 });
    }
});

router.get('/:channelID/decisions', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        if (!await validateAccess(req, res, channelID, 'moderation:view')) return;
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
        const skip = Math.min(100000, Math.max(0, Math.floor(Number(req.query.skip) || 0)));
        const filter = { channelID, createdAt: { $gte: new Date(Date.now() - MODERATION_VISIBLE_DAYS * 86400000) } };
        const [decisions, total] = await Promise.all([
            ModerationDecision.find(filter).select('_id username messageText ruleID mode reviewSource verdict status scores consequence createdAt charge.credits')
                .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
            ModerationDecision.countDocuments(filter)
        ]);
        return res.json({ error: false, status: 200, data: { decisions, total, limit, skip } });
    } catch (error) {
        await logError({ function: 'moderationRoute.decisions', error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ error: true, message: 'Unable to load moderation decisions', status: 500 });
    }
});

export const moderationRoute = router;
