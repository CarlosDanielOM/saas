import { randomInt } from 'node:crypto';
import { catalog, type Role } from './catalog.js';
import { MAX_PERK_COPIES, fail, integer, object, pack, text, normalize, tuning, type State } from './model.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import type { WidgetEventTarget } from './events.js';

type EventRole = 'current' | 'killer' | 'survivor' | 'both';
export type DbdEventAction =
  | { type: 'remove-wins'; role: EventRole; amount: number }
  | { type: 'reset-wins'; role: EventRole }
  | { type: 'set-win-target'; role: EventRole; amount: number }
  | { type: 'add-win-target'; role: EventRole; amount: number }
  // perkIds empty: `amount` random perks. Chosen perks: each gains `amount` wheel slots (turning on counts as one).
  | { type: 'add-perks'; role: EventRole; amount: number; perkIds: string[] }
  | { type: 'remove-perks'; role: EventRole; amount: number; perkIds: string[] };
/** Viewer removals never leave a wheel with fewer perks than a full loadout. */
export const MIN_WHEEL_PERKS = 4;
const ROLE_ACTIONS = ['remove-wins', 'set-win-target', 'add-win-target'];
export interface DbdEventRule {
  id: string;
  enabled: boolean;
  event: 'channel.bits.received';
  minBits: number;
  maxBits: number | null;
  action: DbdEventAction;
}
export interface DbdEventSettings extends Omit<WidgetEventTarget, 'id'> { rules: DbdEventRule[] }
export const defaultEventSettings = (): DbdEventSettings => ({ enabled: false, active: false, activeSince: null, allowTestEvents: false, rules: [] });

function fields(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some(key => !allowed.includes(key))) fail('invalid', 'Unknown widget event setting');
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail('invalid', `${name} must be a boolean`);
  return value;
}
export function eventSettings(input: unknown, now: number): DbdEventSettings {
  const data = object(input);
  fields(data, ['enabled', 'active', 'allowTestEvents', 'rules']);
  const enabled = boolean(data.enabled, 'enabled'), active = boolean(data.active, 'active');
  const allowTestEvents = boolean(data.allowTestEvents, 'allowTestEvents');
  if (!Array.isArray(data.rules) || data.rules.length > 100) fail('invalid', 'Use at most 100 widget event rules');
  const rules: DbdEventRule[] = data.rules.map(value => {
    const rule = object(value);
    fields(rule, ['id', 'enabled', 'event', 'minBits', 'maxBits', 'action']);
    if (rule.event !== 'channel.bits.received') fail('invalid', 'Unsupported DBD event');
    const minBits = integer(rule.minBits, 'minBits');
    const maxBits = rule.maxBits === null ? null : integer(rule.maxBits, 'maxBits', minBits);
    const action = object(rule.action);
    if (!['current', 'killer', 'survivor', 'both'].includes(action.role as string)) fail('invalid', 'Invalid event action role');
    let parsed: DbdEventAction;
    if (action.type === 'reset-wins') {
      fields(action, ['type', 'role']);
      parsed = { type: action.type, role: action.role as EventRole };
    } else if (ROLE_ACTIONS.includes(action.type as string)) {
      fields(action, ['type', 'role', 'amount']);
      parsed = { type: action.type as 'remove-wins', role: action.role as EventRole, amount: integer(action.amount, 'amount', 1, 20) };
    } else if (action.type === 'add-perks' || action.type === 'remove-perks') {
      fields(action, ['type', 'role', 'amount', 'perkIds']);
      if (!Array.isArray(action.perkIds) || action.perkIds.length > 20) fail('invalid', 'Choose at most 20 perks');
      const perkIds = [...new Set(action.perkIds as unknown[])].map(id => {
        if (typeof id !== 'string' || !catalog.entries.some(e => e.id === id && e.kind === 'perk')) fail('invalid', 'Unknown perk');
        return id;
      });
      parsed = { type: action.type, role: action.role as EventRole, amount: integer(action.amount, 'amount', 1, perkIds.length ? MAX_PERK_COPIES : 10), perkIds };
    } else return fail('invalid', 'Unsupported DBD event action');
    return { id: text(rule.id, 'rule ID', 64), enabled: boolean(rule.enabled, 'rule enabled'), event: rule.event, minBits, maxBits, action: parsed };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) fail('invalid', 'Rule IDs must be unique');
  // Every configuration change starts a new eligibility boundary; pending history never adopts new rules.
  return { enabled, active, allowTestEvents, activeSince: enabled && active ? now : null, rules };
}

const perks = (role: Role) => catalog.entries.filter(e => e.kind === 'perk' && e.role === role);
const eligible = (state: State, id: string) => state.config.includeUnavailable || catalog.entries.find(e => e.id === id)?.available === true;
const onWheel = (state: State, id: string) => eligible(state, id) && !state.config.excludedIds.includes(id);
function draw<T>(items: T[], amount: number): T[] {
  const pool = [...items], out: T[] = [];
  while (out.length < amount && pool.length) out.push(pool.splice(randomInt(pool.length), 1)[0]);
  return out;
}
function setCopies(state: State, id: string, copies: number): void {
  const tuned = { ...tuning(state, id), copies };
  const rest = Object.fromEntries(Object.entries(state.config.perkTuning!).filter(([key]) => key !== id));
  state.config.perkTuning = tuned.copies === 1 && tuned.weight === 1 ? rest : { ...rest, [id]: tuned };
}
function addPerks(state: State, role: Role, amount: number, chosen: string[]): void {
  if (!chosen.length) {
    // Random adds only bring back perks that are off; the wheel never gains a perk it can't show.
    for (const entry of draw(perks(role).filter(e => eligible(state, e.id) && !onWheel(state, e.id)), amount)) {
      state.config.excludedIds = state.config.excludedIds.filter(id => id !== entry.id); setCopies(state, entry.id, 1);
    }
    return;
  }
  for (const id of chosen.filter(id => perks(role).some(e => e.id === id))) {
    const was = onWheel(state, id) ? tuning(state, id).copies : 0;
    state.config.excludedIds = state.config.excludedIds.filter(item => item !== id);
    setCopies(state, id, Math.min(MAX_PERK_COPIES, was + amount));
  }
}
function removePerks(state: State, role: Role, amount: number, chosen: string[]): void {
  const on = perks(role).filter(e => onWheel(state, e.id)).map(e => e.id);
  const room = Math.max(0, on.length - MIN_WHEEL_PERKS);
  const targets = chosen.length ? chosen.filter(id => on.includes(id)).slice(0, room) : draw(on, Math.min(amount, room));
  for (const id of targets) {
    state.config.excludedIds = [...state.config.excludedIds, id]; setCopies(state, id, 1);
  }
}

/** Ordered rules all match independently. Exact amounts use minBits === maxBits. */
export function applyDbdEventRules(state: State, rules: readonly DbdEventRule[], event: DomainEventEnvelope): boolean {
  if (event.type !== 'channel.bits.received') return false;
  const raw = event.payload.event as Record<string, unknown> | undefined;
  const bits = raw?.bits;
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1) return false;
  let matched = false;
  for (const rule of rules) {
    if (!rule.enabled || rule.event !== event.type || bits < rule.minBits || rule.maxBits !== null && bits > rule.maxBits) continue;
    normalize(state);
    const action = rule.action;
    // Chosen perks carry their own role, so they apply even when the rule says "current role".
    const chosen = (action.type === 'add-perks' || action.type === 'remove-perks') && action.perkIds.length > 0;
    const roles = chosen || action.role === 'both' ? ['killer', 'survivor'] as const : [action.role === 'current' ? pack(state.packId).role : action.role];
    for (const role of roles) {
      if (action.type === 'add-perks') addPerks(state, role, action.amount, action.perkIds);
      else if (action.type === 'remove-perks') removePerks(state, role, action.amount, action.perkIds);
      else if (action.type === 'add-win-target') state.config.targets![role] = Math.min(20, state.config.targets![role] + action.amount);
      else if (action.type === 'remove-wins') state.wins![role] = Math.max(0, state.wins![role] - action.amount);
      else if (action.type === 'reset-wins') state.wins![role] = 0;
      else {
        state.config.targets![role] = action.amount;
        state.wins![role] = Math.min(state.wins![role], action.amount);
      }
    }
    matched = true;
  }
  return matched;
}
