/** Roman installments are bounded to avoid treating ordinary words as numbers. */
const ROMAN_INSTALLMENTS = [
    '', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix',
    'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix',
    'xx', 'xxi', 'xxii', 'xxiii', 'xxiv', 'xxv', 'xxvi', 'xxvii', 'xxviii', 'xxix',
    'xxx', 'xxxi', 'xxxii', 'xxxiii', 'xxxiv', 'xxxv', 'xxxvi', 'xxxvii', 'xxxviii', 'xxxix'
];

export function categoryTokens(title: string): string[] {
    return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/['’]/g, '')
        .replace(/(\p{L})(\d)/gu, '$1 $2').replace(/(\d)(\p{L})/gu, '$1 $2')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
        .map((token, index) => {
            // Leading I/V/X may be words (I Am Alive, V Rising), not installments.
            const roman = index > 0 ? ROMAN_INSTALLMENTS.indexOf(token) : -1;
            return roman > 0 ? String(roman) : /^\d+$/.test(token) ? String(Number(token)) : token;
        });
}

export function categoryQueries(query: string): string[] {
    const tokens = categoryTokens(query);
    const arabic = tokens.join(' ');
    const roman = tokens.map(token => /^\d+$/.test(token)
        ? ROMAN_INSTALLMENTS[Number(token)] || token : token).join(' ');
    const base = tokens.filter(token => !/^\d+$/.test(token)).join(' ');
    // At most four calls, with broad franchise discovery last. Selection still
    // checks all requested numbers, even when searching without those numbers.
    return [...new Set([query.trim().toLowerCase().replace(/\s+/g, ' '), arabic, roman,
        tokens.some(token => /^\d+$/.test(token)) ? base : ''].filter(Boolean))];
}

export function categoryMatchScore(query: string, title: string): number {
    const requested = categoryTokens(query);
    const candidate = categoryTokens(title);
    if (!requested.length) return 0;
    const numbers = requested.filter(token => /^\d+$/.test(token));
    const candidateNumbers = candidate.filter(token => /^\d+$/.test(token));
    if (numbers.length && numbers.join(' ') !== candidateNumbers.join(' ')) return 0;
    if (query.trim().toLowerCase() === title.trim().toLowerCase()) return 4;
    if (requested.join(' ') === candidate.join(' ')) return 3;
    const remaining = [...candidate];
    for (const token of requested) {
        // Numeric tokens must match completely: 2 must never match 20 or 2077.
        const index = remaining.findIndex(word => word === token ||
            (!/^\d+$/.test(token) && word.startsWith(token)));
        if (index < 0) return 0;
        remaining.splice(index, 1);
    }
    return remaining.length === 0 ? 2 : 1;
}
