import { describe, expect, it } from 'vitest';

import { buildAccessExpression, emptyAccessDraft, parseAccessDraft } from './permission-expression.model';

describe('command access expression adapter', () => {
  it('stores exact allow and exclude rules with Twitch IDs and round-trips them', () => {
    const draft = emptyAccessDraft(10);
    draft.tags.vip = 'allow';
    draft.tags.mod = 'allow';
    draft.tags.sub = 'exclude';
    draft.allowUsers = [{ id: '123456', login: 'user123' }];
    draft.excludeUsers = [{ id: '456789', login: 'badactor' }];

    const expression = buildAccessExpression(draft);
    expect(expression).toEqual({
      and: [
        { or: [
          { level: 10 }, { role: 'vip' }, { role: 'mod' },
          { user: { id: '123456', login: 'user123' } }
        ] },
        { not: { or: [
          { role: 'sub' },
          { user: { id: '456789', login: 'badactor' } }
        ] } }
      ]
    });
    expect(parseAccessDraft(expression, 1)).toEqual(draft);
  });

  it('supports everyone except one account without granting through the exclusion', () => {
    const draft = emptyAccessDraft(1);
    draft.excludeUsers = [{ id: '123456', login: 'user123' }];
    expect(buildAccessExpression(draft)).toEqual({
      and: [{ level: 1 }, { not: { user: { id: '123456', login: 'user123' } } }]
    });
  });

  it('keeps legacy level mode when no tag or account rule exists', () => {
    expect(buildAccessExpression(emptyAccessDraft(5))).toBeNull();
    expect(parseAccessDraft(null, 5).baseLevel).toBe(5);
  });

  it('refuses to flatten an advanced expression with different semantics', () => {
    const nested = { and: [{ role: 'vip' }, { role: 'mod' }] };
    expect(parseAccessDraft(nested, 1).editable).toBe(false);
  });
});
