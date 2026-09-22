import { isRoleTag, type RoleTag, type UserIdentity } from './roles.js';

/**
 * Tag permission expressions (TAG_PERMISSION_SYSTEM.md §2.2).
 *
 * Boolean expression tree over role tags and legacy numeric levels. The tree
 * is user-supplied (stored in Mongo as an untyped Mixed value), so
 * `validateExpression` doubles as the sanitizer for every API ingress point
 * and every read from storage. Present-but-invalid values fail closed.
 */
export type PermissionExpression =
    | { role: RoleTag }
    | { level: number }
    | { user: { id: string; login: string } }
    | { not: PermissionExpression }
    | { and: PermissionExpression[] }
    | { or: PermissionExpression[] };

/** Root node is depth 1; a child at depth MAX_EXPRESSION_DEPTH + 1 is rejected. */
export const MAX_EXPRESSION_DEPTH = 4;
export const MAX_EXPRESSION_NODES = 25;

export type ExpressionValidationResult =
    | { ok: true; value: PermissionExpression }
    | { ok: false; error: string };

const DISCRIMINATOR_KEYS = ['role', 'level', 'user', 'not', 'and', 'or'] as const;
const DISCRIMINATOR_SET: ReadonlySet<string> = new Set(DISCRIMINATOR_KEYS);

interface ValidationCounter {
    nodes: number;
}

function validateNode(input: unknown, depth: number, counter: ValidationCounter): ExpressionValidationResult {
    if (depth > MAX_EXPRESSION_DEPTH) {
        return { ok: false, error: `expression exceeds maximum depth of ${MAX_EXPRESSION_DEPTH}` };
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'expression node must be an object' };
    }

    const keys = Object.keys(input);
    const discriminators = keys.filter((key) => DISCRIMINATOR_SET.has(key));
    if (discriminators.length === 0) {
        return { ok: false, error: 'expression node is empty or has no recognized operator' };
    }
    if (discriminators.length > 1) {
        return { ok: false, error: `expression node must have exactly one operator, found: ${discriminators.join(', ')}` };
    }
    const unknownFields = keys.filter((key) => !DISCRIMINATOR_SET.has(key));
    if (unknownFields.length > 0) {
        return { ok: false, error: `expression node has unknown fields: ${unknownFields.join(', ')}` };
    }

    counter.nodes += 1;
    if (counter.nodes > MAX_EXPRESSION_NODES) {
        return { ok: false, error: `expression exceeds maximum of ${MAX_EXPRESSION_NODES} nodes` };
    }

    const node = input as Record<string, unknown>;

    if (discriminators[0] === 'role') {
        const role = node.role;
        if (!isRoleTag(role)) {
            return { ok: false, error: `unknown role tag: ${String(role)}` };
        }
        return { ok: true, value: { role } };
    }

    if (discriminators[0] === 'level') {
        const level = node.level;
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) {
            return { ok: false, error: `level must be an integer between 1 and 10, got: ${String(level)}` };
        }
        return { ok: true, value: { level } };
    }

    if (discriminators[0] === 'user') {
        const user = node.user;
        if (!user || typeof user !== 'object' || Array.isArray(user) ||
            Object.keys(user).length !== 2 || !Object.hasOwn(user, 'id') || !Object.hasOwn(user, 'login')) {
            return { ok: false, error: 'user must contain exactly id and login' };
        }
        const { id, login } = user as Record<string, unknown>;
        if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) {
            return { ok: false, error: 'user id must be a Twitch account ID' };
        }
        if (typeof login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(login)) {
            return { ok: false, error: 'user login must be a Twitch login' };
        }
        return { ok: true, value: { user: { id, login: login.toLowerCase() } } };
    }

    if (discriminators[0] === 'not') {
        const child = validateNode(node.not, depth + 1, counter);
        if (!child.ok) return child;
        return { ok: true, value: { not: child.value } };
    }

    const operator = discriminators[0] as 'and' | 'or';
    const children = node[operator];
    if (!Array.isArray(children) || children.length < 1) {
        return { ok: false, error: `${operator} group must be an array with at least one child` };
    }

    const validatedChildren: PermissionExpression[] = [];
    for (const child of children) {
        const childResult = validateNode(child, depth + 1, counter);
        if (!childResult.ok) return childResult;
        validatedChildren.push(childResult.value);
    }

    return { ok: true, value: { [operator]: validatedChildren } as PermissionExpression };
}

/**
 * Validates and sanitizes a permission expression. Exactly one discriminator
 * key per node, known roles, integer levels 1..10, non-empty and/or groups,
 * depth <= MAX_EXPRESSION_DEPTH (root at depth 1), nodes <= MAX_EXPRESSION_NODES.
 */
export function validateExpression(input: unknown): ExpressionValidationResult {
    const counter: ValidationCounter = { nodes: 0 };
    return validateNode(input, 1, counter);
}

export type ExpressionState =
    | { mode: 'level' }
    | { mode: 'tags'; expression: PermissionExpression }
    | { mode: 'invalid'; error: string };

/**
 * Inspects a stored permission value: missing/`null` selects legacy level
 * mode; a valid tree selects tag mode; a present invalid value is a
 * configuration error that must fail closed (never falls back to a level).
 */
export function inspectExpression(input: unknown): ExpressionState {
    if (input === undefined || input === null) {
        return { mode: 'level' };
    }

    const result = validateExpression(input);
    if (result.ok) {
        return { mode: 'tags', expression: result.value };
    }

    return { mode: 'invalid', error: result.error };
}

/**
 * Evaluates a validated expression against an identity.
 *
 * 1. Broadcaster override: the broadcaster always matches a valid expression.
 * 2. `{role:'everyone'}` is true for every user.
 * 3. Other role leaves check the identity's full tag set.
 * 4. `{level:n}` compares the legacy numeric level.
 *
 * Unknown identity fields and malformed nodes remain unknown through NOT.
 * An unknown final result fails closed, while decisive role matches in an OR
 * group can still grant access.
 */
export function evaluateExpression(expr: PermissionExpression, identity: UserIdentity): boolean {
    if (identity.tags.has('broadcaster')) {
        return true;
    }

    return evaluateNode(expr, identity) === true;
}

/** `null` is unknown, not false: negating an unknown user must never grant access. */
function evaluateNode(input: unknown, identity: UserIdentity): boolean | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const keys = Object.keys(input);
    if (keys.length !== 1) return null;
    const expr = input as Record<string, unknown>;

    if (keys[0] === 'role') {
        if (!isRoleTag(expr.role)) return null;
        return expr.role === 'everyone' || identity.tags.has(expr.role);
    }

    if (keys[0] === 'level') {
        const level = expr.level;
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) return null;
        return identity.level >= level;
    }

    if (keys[0] === 'user') {
        const user = expr.user;
        if (!user || typeof user !== 'object' || Array.isArray(user) ||
            typeof (user as { id?: unknown }).id !== 'string') return null;
        if (!identity.userId) return null;
        return (user as { id: string }).id === identity.userId;
    }

    if (keys[0] === 'not') {
        const child = evaluateNode(expr.not, identity);
        return child === null ? null : !child;
    }

    if (keys[0] === 'and' || keys[0] === 'or') {
        const children = expr[keys[0]];
        if (!Array.isArray(children) || children.length === 0) return null;
        let unknown = false;
        for (const child of children) {
            const result = evaluateNode(child, identity);
            if (keys[0] === 'and' && result === false) return false;
            if (keys[0] === 'or' && result === true) return true;
            if (result === null) unknown = true;
        }
        return unknown ? null : keys[0] === 'and';
    }

    return null;
}

/** Number of nodes in a tree (bounded by validation; safe on any shape). */
export function countExpressionNodes(expr: unknown): number {
    if (!expr || typeof expr !== 'object') return 0;
    const node = expr as Record<string, unknown>;

    if ('role' in node || 'level' in node || 'user' in node) return 1;
    if ('not' in node) return 1 + countExpressionNodes(node.not);
    if ('and' in node || 'or' in node) {
        const children = (node.and ?? node.or) as unknown;
        if (!Array.isArray(children)) return 1;
        return 1 + children.reduce((total, child) => total + countExpressionNodes(child), 0);
    }

    return 0;
}
