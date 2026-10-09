import { fail, integer, object, pack, text, normalize, type State } from './model.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import type { WidgetEventTarget } from './events.js';

type EventRole = 'current' | 'killer' | 'survivor' | 'both';
export type DbdEventAction =
  | { type: 'remove-wins'; role: EventRole; amount: number }
  | { type: 'reset-wins'; role: EventRole }
  | { type: 'set-win-target'; role: EventRole; amount: number };
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
    } else if (action.type === 'remove-wins' || action.type === 'set-win-target') {
      fields(action, ['type', 'role', 'amount']);
      parsed = { type: action.type, role: action.role as EventRole, amount: integer(action.amount, 'amount', 1, 20) };
    } else return fail('invalid', 'Unsupported DBD event action');
    return { id: text(rule.id, 'rule ID', 64), enabled: boolean(rule.enabled, 'rule enabled'), event: rule.event, minBits, maxBits, action: parsed };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) fail('invalid', 'Rule IDs must be unique');
  // Every configuration change starts a new eligibility boundary; pending history never adopts new rules.
  return { enabled, active, allowTestEvents, activeSince: enabled && active ? now : null, rules };
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
    const roles = action.role === 'both' ? ['killer', 'survivor'] as const : [action.role === 'current' ? pack(state.packId).role : action.role];
    for (const role of roles) {
      if (action.type === 'remove-wins') state.wins![role] = Math.max(0, state.wins![role] - action.amount);
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
