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

/**
 * The dashboard writes flat allow/exclude expressions. For those expressions,
 * an explicit account decision takes priority over a role decision. Keep the
 * normal Boolean evaluator for arbitrary advanced trees, where a user leaf
 * may be conditional on another node.
 */
function flatLeaves(expression: PermissionExpression, allowLevel: boolean): PermissionExpression[] | null {
    const leaves = 'or' in expression ? expression.or : [expression];
    if (leaves.length === 0 || leaves.some((leaf) =>
        !('role' in leaf || 'user' in leaf || (allowLevel && 'level' in leaf)))) {
        return null;
    }
    return leaves;
}

function flatAccountOverride(expression: PermissionExpression, userId: string): boolean | undefined {
    let allowed: PermissionExpression[] = [];
    let excluded: PermissionExpression[] = [];

    if ('and' in expression) {
        if (expression.and.length !== 2 || !('not' in expression.and[1])) return undefined;
        const allowLeaves = flatLeaves(expression.and[0], true);
        const excludeLeaves = flatLeaves(expression.and[1].not, false);
        if (!allowLeaves || !excludeLeaves) return undefined;
        allowed = allowLeaves;
        excluded = excludeLeaves;
    } else if ('not' in expression) {
        const excludeLeaves = flatLeaves(expression.not, false);
        if (!excludeLeaves) return undefined;
        excluded = excludeLeaves;
    } else {
        const allowLeaves = flatLeaves(expression, true);
        if (!allowLeaves) return undefined;
        allowed = allowLeaves;
    }

    if (excluded.some((leaf) => 'user' in leaf && leaf.user.id === userId)) return false;
    if (allowed.some((leaf) => 'user' in leaf && leaf.user.id === userId)) return true;
    return undefined;
}

function evaluateAccessExpression(expression: PermissionExpression, identity: UserIdentity): boolean {
    if (identity.tags.has('broadcaster')) return true;
    if (identity.userId) {
        const override = flatAccountOverride(expression, identity.userId);
        if (override !== undefined) return override;
    }
    return evaluateExpression(expression, identity);
}

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
        return evaluateAccessExpression(state.expression, identity);
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
        return evaluateAccessExpression(state.expression, identity);
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
