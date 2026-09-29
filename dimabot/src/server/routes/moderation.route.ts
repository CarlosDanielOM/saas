import { variationMode, variationTerms, variationOverrides, variationAllowSpaces, withVariationSpacing, compileRuleVariations, buildVariation } from '../../utils/moderation/variations.js';
import { requestVariationJob, resolveVariations, variationJobView, VariationError } from '../../utils/moderation/variation_jobs.js';
import { ModerationVariationJob } from '../../schemas/moderation_variation.schema.js';
import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import {
    ChannelModerationSettingsSchema,
    MODERATION_OFFENSE_DEFAULTS,
    MODERATION_RULE_DEFAULTS,
    MODERATION_SETTINGS_DEFAULTS,
    MAX_ALLOWLIST_DOMAINS,
    MAX_BLACKLIST_TERMS,
    MAX_OFFENSE_WINDOW_SECONDS,
    MAX_RULES_PER_CHANNEL,
    MAX_TIMEOUT_SECONDS,
    MIN_OFFENSE_WINDOW_SECONDS,
    type IChannelModerationSettings,
    type IModerationOffenseStep,
    type IModerationRule
} from '../../schemas/channel_moderation_settings.schema.js';
import { ModerationActionLogSchema } from '../../schemas/moderation_action_log.schema.js';
import { invalidateModerationSettingsCache } from '../../handlers/moderation.handler.js';
import { existingChannelModerationView } from '../../utils/moderation/seed_plan.js';
import { inspectExpression, type PermissionExpression } from '../../utils/permissions/index.js';
import { error as logError } from '../../utils/logger.js';
import Users from '../../schemas/users.schema.js';
import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { parseAdvancedRule, paidModeration, MODERATION_VISIBLE_DAYS } from '../../utils/moderation/advanced.js';

interface ModerationRequest extends Request {
    user?: {
        id: string;
        login: string;
        display_name: string;
        profile_image_url?: string;
    };
}

const router = express.Router();

const RULE_TYPES = new Set(['caps', 'links', 'emote_spam', 'blacklist']);
const RULE_ACTIONS = new Set(['off', 'warn', 'delete', 'timeout', 'ban']);
const CAPS_MODES = new Set(['count', 'percentage']);
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

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

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function parseOffenseStep(raw: unknown, fallback: IModerationOffenseStep): IModerationOffenseStep {
    if (!raw || typeof raw !== 'object') return { ...fallback };

    const step = raw as Record<string, unknown>;
    const action = RULE_ACTIONS.has(String(step.action)) ? String(step.action) as IModerationOffenseStep['action'] : fallback.action;

    return {
        action,
        timeoutSeconds: clampInt(step.timeoutSeconds, 1, MAX_TIMEOUT_SECONDS, fallback.timeoutSeconds)
    };
}

function normalizeDomain(raw: unknown): string | null {
    let value = String(raw || '').trim().toLowerCase();
    if (!value) return null;
    value = value.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    if (!DOMAIN_PATTERN.test(value)) return null;
    return value;
}

function normalizeStringList(raw: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of raw) {
        const value = String(item ?? '').trim().slice(0, maxLength);
        if (!value) continue;
        const dedupeKey = value.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        result.push(value);
        if (result.length >= maxItems) break;
    }

    return result;
}

function sanitizeRule(raw: unknown, index: number): { rule?: IModerationRule; error?: string } {
    if (!raw || typeof raw !== 'object') {
        return { error: `Rule ${index + 1}: invalid rule object` };
    }

    const input = raw as Record<string, unknown>;
    let advanced: ReturnType<typeof parseAdvancedRule>;
    try { advanced = parseAdvancedRule(input); }
    catch (error) { return { error: `Rule ${index + 1}: ${error instanceof Error ? error.message : 'Invalid advanced rule'}` }; }
    let mode: ReturnType<typeof variationMode>;
    let overrides: ReturnType<typeof variationOverrides>;
    let allowSpaces: boolean;
    try {
        mode = variationMode(input.variations);
        allowSpaces = variationAllowSpaces((input.variations as { allowSpaces?: unknown } | undefined)?.allowSpaces);
        overrides = variationOverrides((input.variations as { overrides?: unknown } | undefined)?.overrides, normalizeStringList(input.terms, MAX_BLACKLIST_TERMS, 100), mode);
    }
    catch (error) { return { error: error instanceof Error ? error.message : 'Invalid variations' }; }
    const type = String(input.type || '');
    if (type !== 'blacklist' && mode !== 'off') return { error: 'Word variations require a blocked-word rule' };
    if (!RULE_TYPES.has(type)) {
        return { error: `Rule ${index + 1}: type must be one of caps, links, emote_spam, blacklist` };
    }

    const reason = String(input.reason ?? MODERATION_RULE_DEFAULTS.reason).trim().slice(0, 500);

    const allowlistDomains = normalizeStringList(input.allowlistDomains, MAX_ALLOWLIST_DOMAINS, 100)
        .map(normalizeDomain)
        .filter((domain): domain is string => domain !== null);

    // Exemption mode: null/absent keeps the numeric exemptUserLevel gate;
    // a valid expression is persisted for tag mode; invalid input is
    // rejected outright instead of being silently dropped.
    const exemptExpressionState = inspectExpression(input.exemptExpression);
    if (exemptExpressionState.mode === 'invalid') {
        return { error: `Rule ${index + 1}: invalid permission expression (${exemptExpressionState.error})` };
    }
    const exemptExpression: PermissionExpression | null = exemptExpressionState.mode === 'tags'
        ? exemptExpressionState.expression
        : null;

    const rule: IModerationRule = {
        id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 64) : crypto.randomUUID(),
        type: type as IModerationRule['type'],
        enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
        firstOffense: parseOffenseStep(input.firstOffense, MODERATION_OFFENSE_DEFAULTS.first),
        secondOffense: parseOffenseStep(input.secondOffense, MODERATION_OFFENSE_DEFAULTS.second),
        thirdOffense: parseOffenseStep(input.thirdOffense, MODERATION_OFFENSE_DEFAULTS.third),
        reason: reason || MODERATION_RULE_DEFAULTS.reason,
        exemptUserLevel: clampInt(input.exemptUserLevel, 1, 10, MODERATION_RULE_DEFAULTS.exemptUserLevel),
        exemptExpression,
        capsThresholdMode: CAPS_MODES.has(String(input.capsThresholdMode)) ? String(input.capsThresholdMode) as IModerationRule['capsThresholdMode'] : MODERATION_RULE_DEFAULTS.capsThresholdMode,
        minCapsCount: clampInt(input.minCapsCount, 1, 500, MODERATION_RULE_DEFAULTS.minCapsCount),
        maxCapsPercentage: clampInt(input.maxCapsPercentage, 1, 100, MODERATION_RULE_DEFAULTS.maxCapsPercentage),
        minMessageLength: clampInt(input.minMessageLength, 1, 500, MODERATION_RULE_DEFAULTS.minMessageLength),
        allowlistDomains,
        maxEmoteCount: clampInt(input.maxEmoteCount, 1, 100, MODERATION_RULE_DEFAULTS.maxEmoteCount),
        terms: normalizeStringList(input.terms, MAX_BLACKLIST_TERMS, 100),
        ...advanced,
        variations: { mode, allowSpaces: mode !== 'off' && allowSpaces, entries: [], overrides }
    };

    return { rule };
}

async function getSettings(channelID: string, channelName: string): Promise<IChannelModerationSettings> {
    const settings = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
    if (settings) {
        return settings as IChannelModerationSettings;
    }

    // Never insert on GET. A disabled empty stub would permanently win
    // against first-activation seed ($setOnInsert / create).
    return existingChannelModerationView(channelID, channelName) as IChannelModerationSettings;
}

router.get('/:channelID/settings', authMiddleware as any, async (req: ModerationRequest, res: Response) => {
    try {
        const channelID = getParam(req.params.channelID);
        const access = await validateAccess(req, res, channelID, 'moderation:view');
        if (!access) return;

        const settings = await getSettings(channelID, access.channelName);

        return res.status(200).json({
            error: false,
            message: 'Moderation settings',
            status: 200,
            data: { ...settings, rules: settings.rules.map(compileRuleVariations) }
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

        const rawRules = Array.isArray(body.rules) ? body.rules : [];
        if (rawRules.length > MAX_RULES_PER_CHANNEL) {
            return res.status(400).json({ error: true, message: `A channel can have at most ${MAX_RULES_PER_CHANNEL} moderation rules`, status: 400 });
        }

        const rules: IModerationRule[] = [];
        for (let index = 0; index < rawRules.length; index++) {
            const { rule, error } = sanitizeRule(rawRules[index], index);
            if (error || !rule) {
                return res.status(400).json({ error: true, message: error || `Rule ${index + 1} is invalid`, status: 400 });
            }
            rules.push(rule);
        }

        const current = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
        if (new Set(rules.map(rule => rule.id)).size !== rules.length) {
            return res.status(400).json({ error: true, message: 'Rule IDs must be unique', status: 400 });
        }
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
        if (!paidModeration(owner?.plan_tier)) {
            for (const rule of rules) {
                if (!rule.patterns?.length && !rule.semantic?.enabled && rule.variations?.mode === 'off') continue;
                const prior = current?.rules.find(item => item.id === rule.id);
                // Downgraded channels may keep or disable their saved inactive
                // configuration while editing free rules, but cannot add paid features.
                if (!prior || JSON.stringify(prior.patterns) !== JSON.stringify(rule.patterns) || JSON.stringify(parseAdvancedRule({ type: rule.type, semantic: prior.semantic }).semantic) !== JSON.stringify(rule.semantic)
                    || (prior.variations?.mode ?? 'off') !== rule.variations?.mode
                    || (prior.variations?.allowSpaces ?? false) !== rule.variations?.allowSpaces
                    || JSON.stringify(prior.variations?.overrides ?? []) !== JSON.stringify(rule.variations?.overrides ?? [])
                    || (rule.variations?.mode !== 'off' && JSON.stringify(prior.terms) !== JSON.stringify(rule.terms))) {
                    return res.status(403).json({ error: true, message: 'Regex and contextual moderation require Premium or Pro', status: 403 });
                }
            }
        }

        for (const rule of rules) rule.variations = {
            ...await resolveVariations(channelID, rule.terms, rule.variations!.mode, current?.rules || [], rule.variations!.allowSpaces),
            overrides: rule.variations!.overrides
        };

        const updated = await ChannelModerationSettingsSchema.findOneAndUpdate({
            channelID
        }, {
            $set: {
                channel: access.channelName,
                enabled: typeof body.enabled === 'boolean' ? body.enabled : (current?.enabled ?? MODERATION_SETTINGS_DEFAULTS.enabled),
                offenseWindowSeconds: clampInt(body.offenseWindowSeconds, MIN_OFFENSE_WINDOW_SECONDS, MAX_OFFENSE_WINDOW_SECONDS, current?.offenseWindowSeconds ?? MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds),
                rules
            },
            $inc: { settingsVersion: 1 }
        }, {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true
        });

        await invalidateModerationSettingsCache(channelID);

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
            ModerationDecision.find(filter).select('_id username messageText ruleID mode verdict status scores consequence createdAt charge.credits')
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
