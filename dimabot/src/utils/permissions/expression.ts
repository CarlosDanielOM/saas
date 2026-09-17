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
    | { not: PermissionExpression }
    | { and: PermissionExpression[] }
    | { or: PermissionExpression[] };

/** Root node is depth 1; a child at depth MAX_EXPRESSION_DEPTH + 1 is rejected. */
export const MAX_EXPRESSION_DEPTH = 4;
export const MAX_EXPRESSION_NODES = 25;

export type ExpressionValidationResult =
    | { ok: true; value: PermissionExpression }
    | { ok: false; error: string };

const DISCRIMINATOR_KEYS = ['role', 'level', 'not', 'and', 'or'] as const;
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
 * Defense-in-depth: malformed nodes (empty groups, unknown shapes) evaluate
 * to `false` rather than throwing or failing open.
 */
export function evaluateExpression(expr: PermissionExpression, identity: UserIdentity): boolean {
    if (identity.tags.has('broadcaster')) {
        return true;
    }

    if (!expr || typeof expr !== 'object') {
        return false;
    }

    if ('role' in expr) {
        const role = (expr as { role: unknown }).role;
        if (role === 'everyone') return true;
        return identity.tags.has(role as RoleTag);
    }

    if ('level' in expr) {
        const level = (expr as { level: unknown }).level;
        return typeof level === 'number' && identity.level >= level;
    }

    if ('not' in expr) {
        const child = (expr as { not: unknown }).not as PermissionExpression;
        return !evaluateExpression(child, identity);
    }

    if ('and' in expr) {
        const children = (expr as { and: unknown }).and;
        if (!Array.isArray(children) || children.length === 0) return false;
        return children.every((child) => evaluateExpression(child as PermissionExpression, identity));
    }

    if ('or' in expr) {
        const children = (expr as { or: unknown }).or;
        if (!Array.isArray(children) || children.length === 0) return false;
        return children.some((child) => evaluateExpression(child as PermissionExpression, identity));
    }

    return false;
}

/** Number of nodes in a tree (bounded by validation; safe on any shape). */
export function countExpressionNodes(expr: unknown): number {
    if (!expr || typeof expr !== 'object') return 0;
    const node = expr as Record<string, unknown>;

    if ('role' in node || 'level' in node) return 1;
    if ('not' in node) return 1 + countExpressionNodes(node.not);
    if ('and' in node || 'or' in node) {
        const children = (node.and ?? node.or) as unknown;
        if (!Array.isArray(children)) return 1;
        return 1 + children.reduce((total, child) => total + countExpressionNodes(child), 0);
    }

    return 0;
}
