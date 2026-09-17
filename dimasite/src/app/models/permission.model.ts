/**
 * Tag permission system — shared client model (TAG_PERMISSION_SYSTEM.md §6).
 *
 * Mirrors the backend expression grammar (dimabot/src/utils/permissions) so
 * the editor can validate and preview locally. Server and client stay in
 * lockstep via ops/fixtures/permission-expressions.json. Human-readable
 * summaries are produced here with translated labels only — the API returns
 * the tree, never prose.
 */
export const ROLE_TAGS = [
  'everyone',
  'sub',
  'vip',
  'founder',
  'mod',
  'editor',
  'admin',
  'broadcaster'
] as const;

export type RoleTag = (typeof ROLE_TAGS)[number];

export type PermissionExpression =
  | { role: RoleTag }
  | { level: number }
  | { not: PermissionExpression }
  | { and: PermissionExpression[] }
  | { or: PermissionExpression[] };

export const MAX_EXPRESSION_DEPTH = 4;
export const MAX_EXPRESSION_NODES = 25;

const ROLE_TAG_SET: ReadonlySet<string> = new Set(ROLE_TAGS);

export function isRoleTag(value: unknown): value is RoleTag {
  return typeof value === 'string' && ROLE_TAG_SET.has(value);
}

export type ExpressionValidationResult =
  | { ok: true; value: PermissionExpression }
  | { ok: false; error: string };

export type ExpressionState =
  | { mode: 'level' }
  | { mode: 'tags'; expression: PermissionExpression }
  | { mode: 'invalid'; error: string };

const DISCRIMINATORS = ['role', 'level', 'not', 'and', 'or'] as const;
const DISCRIMINATOR_SET: ReadonlySet<string> = new Set(DISCRIMINATORS);

function validateNode(input: unknown, depth: number, counter: { nodes: number }): ExpressionValidationResult {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return { ok: false, error: `permissions.errors.tooDeep` };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'permissions.errors.notAnObject' };
  }

  const keys = Object.keys(input);
  const operators = keys.filter((key) => DISCRIMINATOR_SET.has(key));
  if (operators.length === 0) {
    return { ok: false, error: 'permissions.errors.emptyNode' };
  }
  if (operators.length > 1) {
    return { ok: false, error: 'permissions.errors.mixedOperators' };
  }
  const unknownFields = keys.filter((key) => !DISCRIMINATOR_SET.has(key));
  if (unknownFields.length > 0) {
    return { ok: false, error: 'permissions.errors.unknownFields' };
  }

  counter.nodes += 1;
  if (counter.nodes > MAX_EXPRESSION_NODES) {
    return { ok: false, error: 'permissions.errors.tooManyNodes' };
  }

  const node = input as Record<string, unknown>;

  if (operators[0] === 'role') {
    if (!isRoleTag(node['role'])) {
      return { ok: false, error: 'permissions.errors.unknownRole' };
    }
    return { ok: true, value: { role: node['role'] as RoleTag } };
  }

  if (operators[0] === 'level') {
    const level = node['level'];
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) {
      return { ok: false, error: 'permissions.errors.badLevel' };
    }
    return { ok: true, value: { level } };
  }

  if (operators[0] === 'not') {
    const child = validateNode(node['not'], depth + 1, counter);
    if (!child.ok) return child;
    return { ok: true, value: { not: child.value } };
  }

  const operator = operators[0] as 'and' | 'or';
  const children = node[operator];
  if (!Array.isArray(children) || children.length < 1) {
    return { ok: false, error: 'permissions.errors.emptyGroup' };
  }

  const validatedChildren: PermissionExpression[] = [];
  for (const child of children) {
    const childResult = validateNode(child, depth + 1, counter);
    if (!childResult.ok) return childResult;
    validatedChildren.push(childResult.value);
  }

  return { ok: true, value: { [operator]: validatedChildren } as PermissionExpression };
}

export function validateExpression(input: unknown): ExpressionValidationResult {
  return validateNode(input, 1, { nodes: 0 });
}

/** Missing/null -> level mode; valid -> tags; present-invalid -> invalid (fail closed). */
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

export interface PreviewIdentity {
  level: number;
  tags: ReadonlySet<RoleTag>;
}

/** Client-side preview evaluation (same semantics as the backend). */
export function evaluateExpression(expr: PermissionExpression, identity: PreviewIdentity): boolean {
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
    return !evaluateExpression((expr as { not: PermissionExpression }).not, identity);
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

// ============================================================================
// Node factories for the editor
// ============================================================================

export function createRoleNode(role: RoleTag): PermissionExpression {
  return { role };
}

export function createLevelNode(level: number): PermissionExpression {
  return { level };
}

export function createNotNode(child: PermissionExpression): PermissionExpression {
  return { not: child };
}

export function createGroupNode(operator: 'and' | 'or', children: PermissionExpression[]): PermissionExpression {
  return { [operator]: children } as PermissionExpression;
}

export function countExpressionNodes(expr: unknown): number {
  if (!expr || typeof expr !== 'object') return 0;
  const node = expr as Record<string, unknown>;

  if ('role' in node || 'level' in node) return 1;
  if ('not' in node) return 1 + countExpressionNodes(node['not']);
  if ('and' in node || 'or' in node) {
    const children = (node['and'] ?? node['or']) as unknown;
    if (!Array.isArray(children)) return 1;
    return 1 + children.reduce((total, child) => total + countExpressionNodes(child), 0);
  }

  return 0;
}

// ============================================================================
// Localized descriptions (labels provided by the caller via LanguageService)
// ============================================================================

export interface PermissionLabelSource {
  roleLabel(role: RoleTag): string;
  operatorLabel(operator: 'not' | 'and' | 'or'): string;
  levelLabel(level: number): string;
  formatSummary(pattern: string, parts: Record<string, string>): string;
}

/**
 * Builds a localized, human-readable description of a validated expression.
 * Pure structure-to-text mapping: every word comes from the label source, so
 * no English prose is embedded here.
 */
export function describeExpression(
  expr: PermissionExpression,
  labels: PermissionLabelSource
): string {
  return describeNode(expr, labels, false);
}

function describeNode(expr: PermissionExpression, labels: PermissionLabelSource, negated: boolean): string {
  if ('role' in expr) {
    const base = labels.roleLabel(expr.role);
    return negated ? labels.formatSummary('permissions.summary.notRole', { role: base }) : base;
  }

  if ('level' in expr) {
    const base = labels.levelLabel(expr.level);
    return negated ? labels.formatSummary('permissions.summary.notLevel', { level: base }) : base;
  }

  if ('not' in expr) {
    return describeNode(expr.not, labels, !negated);
  }

  const operator = 'and' in expr ? 'and' : 'or';
  const children = ((expr as { and?: PermissionExpression[]; or?: PermissionExpression[] })[operator] ?? [])
    .map((child) => describeNode(child, labels, false));

  const joined = labels.formatSummary(
    `permissions.summary.${operator}`,
    { list: children.join(labels.formatSummary('permissions.summary.separator', {})) }
  );

  return negated ? labels.formatSummary('permissions.summary.notGroup', { group: joined }) : joined;
}
