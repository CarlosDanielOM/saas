import { describe, expect, it } from 'vitest';

import { buildAccessExpression, cycleAccessTag, emptyAccessDraft, parseAccessDraft } from './permission-expression.model';

describe('shared tag access expression adapter', () => {
  it('stores exact allow and exclude rules with Twitch IDs and round-trips them', () => {
    const draft = emptyAccessDraft();
    draft.tags.vip = 'allow';
    draft.tags.mod = 'allow';
    draft.tags.sub = 'exclude';
    draft.allowUsers = [{ id: '123456', login: 'user123' }];
    draft.excludeUsers = [{ id: '456789', login: 'badactor' }];

    const expression = buildAccessExpression(draft);
    expect(expression).toEqual({
      and: [
        { or: [
          { role: 'vip' }, { role: 'mod' },
          { user: { id: '123456', login: 'user123' } }
        ] },
        { not: { or: [
          { role: 'sub' },
          { user: { id: '456789', login: 'badactor' } }
        ] } }
      ]
    });
    expect(parseAccessDraft(expression)).toEqual(draft);
  });

  it('supports everyone except one account without granting through the exclusion', () => {
    const draft = emptyAccessDraft();
    draft.excludeUsers = [{ id: '123456', login: 'user123' }];
    expect(buildAccessExpression(draft)).toEqual({
      not: { user: { id: '123456', login: 'user123' } }
    });
    expect(parseAccessDraft(buildAccessExpression(draft))).toEqual(draft);
  });

  it('retains an excluded Everyone tag alongside a specifically allowed account', () => {
    const draft = emptyAccessDraft();
    draft.tags.everyone = 'exclude';
    draft.allowUsers = [{ id: '123456', login: 'user123' }];
    const expression = buildAccessExpression(draft);
    expect(expression).toEqual({
      and: [
        { user: { id: '123456', login: 'user123' } },
        { not: { role: 'everyone' } }
      ]
    });
    expect(parseAccessDraft(expression)).toEqual(draft);
  });

  it('keeps legacy level mode when no tag or account rule exists', () => {
    expect(buildAccessExpression(emptyAccessDraft())).toBeNull();
    expect(parseAccessDraft(null)).toEqual(emptyAccessDraft());
  });

  it('refuses to flatten an advanced expression with different semantics', () => {
    const nested = { and: [{ role: 'vip' }, { role: 'mod' }] };
    expect(parseAccessDraft(nested).editable).toBe(false);
    const legacy = parseAccessDraft({ or: [{ level: 5 }, { role: 'vip' }] });
    expect(legacy.editable).toBe(false);
    expect(legacy.legacyCombined).toBe(true);
  });

  it('clears the everyone allow rule when a more specific tag is allowed', () => {
    const draft = emptyAccessDraft();
    draft.tags.everyone = 'allow';
    const next = cycleAccessTag(draft, 'vip');
    expect(next.tags.everyone).toBe('neutral');
    expect(next.tags.vip).toBe('allow');
  });

  it('lets moderation start with no exemptions and then allow a specific tag', () => {
    const draft = emptyAccessDraft();
    draft.tags.everyone = 'exclude';
    expect(buildAccessExpression(draft)).toEqual({ not: { role: 'everyone' } });
    const next = cycleAccessTag(draft, 'vip');
    expect(next.tags.everyone).toBe('neutral');
    expect(buildAccessExpression(next)).toEqual({ role: 'vip' });
  });
});
