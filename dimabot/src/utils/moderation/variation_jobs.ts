import { createHash } from 'node:crypto';
import Users from '../../schemas/users.schema.js';
import { ModerationVariationCache as Cache, ModerationVariationJob as Jobs, type VariationJob } from '../../schemas/moderation_variation.schema.js';
import type { IModerationRule } from '../../schemas/channel_moderation_settings.schema.js';
import { getDragonflyClient } from '../databases/dragonfly.database.js';
import { paidModeration, MODERATION_RETENTION_DAYS } from './advanced.js';
import { buildVariation, validateVariations, generateMuseVariations, variationKey, variationTerm, VARIATION_MODEL, VARIATION_VERSION, type GeneratedVariation, type VariationMode } from './variations.js';
const lifetime = () => new Date(Date.now() + MODERATION_RETENTION_DAYS * 86400000);
export class VariationError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function savedVariations(channelID: string, terms: string[], priorRules: IModerationRule[] = []): Promise<Map<string, GeneratedVariation>> {
    const entries = new Map<string, GeneratedVariation>();
    for (const rule of priorRules) if (rule.variations?.mode === 'broad') {
        for (const entry of rule.variations.entries) if (entry.version === VARIATION_VERSION) entries.set(entry.term, entry);
    }
    const cached = await Cache.find({ _id: { $in: terms.map(term => variationKey(channelID, term)) }, expiresAt: { $gt: new Date() } }).lean();
    for (const item of cached) entries.set(item.entry.term, item.entry);
    return entries;
}
export async function resolveVariations(channelID: string, terms: string[], mode: VariationMode, priorRules: IModerationRule[]) {
    if (mode === 'off') return { mode, entries: [] };
    if (mode === 'common') {
        const entries = terms.map(term => buildVariation(term));
        validateVariations(entries);
        return { mode, entries };
    }
    const saved = await savedVariations(channelID, terms, priorRules);
    const entries = terms.map(term => saved.get(variationTerm(term)));
    if (entries.some(entry => !entry)) throw new VariationError(409, 'Prepare broader variations for the changed words before saving');
    validateVariations(entries as GeneratedVariation[]);
    return { mode, entries: entries as GeneratedVariation[] };
}
export function variationJobView(job: Pick<VariationJob, '_id' | 'state' | 'entries' | 'error'>) {
    return { id: job._id, state: job.state === 'reserved' ? 'pending' : job.state, entries: job.state === 'completed' ? job.entries : [], error: job.error };
}
export async function requestVariationJob(channelID: string, terms: string[], priorRules: IModerationRule[]) {
    const id = createHash('sha256').update(JSON.stringify([channelID, [...terms].sort(), VARIATION_VERSION])).digest('hex');
    const saved = await savedVariations(channelID, terms, priorRules);
    if (terms.every(term => saved.has(term))) return { id: '', state: 'completed', entries: terms.map(term => saved.get(term)!), error: '' };
    let existing = await Jobs.findById(id).lean();
    if (existing && existing.state !== 'failed') return variationJobView(existing);
    const deadline = new Date(Date.now() + 300_000);
    if (existing) {
        existing = await Jobs.findOneAndUpdate({ _id: id, state: 'failed' }, { $set: { state: 'reserved', error: '', deadline }, $inc: { attempts: 1 } }, { new: true }).lean();
        if (!existing) return variationJobView((await Jobs.findById(id).lean())!);
    } else {
        try {
            await Jobs.create({ _id: id, channelID, terms, state: 'reserved', entries: [], createdAt: new Date(), deadline, expiresAt: lifetime(), model: VARIATION_MODEL, version: VARIATION_VERSION });
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            return variationJobView((await Jobs.findById(id).lean())!);
        }
    }
    const redis = await getDragonflyClient('moderation.variationGeneration');
    const missing = terms.filter(term => !saved.has(term));
    // A platform-funded feature has its own budget; never debit user AI credits.
    const allowed = await redis.eval(`
        local words = tonumber(redis.call('GET', KEYS[1]) or '0')
        local jobs = tonumber(redis.call('GET', KEYS[2]) or '0')
        if words + tonumber(ARGV[1]) > 500 or jobs >= 30 then return 0 end
        redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('INCR', KEYS[2])
        if words == 0 then redis.call('EXPIRE', KEYS[1], 86400) end
        if jobs == 0 then redis.call('EXPIRE', KEYS[2], 86400) end
        return 1
    `, { keys: [`moderation:${channelID}:variation-words`, `moderation:${channelID}:variation-jobs`], arguments: [String(missing.length)] });
    if (!allowed) {
        await Jobs.updateOne({ _id: id, state: 'reserved' }, { $set: { state: 'failed', error: 'daily_limit' } });
        throw new VariationError(429, 'Daily variation-generation limit reached. Saved variations still work; try again tomorrow.');
    }
    // Seed reused entries so edits regenerate only the words that actually changed.
    await Jobs.updateOne({ _id: id, state: 'reserved' }, { $set: { state: 'pending', entries: terms.filter(term => saved.has(term)).map(term => saved.get(term)!) } });
    return variationJobView((await Jobs.findById(id).lean())!);
}

/** Independent bounded task on the cron host, outside chat and semantic-review slots. */
export async function processNextVariationJob(): Promise<boolean> {
    await Jobs.updateMany({ state: { $in: ['reserved', 'pending', 'processing'] }, deadline: { $lte: new Date() } }, { $set: { state: 'failed', error: 'generation_timeout' } });
    const job = await Jobs.findOneAndUpdate({ state: 'pending', deadline: { $gt: new Date() } }, { $set: { state: 'processing' } }, { new: true, sort: { createdAt: 1 } }).lean();
    if (!job) return false;
    try {
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: job.channelID } } }).select('plan_tier').lean();
        if (!paidModeration(owner?.plan_tier)) throw new Error('plan_required');
        const saved = await savedVariations(job.channelID, job.terms);
        for (const entry of job.entries) saved.set(entry.term, entry);
        const missing = job.terms.filter(term => !saved.has(term));
        for (let index = 0; index < missing.length; index += 20) {
            const remaining = job.deadline.getTime() - Date.now();
            if (remaining <= 0) throw new Error('generation_timeout');
            const result = await generateMuseVariations(missing.slice(index, index + 20), AbortSignal.timeout(Math.min(60_000, remaining)));
            // Record actual provider usage even though generation charges zero credits.
            await Jobs.updateOne({ _id: job._id }, { $push: { providerUsage: { model: result.model, ...result.usage } } });
            if (Date.now() >= job.deadline.getTime()) throw new Error('generation_timeout');
            for (const entry of result.entries) {
                saved.set(entry.term, entry);
                await Cache.updateOne({ _id: variationKey(job.channelID, entry.term) }, { $set: { channelID: job.channelID, entry, model: result.model, expiresAt: lifetime() } }, { upsert: true });
            }
        }
        await Jobs.updateOne({ _id: job._id, state: 'processing', deadline: { $gt: new Date() } }, { $set: { state: 'completed', entries: job.terms.map(term => saved.get(term)!), error: '' } });
    } catch (error) {
        const code = error instanceof Error && ['plan_required', 'generation_timeout', 'generation_unavailable'].includes(error.message) ? error.message : 'invalid_generation';
        await Jobs.updateOne({ _id: job._id, state: 'processing' }, { $set: { state: 'failed', error: code } });
    }
    return true;
}
