import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { getEventsubAccess } from '../../utils/eventsub_access.js';
import { BitsRuleError, MAX_BITS_RULES, parseRule, validRuleId, type BitsRule } from '../../bits_rules/model.js';
import { changeBitsRules, findBitsEventsub, loadBitsRules } from '../../bits_rules/store.js';
import { Studio } from '../../overlays/store.js';

/** Shared Bits rules: edited from Chat events and Overlay Studio, read by the bot and the overlay. */
export const bitsRulesRoute = express.Router();
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req as AuthRequest, res).catch(next); };

bitsRulesRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
bitsRulesRoute.use(authMiddleware as express.RequestHandler);

async function access(req: AuthRequest, manage: boolean): Promise<{ channel: string; requester: string; canManage: boolean }> {
  const channel = String(req.params.channelID || ''), requester = req.user?.id;
  if (!requester) throw new BitsRuleError('Unauthorized', 401);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channel)) throw new BitsRuleError('Channel not found', 404);
  const canManage = await getEventsubAccess(requester, channel, 'eventsubs:manage') !== 'none';
  if (manage && !canManage) throw new BitsRuleError('You can view these Bits rules but not change them', 403);
  if (!canManage && await getEventsubAccess(requester, channel) === 'none') throw new BitsRuleError('You do not have access to this channel', 403);
  return { channel, requester, canManage };
}

/** How many alert designs give each rule its own look (Overlay Studio draft). */
async function looksPerRule(channel: string): Promise<Record<string, number>> {
  const studio = await Studio.findById(channel, { 'designs.variants.bits.ruleId': 1 }).lean();
  const looks: Record<string, number> = {};
  for (const design of studio?.designs ?? []) {
    for (const ruleId of new Set((design.variants?.bits ?? []).map(variant => variant.ruleId).filter(validRuleId))) looks[ruleId] = (looks[ruleId] ?? 0) + 1;
  }
  return looks;
}

async function view(channel: string, canManage: boolean, rules?: { revision: number; rules: BitsRule[] }) {
  const eventsub = await findBitsEventsub(channel);
  const state = rules ?? await loadBitsRules(channel, eventsub?.cheerTiers ?? null);
  return {
    ...state, maxRules: MAX_BITS_RULES, canManage, looks: await looksPerRule(channel),
    chat: { subscribed: !!eventsub, enabled: !!eventsub?.enabled, defaultMessage: eventsub?.message ?? '' }
  };
}

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ error: false, status, message: 'OK', data });
const newRuleId = () => `rule-${randomBytes(6).toString('hex')}`;

bitsRulesRoute.get('/:channelID', wrap(async (req, res) => {
  const { channel, canManage } = await access(req, false);
  return ok(res, await view(channel, canManage));
}));

bitsRulesRoute.post('/:channelID/rules', wrap(async (req, res) => {
  const { channel, requester } = await access(req, true);
  const id = newRuleId();
  const state = await changeBitsRules(channel, requester, rules => {
    if (rules.length >= MAX_BITS_RULES) throw new BitsRuleError(`You can have up to ${MAX_BITS_RULES} Bits rules`, 409);
    return [...rules, parseRule(req.body, id)];
  });
  return ok(res, { ...await view(channel, true, state), created: id }, 201);
}));

bitsRulesRoute.patch('/:channelID/rules/:ruleId', wrap(async (req, res) => {
  const { channel, requester } = await access(req, true);
  const id = String(req.params.ruleId);
  const state = await changeBitsRules(channel, requester, rules => {
    const index = rules.findIndex(rule => rule.id === id);
    if (index < 0) throw new BitsRuleError('This rule was deleted. Reload to see the current rules.', 404);
    rules[index] = parseRule(req.body, id, rules[index]);
    return rules;
  });
  return ok(res, await view(channel, true, state));
}));

bitsRulesRoute.delete('/:channelID/rules/:ruleId', wrap(async (req, res) => {
  const { channel, requester } = await access(req, true);
  const id = String(req.params.ruleId);
  const state = await changeBitsRules(channel, requester, rules => {
    if (!rules.some(rule => rule.id === id)) throw new BitsRuleError('This rule was already deleted.', 404);
    return rules.filter(rule => rule.id !== id);
  });
  return ok(res, await view(channel, true, state));
}));

bitsRulesRoute.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const status = error instanceof BitsRuleError ? error.status : 500;
  if (status === 500) console.error('Bits rules request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(status).json({ error: true, status, message: error instanceof BitsRuleError ? error.message : 'Bits rules are temporarily unavailable' });
});
