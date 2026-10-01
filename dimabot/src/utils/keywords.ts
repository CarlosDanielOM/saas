export type KeywordMatchMode = 'start' | 'anywhere' | 'exact';
export interface KeywordSettings { matchMode: KeywordMatchMode }
export interface KeywordEntry { id: string; text: string; matchMode: KeywordMatchMode }

export function normalizeKeyword(text: string): string {
    return text.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function validateKeyword(text: unknown, settings: unknown): KeywordSettings {
    if (typeof text !== 'string' || text.length > 60 ||
        !/^[\p{L}\p{N}\p{M}_]+(?: [\p{L}\p{N}\p{M}_]+)*$/u.test(normalizeKeyword(text))) {
        throw new Error('Keyword must contain words or a phrase, without !, and be at most 60 characters');
    }
    const matchMode = (settings as Partial<KeywordSettings> | null)?.matchMode;
    if (!['start', 'anywhere', 'exact'].includes(String(matchMode))) {
        throw new Error('Keyword match mode must be start, anywhere, or exact');
    }
    return { matchMode: matchMode as KeywordMatchMode };
}

/** Index by first word; only candidates present in the message are examined. */
export function compileKeywordIndex(entries: KeywordEntry[]): Map<string, KeywordEntry[]> {
    const index = new Map<string, KeywordEntry[]>();
    for (const entry of entries) {
        const first = entry.text.split(' ')[0];
        const bucket = index.get(first) ?? [];
        bucket.push(entry);
        index.set(first, bucket);
    }
    return index;
}

export function keywordMatches(message: string, entry: KeywordEntry): boolean {
    const text = normalizeKeyword(message);
    if (entry.matchMode === 'exact') return text === entry.text;
    const escaped = entry.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = entry.matchMode === 'start' ? '^' : '(?<![\\p{L}\\p{N}\\p{M}_])';
    return new RegExp(`${left}${escaped}(?![\\p{L}\\p{N}\\p{M}_])`, 'u').test(text);
}

export function matchKeywords(index: Map<string, KeywordEntry[]>, message: string): KeywordEntry[] {
    const words = new Set(normalizeKeyword(message).match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []);
    const matches = new Map<string, KeywordEntry>();
    for (const word of words) {
        for (const entry of index.get(word) ?? []) {
            if (keywordMatches(message, entry)) matches.set(entry.id, entry);
        }
    }
    return [...matches.values()];
}

/** Coalesces cold loads, caches empty channels, and discards invalidated in-flight reads. */
export class KeywordIndexCache {
    private readonly entries = new Map<string, { index: Map<string, KeywordEntry[]>; expires: number }>();
    private readonly pending = new Map<string, Promise<Map<string, KeywordEntry[]>>>();
    constructor(private readonly load: (channelID: string) => Promise<KeywordEntry[]>,
        private readonly ttl = 30_000, private readonly capacity = 2000) {}

    invalidate(channelID: string): void {
        this.entries.delete(channelID);
        this.pending.delete(channelID);
    }

    async get(channelID: string): Promise<Map<string, KeywordEntry[]>> {
        const cached = this.entries.get(channelID);
        if (cached && cached.expires > Date.now()) return cached.index;
        const existing = this.pending.get(channelID);
        if (existing) return existing;
        const promise = this.load(channelID).then(async entries => {
            if (this.pending.get(channelID) !== promise) return this.get(channelID);
            const index = compileKeywordIndex(entries);
            this.entries.delete(channelID);
            this.entries.set(channelID, { index, expires: Date.now() + this.ttl });
            if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
            return index;
        }).finally(() => {
            if (this.pending.get(channelID) === promise) this.pending.delete(channelID);
        });
        this.pending.set(channelID, promise);
        return promise;
    }
}
