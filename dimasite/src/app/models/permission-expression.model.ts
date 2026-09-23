/** The command editor's supported subset of the shared backend expression grammar. */
export type AccessTag = 'everyone' | 'sub' | 'vip' | 'founder' | 'mod' | 'editor' | 'admin';
export type TagDecision = 'neutral' | 'allow' | 'exclude';

export interface TwitchAccountRef {
  id: string;
  login: string;
}

export type PermissionExpression =
  | { role: AccessTag | 'broadcaster' }
  | { level: number }
  | { user: TwitchAccountRef }
  | { not: PermissionExpression }
  | { and: PermissionExpression[] }
  | { or: PermissionExpression[] };

export const ACCESS_TAGS: readonly AccessTag[] = [
  'everyone', 'sub', 'vip', 'founder', 'mod', 'editor', 'admin'
];

export interface AccessDraft {
  tags: Record<AccessTag, TagDecision>;
  allowUsers: TwitchAccountRef[];
  excludeUsers: TwitchAccountRef[];
  /** Arbitrary backend trees are preserved until the streamer explicitly resets them. */
  editable: boolean;
  /** Older combined rules must be replaced with one mode before saving. */
  legacyCombined: boolean;
}

export function emptyAccessDraft(): AccessDraft {
  return {
    tags: Object.fromEntries(ACCESS_TAGS.map((tag) => [tag, 'neutral'])) as Record<AccessTag, TagDecision>,
    allowUsers: [],
    excludeUsers: [],
    editable: true,
    legacyCombined: false
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function onlyKey(value: unknown, key: string): Record<string, unknown> | null {
  const object = record(value);
  return object && Object.keys(object).length === 1 && Object.hasOwn(object, key) ? object : null;
}

function leaves(value: unknown): unknown[] | null {
  const or = onlyKey(value, 'or');
  if (!or) return [value];
  return Array.isArray(or['or']) && or['or'].length > 0 ? or['or'] : null;
}

function account(value: unknown): TwitchAccountRef | null {
  const object = record(value);
  if (!object || Object.keys(object).length !== 2) return null;
  if (typeof object['id'] !== 'string' || !/^\d{1,20}$/.test(object['id'])) return null;
  if (typeof object['login'] !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(object['login'])) return null;
  return { id: object['id'], login: object['login'].toLowerCase() };
}

function containsLevel(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (onlyKey(value, 'level')) return true;
  const not = onlyKey(value, 'not');
  if (not) return containsLevel(not['not'], depth + 1);
  for (const operator of ['and', 'or']) {
    const group = onlyKey(value, operator);
    if (group && Array.isArray(group[operator])) {
      return group[operator].some((child) => containsLevel(child, depth + 1));
    }
  }
  return false;
}

/**
 * Read the flat rules this editor creates. Preserve any other expression instead
 * of silently flattening an AND/OR tree and changing its authorization meaning.
 */
export function parseAccessDraft(expression: unknown): AccessDraft {
  const draft = emptyAccessDraft();
  if (expression === null || expression === undefined) return draft;
  const unsupported = (): AccessDraft => ({
    ...emptyAccessDraft(), editable: false, legacyCombined: containsLevel(expression)
  });

  let allowNode: unknown = expression;
  let denyNode: unknown = null;
  const rootNot = onlyKey(expression, 'not');
  if (rootNot) {
    allowNode = null;
    denyNode = rootNot['not'];
  }
  const and = onlyKey(expression, 'and');
  if (and) {
    const children = and['and'];
    if (!Array.isArray(children) || children.length !== 2) return unsupported();
    const not = onlyKey(children[1], 'not');
    if (!not) return unsupported();
    allowNode = children[0];
    denyNode = not['not'];
  }

  const allows = allowNode === null ? [] : leaves(allowNode);
  const denies = denyNode === null ? [] : leaves(denyNode);
  if (!allows || !denies) return unsupported();

  const seenUsers = new Set<string>();
  for (const [kind, group] of [['allow', allows], ['exclude', denies]] as const) {
    for (const item of group) {
      const level = onlyKey(item, 'level');
      if (level) {
        // Older editor builds embedded a numeric level in tag mode. Keep the
        // original expression intact until the streamer chooses a new mode.
        return unsupported();
      }

      const role = onlyKey(item, 'role');
      if (role) {
        const tag = role['role'];
        if (!ACCESS_TAGS.includes(tag as AccessTag) || draft.tags[tag as AccessTag] !== 'neutral') {
          return unsupported();
        }
        draft.tags[tag as AccessTag] = kind;
        continue;
      }

      const user = onlyKey(item, 'user');
      const resolved = user ? account(user['user']) : null;
      if (!resolved || seenUsers.has(resolved.id)) return unsupported();
      seenUsers.add(resolved.id);
      (kind === 'allow' ? draft.allowUsers : draft.excludeUsers).push(resolved);
    }
  }

  return draft;
}

export function hasAccessRules(draft: AccessDraft): boolean {
  return ACCESS_TAGS.some((tag) => draft.tags[tag] !== 'neutral') ||
    draft.allowUsers.length > 0 || draft.excludeUsers.length > 0;
}

export function cycleAccessTag(draft: AccessDraft, tag: AccessTag): AccessDraft {
  const next: Record<TagDecision, TagDecision> = {
    neutral: 'allow', allow: 'exclude', exclude: 'neutral'
  };
  return { ...draft, tags: { ...draft.tags, [tag]: next[draft.tags[tag]] } };
}

export function buildAccessExpression(draft: AccessDraft): PermissionExpression | null {
  const allowedTags = ACCESS_TAGS.filter((tag) => draft.tags[tag] === 'allow');
  const deniedTags = ACCESS_TAGS.filter((tag) => draft.tags[tag] === 'exclude');
  if (!hasAccessRules(draft)) return null;

  const allowed: PermissionExpression[] = [
    ...allowedTags.map((role): PermissionExpression => ({ role })),
    ...draft.allowUsers.map((user): PermissionExpression => ({ user }))
  ];
  const denied: PermissionExpression[] = [
    ...deniedTags.map((role): PermissionExpression => ({ role })),
    ...draft.excludeUsers.map((user): PermissionExpression => ({ user }))
  ];
  const allow: PermissionExpression | null = allowed.length === 0 ? null :
    allowed.length === 1 ? allowed[0] : { or: allowed };
  if (denied.length === 0) return allow;
  const deny: PermissionExpression = denied.length === 1 ? denied[0] : { or: denied };
  // Exclusion-only rules mean everyone except the selected tags/accounts.
  return allow ? { and: [allow, { not: deny }] } : { not: deny };
}
