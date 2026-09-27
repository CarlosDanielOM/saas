import { randomUUID } from 'node:crypto';
import RE2 from 're2';
import { compileBlacklistPattern } from './rules/blacklist.rule.js';
import { foldText } from './normalize.js';

export interface ModerationPattern {
    id: string;
    source: string;
    boundary: 'whole_word' | 'anywhere';
    ignoreCase: boolean;
}
export interface SemanticPolicy {
    enabled: boolean;
    thresholdPercent?: number;
    policy: string;
    examples: Array<{ message: string; label: 'allow' | 'violation' }>;
    onUncertain: 'allow_and_log';
}
export interface ModerationMatch { matcherID: string; text: string; start: number; end: number }
export const emptySemanticPolicy = (): SemanticPolicy => ({ enabled: false, thresholdPercent: 85, policy: '', examples: [], onUncertain: 'allow_and_log' });
export const paidModeration = (tier: unknown): boolean => tier === 'premium' || tier === 'pro';
export const MODERATION_RETENTION_DAYS = 180;
export const MODERATION_VISIBLE_DAYS = 30;
export const SEMANTIC_MODEL = 'respan/span-01-lite';
export const DECISION_POLICY_VERSION = 'contextual-v2';
export const SEMANTIC_DEADLINE_MS = 4_000;
export const ALLOW_THRESHOLD = 0.1;

const compiledPatterns = new Map<string, RE2>();
function compilePattern(pattern: ModerationPattern): RE2 {
    const key = JSON.stringify(pattern);
    const cached = compiledPatterns.get(key);
    if (cached) return cached;
    const source = pattern.boundary === 'whole_word'
        ? `(^|[^\\p{L}\\p{N}])(${pattern.source})($|[^\\p{L}\\p{N}])` : pattern.source;
    const compiled = new RE2(source, pattern.ignoreCase ? 'iu' : 'u');
    if (compiledPatterns.size >= 1_000) compiledPatterns.clear();
    compiledPatterns.set(key, compiled);
    return compiled;
}

/** Reject malformed patterns instead of truncating or changing their meaning. */
export function parseAdvancedRule(input: Record<string, unknown>): { patterns: ModerationPattern[]; semantic: SemanticPolicy } {
    if (input.patterns !== undefined && !Array.isArray(input.patterns)) throw new Error('Patterns must be a list');
    const rawPatterns = (input.patterns ?? []) as unknown[];
    if (rawPatterns.length > 10) throw new Error('A rule can have at most 10 regex patterns');
    const ids = new Set<string>();
    const patterns = rawPatterns.map((raw): ModerationPattern => {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid regex pattern');
        const item = raw as Record<string, unknown>;
        if (typeof item.source !== 'string' || !item.source.trim() || item.source.length > 250) throw new Error('Regex patterns must contain 1–250 characters');
        if (item.boundary !== undefined && item.boundary !== 'whole_word' && item.boundary !== 'anywhere') throw new Error('Invalid regex boundary');
        if (item.ignoreCase !== undefined && typeof item.ignoreCase !== 'boolean') throw new Error('Invalid regex case option');
        const pattern: ModerationPattern = {
            id: typeof item.id === 'string' && /^[\w-]{1,64}$/.test(item.id) ? item.id : randomUUID(),
            source: item.source,
            boundary: item.boundary === 'anywhere' ? 'anywhere' : 'whole_word',
            ignoreCase: item.ignoreCase !== false
        };
        if (ids.has(pattern.id)) throw new Error('Regex pattern IDs must be unique');
        ids.add(pattern.id);
        try {
            if (new RE2(pattern.source, pattern.ignoreCase ? 'iu' : 'u').test('')) throw new Error('empty match');
            compilePattern(pattern);
        } catch {
            throw new Error('Invalid or unsupported regex. Use RE2 syntax without lookaround/backreferences or empty matches; select whole-word boundaries separately.');
        }
        return pattern;
    });
    const semantic = emptySemanticPolicy();
    if (input.semantic !== undefined) {
        if (!input.semantic || typeof input.semantic !== 'object' || Array.isArray(input.semantic)) throw new Error('Invalid contextual policy');
        const raw = input.semantic as Record<string, unknown>;
        if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid contextual review switch');
        semantic.enabled = raw.enabled === true;
        if (raw.thresholdPercent !== undefined && (typeof raw.thresholdPercent !== 'number' || !Number.isFinite(raw.thresholdPercent) || raw.thresholdPercent < 0 || raw.thresholdPercent > 100)) throw new Error('Flagging confidence must be a percentage from 0 to 100');
        semantic.thresholdPercent = raw.thresholdPercent === undefined ? 85 : raw.thresholdPercent as number;
        if (raw.policy !== undefined && typeof raw.policy !== 'string') throw new Error('Policy must be text');
        semantic.policy = String(raw.policy ?? '').trim();
        if (semantic.policy.length > 2_000 || (semantic.enabled && !semantic.policy)) throw new Error('Enabled contextual review needs a policy of 1–2000 characters');
        if (raw.onUncertain !== undefined && raw.onUncertain !== 'allow_and_log') throw new Error('Uncertain decisions must allow and log');
        if (raw.examples !== undefined && !Array.isArray(raw.examples)) throw new Error('Examples must be a list');
        const examples = (raw.examples ?? []) as unknown[];
        if (examples.length > 10) throw new Error('At most 10 policy examples are allowed');
        semantic.examples = examples.map((example) => {
            const item = example as Record<string, unknown> | null;
            if (!item || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 500 || (item.label !== 'allow' && item.label !== 'violation')) throw new Error('Each example needs a message of 1–500 characters and an allow/violation label');
            return { message: item.message, label: item.label };
        });
    }
    if (input.type !== 'blacklist' && (patterns.length || semantic.enabled)) throw new Error('Regex and contextual review are only available for blocked-word rules');
    return { patterns, semantic };
}

/** Literal matching keeps accent folding; regex operates on the original text. */
export function findBlacklistMatches(text: string, terms: string[], patterns: ModerationPattern[]): ModerationMatch[] {
    const matches: ModerationMatch[] = [];
    let folded = '';
    const offsets: Array<{ start: number; end: number }> = [];
    let position = 0;
    for (const character of text) {
        const normalized = foldText(character);
        for (let i = 0; i < normalized.length; i++) offsets.push({ start: position, end: position + character.length });
        folded += normalized;
        position += character.length;
    }
    const literal = compileBlacklistPattern(terms)?.exec(folded);
    if (literal) {
        const start = offsets[literal.index]?.start ?? 0;
        const end = offsets[literal.index + literal[0].length - 1]?.end ?? start;
        matches.push({ matcherID: 'literal', text: text.slice(start, end), start, end });
    }
    for (const pattern of patterns) {
        const match = compilePattern(pattern).exec(text);
        if (!match) continue;
        const matchedText = pattern.boundary === 'whole_word' ? match[2] : match[0];
        if (!matchedText) continue;
        // Native RE2 uses the same UTF-16 offsets as JS strings.
        const start = match.index
            + (pattern.boundary === 'whole_word' ? (match[1]?.length ?? 0) : 0);
        matches.push({ matcherID: pattern.id, text: matchedText, start, end: start + matchedText.length });
    }
    return matches;
}
