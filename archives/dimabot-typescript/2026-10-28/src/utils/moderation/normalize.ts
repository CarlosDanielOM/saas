/**
 * Folds text for blacklist matching: lowercase + accent removal (NFD split,
 * strip combining marks). "Café" and "cafe" fold to the same form.
 */
export function foldText(text: string): string {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
}

export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
