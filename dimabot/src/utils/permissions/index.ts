/**
 * Tag permission system — approved authorization gates
 * (TAG_PERMISSION_SYSTEM.md §2.3).
 *
 * `commandAllowed` / `ruleExempt` are the only approved way to authorize
 * commands and moderation exemptions. Level mode and tag mode are exclusive:
 * a missing/`null` expression means level mode; a valid expression means tag
 * mode; a present invalid expression fails closed (denied / no exemption)
 * and never falls back to the stored numeric field.
 */
import { evaluateExpression, inspectExpression, type ExpressionState, type PermissionExpression } from './expression.js';
import type { UserIdentity } from './roles.js';

function parseLegacyLevel(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number.parseInt(String(value ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function isExpressionAllowed(expr: PermissionExpression, identity: UserIdentity): boolean {
    return evaluateExpression(expr, identity);
}

/**
 * Command authorization. `null`/missing expression uses the legacy numeric
 * gate; a valid expression uses tag mode; a present invalid expression is
 * denied (fail closed).
 */
export function commandAllowed(
    command: { permissionExpression?: unknown; userLevel?: unknown } | null | undefined,
    identity: UserIdentity
): boolean {
    if (!command) {
        return false;
    }

    const state = inspectExpression(command.permissionExpression);
    if (state.mode === 'tags') {
        return evaluateExpression(state.expression, identity);
    }
    if (state.mode === 'invalid') {
        return false;
    }

    return identity.level >= parseLegacyLevel(command.userLevel);
}

/**
 * Moderation rule exemption. `null`/missing expression uses the legacy
 * numeric gate; a valid expression exempts exactly the matching tags; a
 * present invalid expression grants no exemption (fail closed).
 */
export function ruleExempt(
    rule: { exemptExpression?: unknown; exemptUserLevel?: unknown } | null | undefined,
    identity: UserIdentity
): boolean {
    if (!rule) {
        return false;
    }

    const state = inspectExpression(rule.exemptExpression);
    if (state.mode === 'tags') {
        return evaluateExpression(state.expression, identity);
    }
    if (state.mode === 'invalid') {
        return false;
    }

    return identity.level >= parseLegacyLevel(rule.exemptUserLevel);
}

export { inspectExpression };
export type { ExpressionState, PermissionExpression };

export {
    ROLE_TAGS,
    MODERATOR_BADGE_IDS,
    BROADCASTER_USER_LEVEL,
    LEGACY_USER_LEVEL_NAMES,
    ROLE_CACHE_TTL_SECONDS,
    createBroadcasterIdentity,
    createDefaultIdentity,
    createUserIdentity,
    deriveBadgeLevel,
    deriveBadgeTags,
    editorsKey,
    editorsIdsKey,
    adminsKey,
    adminsIdsKey,
    adminDetailKey,
    legacyEditorsKey,
    isEditorLoginCached,
    parseUserIdentity,
    refreshEditorCache,
    populateAdminCache,
    addAdminToRoleCache,
    removeAdminFromRoleCache,
    clearChannelRoleCache,
    resolveUserIdentity,
    serializeUserIdentity
} from './roles.js';
export type {
    AdminCacheEntry,
    EditorCacheEntry,
    RoleCacheClient,
    RoleTag,
    SerializedUserIdentity,
    UserIdentity
} from './roles.js';
export {
    evaluateExpression,
    validateExpression,
    MAX_EXPRESSION_DEPTH,
    MAX_EXPRESSION_NODES,
    countExpressionNodes
} from './expression.js';
export { shouldLogPermissionError } from './error_rate_limit.js';
