import { describe, expect, it } from 'vitest';

import { ACCESS_TAGS, buildAccessExpression, cycleAccessTag, emptyAccessDraft, parseAccessDraft } from './permission-expression.model';

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

  it('retains Everyone and specific allowed tags in either click order', () => {
    const draft = emptyAccessDraft();
    draft.tags.everyone = 'allow';
    const next = cycleAccessTag(draft, 'vip');
    expect(next.tags.everyone).toBe('allow');
    expect(next.tags.vip).toBe('allow');
    expect(parseAccessDraft(buildAccessExpression(next))).toEqual(next);

    const reverse = cycleAccessTag(cycleAccessTag(emptyAccessDraft(), 'vip'), 'everyone');
    expect(reverse.tags).toEqual(next.tags);
  });

  it('keeps excluded Everyone when VIP and Mod are allowed', () => {
    const draft = emptyAccessDraft();
    draft.tags.everyone = 'exclude';
    expect(buildAccessExpression(draft)).toEqual({ not: { role: 'everyone' } });
    const next = cycleAccessTag(cycleAccessTag(draft, 'vip'), 'mod');
    expect(next.tags.everyone).toBe('exclude');
    expect(next.tags.vip).toBe('allow');
    expect(next.tags.mod).toBe('allow');
    expect(buildAccessExpression(next)).toEqual({
      and: [{ or: [{ role: 'vip' }, { role: 'mod' }] }, { not: { role: 'everyone' } }]
    });
    expect(parseAccessDraft(buildAccessExpression(next))).toEqual(next);
  });

  it('keeps every tag allowed when all chips are clicked', () => {
    const draft = ACCESS_TAGS.reduce(cycleAccessTag, emptyAccessDraft());
    expect(ACCESS_TAGS.every((tag) => draft.tags[tag] === 'allow')).toBe(true);
    expect(parseAccessDraft(buildAccessExpression(draft))).toEqual(draft);
  });
});
