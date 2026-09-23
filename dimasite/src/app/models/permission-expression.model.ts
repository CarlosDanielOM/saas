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
  baseLevel: number;
  tags: Record<AccessTag, TagDecision>;
  allowUsers: TwitchAccountRef[];
  excludeUsers: TwitchAccountRef[];
  /** Arbitrary backend trees are preserved until the streamer explicitly resets them. */
  editable: boolean;
}

export function emptyAccessDraft(baseLevel: number): AccessDraft {
  return {
    baseLevel,
    tags: Object.fromEntries(ACCESS_TAGS.map((tag) => [tag, 'neutral'])) as Record<AccessTag, TagDecision>,
    allowUsers: [],
    excludeUsers: [],
    editable: true
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

/**
 * Read the flat rules this editor creates. Preserve any other expression instead
 * of silently flattening an AND/OR tree and changing its authorization meaning.
 */
export function parseAccessDraft(expression: unknown, fallbackLevel: number): AccessDraft {
  const draft = emptyAccessDraft(fallbackLevel);
  if (expression === null || expression === undefined) return draft;

  let allowNode = expression;
  let denyNode: unknown = null;
  const and = onlyKey(expression, 'and');
  if (and) {
    const children = and['and'];
    if (!Array.isArray(children) || children.length !== 2) return { ...draft, editable: false };
    const not = onlyKey(children[1], 'not');
    if (!not) return { ...draft, editable: false };
    allowNode = children[0];
    denyNode = not['not'];
  }

  const allows = leaves(allowNode);
  const denies = denyNode === null ? [] : leaves(denyNode);
  if (!allows || !denies) return { ...draft, editable: false };

  let foundLevel = false;
  const seenUsers = new Set<string>();
  for (const [kind, group] of [['allow', allows], ['exclude', denies]] as const) {
    for (const item of group) {
      const level = onlyKey(item, 'level');
      if (level) {
        const value = level['level'];
        if (kind !== 'allow' || foundLevel || typeof value !== 'number' ||
          !Number.isInteger(value) || value < 1 || value > 10) return { ...draft, editable: false };
        draft.baseLevel = value;
        foundLevel = true;
        continue;
      }

      const role = onlyKey(item, 'role');
      if (role) {
        const tag = role['role'];
        if (!ACCESS_TAGS.includes(tag as AccessTag) || draft.tags[tag as AccessTag] !== 'neutral') {
          return { ...draft, editable: false };
        }
        draft.tags[tag as AccessTag] = kind;
        continue;
      }

      const user = onlyKey(item, 'user');
      const resolved = user ? account(user['user']) : null;
      if (!resolved || seenUsers.has(resolved.id)) return { ...draft, editable: false };
      seenUsers.add(resolved.id);
      (kind === 'allow' ? draft.allowUsers : draft.excludeUsers).push(resolved);
    }
  }

  // A role-only expression has an implicit broadcaster override in the backend.
  // Level 10 provides the same baseline when the streamer edits it here.
  if (!foundLevel) draft.baseLevel = 10;
  return draft;
}

export function buildAccessExpression(draft: AccessDraft): PermissionExpression | null {
  const allowedTags = ACCESS_TAGS.filter((tag) => draft.tags[tag] === 'allow');
  const deniedTags = ACCESS_TAGS.filter((tag) => draft.tags[tag] === 'exclude');
  if (allowedTags.length === 0 && deniedTags.length === 0 &&
    draft.allowUsers.length === 0 && draft.excludeUsers.length === 0) return null;

  const allowed: PermissionExpression[] = [
    { level: draft.baseLevel },
    ...allowedTags.map((role): PermissionExpression => ({ role })),
    ...draft.allowUsers.map((user): PermissionExpression => ({ user }))
  ];
  const denied: PermissionExpression[] = [
    ...deniedTags.map((role): PermissionExpression => ({ role })),
    ...draft.excludeUsers.map((user): PermissionExpression => ({ user }))
  ];
  const allow: PermissionExpression = allowed.length === 1 ? allowed[0] : { or: allowed };
  if (denied.length === 0) return allow;
  const deny: PermissionExpression = denied.length === 1 ? denied[0] : { or: denied };
  return { and: [allow, { not: deny }] };
}
