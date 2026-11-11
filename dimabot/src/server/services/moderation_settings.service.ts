import crypto from 'crypto';
import { variationMode, variationOverrides, variationAllowSpaces } from '../../utils/moderation/variations.js';
import { resolveVariations } from '../../utils/moderation/variation_jobs.js';
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
import { invalidateModerationSettingsCache } from '../../handlers/moderation.handler.js';
import { existingChannelModerationView } from '../../utils/moderation/seed_plan.js';
import { inspectExpression, type PermissionExpression } from '../../utils/permissions/index.js';
import Users from '../../schemas/users.schema.js';
import { parseAdvancedRule, paidModeration } from '../../utils/moderation/advanced.js';
import { spamProtectionSettings, SPAM_RULE_ID } from '../../utils/moderation/spam.js';
import { SPAM_CATEGORIES, DEFAULT_SPAM_THRESHOLD, SPAM_EXEMPT_TAGS, type SpamCategory, type SpamExemptTag } from '../../utils/moderation/spam_categories.js';

/**
 * Chat moderation settings: validation and save shared by `PUT /moderation/:channelID/settings`
 * and the site assistant (`site_agent/tools/write/settings/moderation.ts`).
 */

const RULE_TYPES = new Set(['caps', 'links', 'emote_spam', 'blacklist']);
const RULE_ACTIONS = new Set(['off', 'warn', 'delete', 'timeout', 'ban']);
const CAPS_MODES = new Set(['count', 'percentage']);
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** A rejected save; `status` and `message` are what the route sends. */
export class ModerationSettingsError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
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

export function normalizeDomain(raw: unknown): string | null {
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

export function sanitizeRule(raw: unknown, index: number): { rule?: IModerationRule; error?: string } {
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

/** Saved settings, or the read-only default view. Never inserts (a stub would beat first-activation seeding). */
export async function readModerationSettings(channelID: string, channelName: string): Promise<IChannelModerationSettings> {
    const settings = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
    if (settings) {
        return settings as IChannelModerationSettings;
    }

    // Never insert on GET. A disabled empty stub would permanently win
    // against first-activation seed ($setOnInsert / create).
    return existingChannelModerationView(channelID, channelName) as IChannelModerationSettings;
}

export interface PreparedModerationSettings {
    channel: string;
    enabled: boolean;
    offenseWindowSeconds: number;
    rules: IModerationRule[];
    spamProtection: ReturnType<typeof spamProtectionSettings>;
}

/**
 * Validates a full settings body exactly like the route (same checks, same order, same messages) and
 * returns the `$set` it would write. Reads only. Throws ModerationSettingsError or VariationError.
 */
export async function prepareModerationSettings(channelID: string, channelName: string, body: Record<string, unknown>): Promise<PreparedModerationSettings> {
    const rawRules = Array.isArray(body.rules) ? body.rules : [];
    if (rawRules.length > MAX_RULES_PER_CHANNEL) {
        throw new ModerationSettingsError(400, `A channel can have at most ${MAX_RULES_PER_CHANNEL} moderation rules`);
    }

    const rules: IModerationRule[] = [];
    for (let index = 0; index < rawRules.length; index++) {
        const { rule, error } = sanitizeRule(rawRules[index], index);
        if (error || !rule) {
            throw new ModerationSettingsError(400, error || `Rule ${index + 1} is invalid`);
        }
        rules.push(rule);
    }

    const current = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
    if (rules.some(rule => rule.id === SPAM_RULE_ID)) {
        throw new ModerationSettingsError(400, 'Reserved moderation rule ID');
    }
    let spamProtection = spamProtectionSettings(current || {});
    if (body.spamProtection !== undefined) {
        const raw = body.spamProtection;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || typeof (raw as Record<string, unknown>).enabled !== 'boolean'
            || typeof (raw as Record<string, unknown>).reviewAllMessages !== 'boolean') {
            throw new ModerationSettingsError(400, 'Invalid spam protection settings');
        }
        const options = raw as Record<string, unknown>;
        if (options.exemptTags !== undefined && (!Array.isArray(options.exemptTags)
            || options.exemptTags.some(tag => !SPAM_EXEMPT_TAGS.includes(tag as SpamExemptTag))
            || new Set(options.exemptTags).size !== options.exemptTags.length)) {
            throw new ModerationSettingsError(400, 'Invalid protection exemption tags');
        }
        if (options.categories !== undefined && (!Array.isArray(options.categories)
            || options.categories.some(category => !SPAM_CATEGORIES.includes(category as SpamCategory))
            || new Set(options.categories).size !== options.categories.length)) {
            throw new ModerationSettingsError(400, 'Invalid protection categories');
        }
        if (options.thresholdPercent !== undefined && (typeof options.thresholdPercent !== 'number'
            || !Number.isFinite(options.thresholdPercent) || options.thresholdPercent < 80 || options.thresholdPercent > 100)) {
            throw new ModerationSettingsError(400, 'Protection confidence must be from 80 to 100 percent');
        }
        spamProtection = { ...spamProtection, enabled: options.enabled as boolean, reviewAllMessages: options.reviewAllMessages as boolean,
            exemptTags: options.exemptTags === undefined ? spamProtection.exemptTags : options.exemptTags as SpamExemptTag[],
            categories: options.categories === undefined ? spamProtection.categories : options.categories as SpamCategory[],
            thresholdPercent: options.thresholdPercent === undefined ? spamProtection.thresholdPercent : options.thresholdPercent as number };
    }
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) {
        throw new ModerationSettingsError(400, 'Rule IDs must be unique');
    }
    const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
    if (!paidModeration(owner?.plan_tier)) {
        if (spamProtection.thresholdPercent !== DEFAULT_SPAM_THRESHOLD && spamProtection.thresholdPercent !== current?.spamProtection?.thresholdPercent) {
            throw new ModerationSettingsError(403, 'Custom protection confidence requires Premium or Pro');
        }
        if (spamProtection.reviewAllMessages && !current?.spamProtection?.reviewAllMessages) {
            throw new ModerationSettingsError(403, 'Continuous spam review requires Premium or Pro');
        }
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
                throw new ModerationSettingsError(403, 'Regex and contextual moderation require Premium or Pro');
            }
        }
    }

    for (const rule of rules) rule.variations = {
        ...await resolveVariations(channelID, rule.terms, rule.variations!.mode, current?.rules || [], rule.variations!.allowSpaces),
        overrides: rule.variations!.overrides
    };

    return {
        channel: channelName,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : (current?.enabled ?? MODERATION_SETTINGS_DEFAULTS.enabled),
        offenseWindowSeconds: clampInt(body.offenseWindowSeconds, MIN_OFFENSE_WINDOW_SECONDS, MAX_OFFENSE_WINDOW_SECONDS, current?.offenseWindowSeconds ?? MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds),
        rules,
        spamProtection
    };
}

/** Revision of the stored settings for compare-and-set: every save bumps `settingsVersion`; `updatedAt` also covers the first-activation seed. */
export interface ModerationSettingsRevision {
    settingsVersion: number | null;
    updatedAt: Date | string | null;
}

/** The revision of a `readModerationSettings` result, or null when the channel has no settings document yet. */
export function moderationSettingsRevision(settings: Partial<IChannelModerationSettings> & { _id?: unknown; updatedAt?: Date | string }): ModerationSettingsRevision | null {
    if (!settings._id) return null;
    return { settingsVersion: settings.settingsVersion ?? null, updatedAt: settings.updatedAt ?? null };
}

/**
 * Compare-and-set save for the site assistant: the same validation, write and cache invalidation as
 * `saveModerationSettings`, but the write only lands while the stored settings still have `revision`
 * (null = no document yet: it only creates one). Returns null when they changed in between (nothing written).
 */
export async function saveModerationSettingsIfUnchanged(channelID: string, channelName: string, body: Record<string, unknown>, revision: ModerationSettingsRevision | null) {
    const prepared = await prepareModerationSettings(channelID, channelName, body);
    let updated;
    if (revision) {
        updated = await ChannelModerationSettingsSchema.findOneAndUpdate({
            channelID,
            settingsVersion: revision.settingsVersion,
            updatedAt: revision.updatedAt === null ? null : new Date(revision.updatedAt)
        }, {
            $set: prepared,
            $inc: { settingsVersion: 1 }
        }, {
            new: true
        });
        if (!updated) return null;
    } else {
        // Same document the route's first save upserts ($inc on a missing settingsVersion gives 1).
        try {
            updated = await ChannelModerationSettingsSchema.create({ channelID, ...prepared, settingsVersion: 1 });
        } catch (error) {
            if ((error as { code?: number }).code === 11000) return null;
            throw error;
        }
    }

    await invalidateModerationSettingsCache(channelID);
    return updated;
}

/** Validates, saves (bumping settingsVersion) and invalidates the bot's settings cache. */
export async function saveModerationSettings(channelID: string, channelName: string, body: Record<string, unknown>) {
    const prepared = await prepareModerationSettings(channelID, channelName, body);
    const updated = await ChannelModerationSettingsSchema.findOneAndUpdate({
        channelID
    }, {
        $set: prepared,
        $inc: { settingsVersion: 1 }
    }, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
    });

    await invalidateModerationSettingsCache(channelID);
    return updated;
}
