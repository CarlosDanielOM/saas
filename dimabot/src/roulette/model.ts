import { randomBytes, randomUUID } from 'node:crypto';

// AST treats hyphens as operators; opaque IDs must remain single unquoted tokens.
const newId = () => randomUUID().replaceAll('-', '');

export class RouletteError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface Item { id: string; label: string; multiplier: number; weight: number; copies: string[] }
export interface Settings {
  insertion: 'append' | 'random'; duplicate: 'separate' | 'increase'; shuffleBeforeDraw: boolean;
  showOnStart: boolean; hideAfterSeconds: number | null; winnerAction: 'keep' | 'remove-copy' | 'remove-item';
}
export interface Roulette {
  id: string; alias: string; name: string; design: 'wheel' | 'cards' | 'reel';
  cardSize: 'large' | 'medium' | 'small'; colors: string[]; durationSeconds: number;
  settings: Settings; items: Item[]; order: string[];
}
export interface Slot { key: string; itemId: string; label: string; weight: number; copy: number; multiplier: number }
export interface Draw {
  id: string; rouletteId: string; startedAt: number; endsAt: number; completedAt: number | null;
  winner: Slot; slots: Slot[]; design: Roulette['design']; cardSize: Roulette['cardSize']; colors: string[];
  winnerAction: Settings['winnerAction']; hideAfterSeconds: number | null;
}
export interface State {
  roulettes: Roulette[]; activeId: string | null; visible: boolean; draw: Draw | null;
  history: Array<Omit<Draw, 'slots'>>; hideAt: number | null;
}
export const defaults: Settings = {
  insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true,
  hideAfterSeconds: null, winnerAction: 'keep',
};
export const emptyState = (): State => ({ roulettes: [], activeId: null, visible: false, draw: null, history: [], hideAt: null });
export function fail(code: string, message: string, status = 400): never { throw new RouletteError(code, message, status); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid', 'Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('invalid', `${field} must contain 1–${max} characters`);
  return value.trim();
}
export function integer(value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('invalid', `${field} must be an integer between ${min} and ${max}`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) fail('invalid', `Invalid ${field}`);
  return value as T;
}
export function randomTicket(total: number): number {
  integer(total, 'total');
  const range = 2 ** 53; const limit = Math.floor(range / total) * total;
  let value: number;
  do { const b = randomBytes(7); value = (b[0] & 31) * 2 ** 48 + b.readUIntBE(1, 6); } while (value >= limit);
  return value % total;
}
export function shuffle(order: string[], random = randomTicket): void {
  for (let i = order.length - 1; i > 0; i--) { const j = random(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
}
export function slots(roulette: Roulette): Slot[] {
  const byKey = new Map<string, Slot>();
  for (const item of roulette.items) item.copies.forEach((key, index) => byKey.set(key, {
    key, itemId: item.id, label: item.label, weight: item.weight, copy: index + 1, multiplier: item.multiplier,
  }));
  return roulette.order.map(key => byKey.get(key)!);
}
export function capacity(r: Roulette): number { return r.design === 'reel' ? 60 : r.design === 'cards' ? { large: 50, medium: 75, small: 100 }[r.cardSize] : 10000; }
export function validate(r: Roulette): void {
  const count = r.items.reduce((n, item) => n + item.multiplier, 0);
  if (count > capacity(r)) fail('capacity', `This design supports ${capacity(r)} copies; requested ${count}`);
  const total = r.items.reduce((n, item) => n + item.weight * item.multiplier, 0);
  if (!Number.isSafeInteger(total)) fail('weight', 'Total weight exceeds the safe integer limit');
}
export function configure(r: Roulette, data: Record<string, unknown>): void {
  const allowed = ['name', 'alias', 'design', 'cardSize', 'colors', 'durationSeconds', 'settings'];
  if (Object.keys(data).some(k => !allowed.includes(k))) fail('invalid', 'Unknown roulette setting');
  if (data.name !== undefined) r.name = text(data.name, 'name');
  if (data.alias !== undefined) {
    r.alias = text(data.alias, 'alias', 40);
    if (!/^[a-z][a-z0-9_-]*$/.test(r.alias)) fail('invalid', 'Alias must start with a lowercase letter and use letters, numbers, _ or -');
  }
  if (data.design !== undefined) r.design = choice(data.design, ['wheel', 'cards', 'reel'], 'design');
  if (data.cardSize !== undefined) r.cardSize = choice(data.cardSize, ['large', 'medium', 'small'], 'cardSize');
  if (data.durationSeconds !== undefined) r.durationSeconds = integer(data.durationSeconds, 'durationSeconds', 1, 120);
  if (data.colors !== undefined) {
    if (!Array.isArray(data.colors) || data.colors.length < 1 || data.colors.length > 12 || data.colors.some(c => typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c))) fail('invalid', 'colors must contain 1–12 hex colors');
    r.colors = data.colors as string[];
  }
  if (data.settings !== undefined) {
    const settings = object(data.settings);
    if (Object.keys(settings).some(k => !Object.hasOwn(defaults, k))) fail('invalid', 'Unknown automation setting');
    if (settings.insertion !== undefined) r.settings.insertion = choice(settings.insertion, ['append', 'random'], 'insertion');
    if (settings.duplicate !== undefined) r.settings.duplicate = choice(settings.duplicate, ['separate', 'increase'], 'duplicate');
    if (settings.winnerAction !== undefined) r.settings.winnerAction = choice(settings.winnerAction, ['keep', 'remove-copy', 'remove-item'], 'winnerAction');
    for (const key of ['shuffleBeforeDraw', 'showOnStart'] as const) if (settings[key] !== undefined) {
      if (typeof settings[key] !== 'boolean') fail('invalid', `${key} must be boolean`);
      r.settings[key] = settings[key];
    }
    if (settings.hideAfterSeconds !== undefined) r.settings.hideAfterSeconds = settings.hideAfterSeconds === null ? null : integer(settings.hideAfterSeconds, 'hideAfterSeconds', 1, 3600);
  }
  validate(r);
}
export function create(data: Record<string, unknown>): Roulette {
  const r: Roulette = { id: newId(), alias: '', name: '', design: 'wheel', cardSize: 'large', colors: ['#cbbaff', '#f4c968', '#ec9baf', '#a5d5c2'], durationSeconds: 4, settings: { ...defaults }, items: [], order: [] };
  configure(r, data); text(r.name, 'name'); text(r.alias, 'alias'); return r;
}
export function find(state: State, reference?: string): Roulette {
  const r = state.roulettes.find(r => r.id === (reference || state.activeId) || r.alias === reference);
  return r || fail('not_found', 'Roulette not found in this channel', 404);
}
export function add(r: Roulette, data: Record<string, unknown>, random = randomTicket): Item {
  if (Object.keys(data).some(k => !['label', 'multiplier', 'weight'].includes(k))) fail('invalid', 'Unknown item field');
  const label = text(data.label, 'label');
  const multiplier = integer(data.multiplier === undefined ? 1 : data.multiplier, 'multiplier', 1, 10000);
  const weight = integer(data.weight === undefined ? 1 : data.weight, 'weight');
  let item = r.settings.duplicate === 'increase' ? r.items.find(i => i.label === label) : undefined;
  if (item && item.weight !== weight) fail('weight_conflict', 'Existing item has a different weight; update it explicitly', 409);
  if (!item) { item = { id: newId(), label, multiplier: 0, weight, copies: [] }; r.items.push(item); }
  item.multiplier += multiplier;
  validate(r);
  for (let i = 0; i < multiplier; i++) {
    const key = newId(); item.copies.push(key);
    r.order.splice(r.settings.insertion === 'random' ? random(r.order.length + 1) : r.order.length, 0, key);
  }
  return item;
}
export function remove(r: Roulette, itemId: string): void {
  const item = r.items.find(i => i.id === itemId) || fail('not_found', 'Item not found', 404);
  const keys = new Set(item.copies); r.order = r.order.filter(key => !keys.has(key)); r.items = r.items.filter(i => i.id !== itemId);
}
export function updateItem(r: Roulette, itemId: string, data: Record<string, unknown>): Item {
  if (Object.keys(data).some(k => !['label', 'multiplier', 'weight'].includes(k))) fail('invalid', 'Unknown item field');
  const item = r.items.find(i => i.id === itemId) || fail('not_found', 'Item not found', 404);
  if (data.label !== undefined) item.label = text(data.label, 'label');
  if (data.weight !== undefined) item.weight = integer(data.weight, 'weight');
  if (data.multiplier !== undefined) item.multiplier = integer(data.multiplier, 'multiplier', 1, 10000);
  validate(r);
  const removed = new Set(item.copies.splice(item.multiplier)); r.order = r.order.filter(k => !removed.has(k));
  while (item.copies.length < item.multiplier) {
    const key = newId(); item.copies.push(key);
    r.order.splice(r.settings.insertion === 'random' ? randomTicket(r.order.length + 1) : r.order.length, 0, key);
  }
  return item;
}
export function idle(state: State): void { if (state.draw && state.draw.completedAt === null) fail('spinning', 'Roulette is spinning', 409); }
export function start(state: State, r: Roulette, now: number, random = randomTicket): Draw {
  idle(state); validate(r); if (!r.order.length) fail('empty', 'Add an item before starting', 409);
  if (r.settings.shuffleBeforeDraw) shuffle(r.order, random);
  const copies = slots(r); let ticket = random(copies.reduce((n, s) => n + s.weight, 0));
  const winner = copies.find(s => { if (ticket < s.weight) return true; ticket -= s.weight; return false; })!;
  state.activeId = r.id; if (r.settings.showOnStart) state.visible = true; state.hideAt = null;
  state.draw = { id: newId(), rouletteId: r.id, startedAt: now, endsAt: now + r.durationSeconds * 1000, completedAt: null, winner, slots: copies, design: r.design, cardSize: r.cardSize, colors: [...r.colors], winnerAction: r.settings.winnerAction, hideAfterSeconds: r.settings.hideAfterSeconds };
  return state.draw;
}
/** Completion and winner removal are saved in the same compare-and-swap as state. */
export function settle(state: State, now: number): boolean {
  let changed = false; const draw = state.draw;
  if (draw && draw.completedAt === null && now >= draw.endsAt) {
    draw.completedAt = draw.endsAt;
    const r = state.roulettes.find(r => r.id === draw.rouletteId);
    const item = r?.items.find(i => i.id === draw.winner.itemId);
    if (r && item && draw.winnerAction === 'remove-item') remove(r, item.id);
    if (r && item && draw.winnerAction === 'remove-copy' && item.copies.includes(draw.winner.key)) {
      item.copies = item.copies.filter(key => key !== draw.winner.key); item.multiplier = item.copies.length;
      r.order = r.order.filter(key => key !== draw.winner.key);
      if (!item.multiplier) r.items = r.items.filter(i => i.id !== item.id);
    }
    const { slots: _slots, ...result } = draw;
    state.history = [result, ...state.history].slice(0, 100);
    state.hideAt = draw.hideAfterSeconds === null ? null : draw.endsAt + draw.hideAfterSeconds * 1000;
    changed = true;
  }
  if (state.hideAt !== null && now >= state.hideAt) { state.visible = false; state.hideAt = null; changed = true; }
  return changed;
}
