interface IBadgeLike {
    set_id?: string;
    id?: string;
}

const MODERATOR_BADGE_IDS = new Set([
    'moderator',
    'lead_mod',
    'lead_moderator',
    'mod'
]);

function inferUserLevelFromBadges(eventData: Record<string, unknown>): number {
    const badges = Array.isArray(eventData.badges) ? (eventData.badges as IBadgeLike[]) : [];

    for (const badge of badges) {
        const badgeSetId = String(badge?.set_id || badge?.id || '').toLowerCase();
        if (MODERATOR_BADGE_IDS.has(badgeSetId)) {
            return 7;
        }
    }

    return 1;
}

function hasChatChatterIdentity(eventData: Record<string, unknown>): boolean {
    return Boolean(
        eventData.chatter_user_id
        || eventData.chatter_user_login
        || eventData.chatter_user_name
    );
}

export function resolveAuthoredAstUserLevel(
    eventData: Record<string, unknown>,
    providedUserLevel?: number
): number {
    const inferredUserLevel = inferUserLevelFromBadges(eventData);
    if (typeof providedUserLevel === 'number' && Number.isFinite(providedUserLevel)) {
        return Math.max(providedUserLevel, inferredUserLevel);
    }

    if (!hasChatChatterIdentity(eventData)) {
        return 10;
    }

    return inferredUserLevel;
}
