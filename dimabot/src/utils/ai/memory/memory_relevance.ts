const PASSIVE_STRONG_SCORE = 0.72;
export const PASSIVE_CANDIDATE_SCORE = 0.45;

const COMMON_WORDS = new Set([
    'about', 'channel', 'could', 'does', 'from', 'have', 'know', 'memory', 'memories',
    'remember', 'that', 'their', 'them', 'this', 'what', 'when', 'where', 'which',
    'with', 'would', 'canal', 'como', 'cual', 'donde', 'esto', 'memoria', 'memorias',
    'para', 'porque', 'recuerda', 'recuerdas', 'sabes', 'sobre', 'tiene'
]);

function distinctiveWords(value: string): Set<string> {
    return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) || [])
        .filter((word) => !COMMON_WORDS.has(word)));
}

/** Require a topic overlap for weaker passive matches instead of lowering the cutoff blindly. */
export function isPassiveMemoryRelevant(query: string, summary: string, score: number): boolean {
    if (score >= PASSIVE_STRONG_SCORE) return true;
    if (score < PASSIVE_CANDIDATE_SCORE) return false;
    const queryWords = distinctiveWords(query);
    if (queryWords.size === 0) return false;
    return [...distinctiveWords(summary)].some((word) => queryWords.has(word));
}
