/**
 * Pure helpers that turn the wire transcript into what the panel shows: blocks per turn,
 * tool runs, before → after rows. No Angular imports (testable in Node).
 */
import type { ApprovalState, DisplayItem, TurnStatus } from './assistant.types';

export type UserItem = Extract<DisplayItem, { kind: 'user' }>;
export type AssistantItem = Extract<DisplayItem, { kind: 'assistant' }>;
export type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;
export type UiItem = Extract<DisplayItem, { kind: 'ui' }>;
export type ApprovalItem = Extract<DisplayItem, { kind: 'approval' }>;
export type NavigateItem = Extract<DisplayItem, { kind: 'navigate' }>;
export type NoticeItem = Extract<DisplayItem, { kind: 'notice' }>;

export const ACTIVE_STATUSES: readonly TurnStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_input'];
export const RETRYABLE_STATUSES: readonly TurnStatus[] = ['failed', 'cancelled', 'interrupted'];

export function isActiveStatus(status: TurnStatus | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.includes(status);
}

export type Block =
  | { type: 'user'; key: string; item: UserItem }
  /** Assistant text followed by more work in the same turn: shown muted. */
  | { type: 'note'; key: string; item: AssistantItem }
  /** Final answer, or the text still streaming at the end of the turn. */
  | { type: 'answer'; key: string; item: AssistantItem }
  | { type: 'tools'; key: string; items: ToolItem[] }
  | { type: 'approval'; key: string; item: ApprovalItem }
  | { type: 'ui'; key: string; item: UiItem }
  | { type: 'navigate'; key: string; item: NavigateItem }
  | { type: 'notice'; key: string; item: NoticeItem };

export interface TurnView {
  turnId: string;
  blocks: Block[];
}

/** Group the transcript by turn (in order of first appearance) and fold consecutive tool rows. */
export function buildTurns(items: readonly DisplayItem[]): TurnView[] {
  const turns: TurnView[] = [];
  const byId = new Map<string, { view: TurnView; items: DisplayItem[] }>();
  for (const item of items) {
    let entry = byId.get(item.turnId);
    if (!entry) {
      entry = { view: { turnId: item.turnId, blocks: [] }, items: [] };
      byId.set(item.turnId, entry);
      turns.push(entry.view);
    }
    entry.items.push(item);
  }
  for (const { view, items: turnItems } of byId.values()) {
    turnItems.forEach((item, index) => {
      const last = view.blocks[view.blocks.length - 1];
      switch (item.kind) {
        case 'user':
          view.blocks.push({ type: 'user', key: item.id, item });
          break;
        case 'assistant': {
          if (!item.text.trim() && !item.final) break;
          // Text followed by more work (tools, cards, more text) was a progress note.
          const laterWork = turnItems.slice(index + 1).some((next) => next.kind !== 'user' && next.kind !== 'notice');
          view.blocks.push({ type: !item.final && laterWork ? 'note' : 'answer', key: item.id, item });
          break;
        }
        case 'tool':
          if (last?.type === 'tools') last.items.push(item);
          else view.blocks.push({ type: 'tools', key: item.id, items: [item] });
          break;
        case 'ui':
          view.blocks.push({ type: 'ui', key: item.id, item });
          break;
        case 'approval':
          view.blocks.push({ type: 'approval', key: item.id, item });
          break;
        case 'navigate':
          view.blocks.push({ type: 'navigate', key: item.id, item });
          break;
        case 'notice':
          view.blocks.push({ type: 'notice', key: item.id, item });
          break;
      }
    });
  }
  return turns;
}

/** Insert or replace an item by id, keeping its position. */
export function upsertItem(items: readonly DisplayItem[], item: DisplayItem): DisplayItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

// ---------------------------------------------------------------------------
// Approval outcome
// ---------------------------------------------------------------------------

/** What an approval card shows. `unknown` = the write started but its result is unknown (timeout, restart). */
export type ApprovalView = ApprovalState | 'unknown';

/** Error codes the runner puts on a failed approval (anything else is the tool's own sentence, e.g. a conflict). */
const APPROVAL_ERROR_CODES = new Set(['permission_denied', 'apply_failed', 'outcome_unknown']);

export function approvalView(state: ApprovalState, error: string | undefined, expired = false): ApprovalView {
  if (state === 'pending') return expired ? 'expired' : 'pending';
  if (state === 'failed' && error === 'outcome_unknown') return 'unknown';
  return state;
}

/**
 * The sentence under a failed (or unknown) card: an i18n key, or the tool's own text (conflicts arrive as a full
 * sentence that already says nothing was changed). Unknown codes never claim nothing changed.
 */
export function approvalProblem(state: ApprovalState, error: string | undefined): { key: string } | { text: string } | null {
  if (state !== 'failed') return null;
  const value = (error ?? '').trim();
  if (APPROVAL_ERROR_CODES.has(value)) return { key: `assistant.approval.problem.${value}` };
  if (!value || /^[a-z][a-z0-9_]*$/.test(value)) return { key: 'assistant.approval.problem.other' };
  return { text: value };
}

export const DOCS_TOOLS = new Set(['search_docs', 'read_docs', 'search_ast_functions']);

export type ToolRunState = 'running' | 'waiting' | 'done' | 'problem';

export interface ToolRunSummary {
  /** i18n key under `assistant.tools` + params. */
  key: string;
  params: Record<string, string | number>;
  state: ToolRunState;
  /** Label of the tool that is running right now (server text), if any. */
  runningLabel: string | null;
  problems: number;
}

const PROBLEM_STATES = new Set(['error', 'denied', 'interrupted', 'expired']);

export function summarizeTools(items: readonly ToolItem[]): ToolRunSummary {
  const running = items.find((item) => item.state === 'running' || item.state === 'pending');
  const waiting = items.some((item) => item.state === 'awaiting_approval' || item.state === 'awaiting_input');
  const problems = items.filter((item) => PROBLEM_STATES.has(item.state)).length;
  const state: ToolRunState = running ? 'running' : waiting ? 'waiting' : problems ? 'problem' : 'done';
  const runningLabel = running?.label ?? null;
  const pages = items.filter((item) => item.name === 'read_docs').length;
  const allDocs = items.every((item) => DOCS_TOOLS.has(item.name));
  if (items.length === 1) return { key: 'single', params: { label: items[0].label }, state, runningLabel, problems };
  if (allDocs && pages > 0) return { key: pages === 1 ? 'docsPagesOne' : 'docsPages', params: { count: pages }, state, runningLabel, problems };
  if (allDocs) return { key: 'docsSearched', params: { count: items.length }, state, runningLabel, problems };
  return { key: 'steps', params: { count: items.length }, state, runningLabel, problems };
}

// ---------------------------------------------------------------------------
// Before → after
// ---------------------------------------------------------------------------

export interface FieldValue {
  text: string;
  /** Command bodies, long or multi-line text: monospace block. */
  mono: boolean;
  empty: boolean;
  /** Boolean values are translated by the caller ('on' | 'off'). */
  bool?: 'on' | 'off';
}

export interface FieldChange {
  key: string;
  label: string;
  before: FieldValue | null;
  after: FieldValue | null;
  /** True when before or after renders as a block. */
  block: boolean;
}

const MONO_KEYS = /(message|body|response|code|template|script|command|text|action|reply|content|respuesta|mensaje|texto|c[oó]digo|comando|acci[oó]n|acciones)$/i;

export function humanizeKey(key: string): string {
  if (!/^[a-z][a-zA-Z0-9_]*$/.test(key)) return key;
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function displayValue(key: string, value: unknown, locale = 'en'): FieldValue {
  if (value === null || value === undefined || value === '') return { text: '—', mono: false, empty: true };
  if (typeof value === 'boolean') return { text: value ? 'on' : 'off', mono: false, empty: false, bool: value ? 'on' : 'off' };
  if (typeof value === 'number') return { text: value.toLocaleString(locale), mono: false, empty: false };
  if (typeof value === 'string') {
    const mono = value.includes('\n') || value.length > 60 || MONO_KEYS.test(key) || /\$\(/.test(value);
    return { text: value, mono, empty: false };
  }
  if (Array.isArray(value) && value.every((part) => ['string', 'number', 'boolean'].includes(typeof part))) {
    return value.length ? { text: value.join(', '), mono: false, empty: false } : { text: '—', mono: false, empty: true };
  }
  return { text: JSON.stringify(value, null, 2), mono: true, empty: false };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Changed fields only. A new thing (before null) lists every field of `after`; a removed one
 * (after null) lists every field of `before`.
 */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null, locale = 'en'): FieldChange[] {
  const keys: string[] = [];
  for (const key of [...Object.keys(before ?? {}), ...Object.keys(after ?? {})]) if (!keys.includes(key)) keys.push(key);
  const changes: FieldChange[] = [];
  for (const key of keys) {
    const oldValue = before ? before[key] : undefined;
    const newValue = after ? after[key] : undefined;
    if (before && after && same(oldValue, newValue)) continue;
    const beforeValue = before ? displayValue(key, oldValue, locale) : null;
    const afterValue = after ? displayValue(key, newValue, locale) : null;
    if (!before && afterValue?.empty) continue;
    if (!after && beforeValue?.empty) continue;
    changes.push({
      key,
      label: humanizeKey(key),
      before: beforeValue,
      after: afterValue,
      block: !!(beforeValue?.mono || afterValue?.mono),
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function relativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (abs < 45) return format.format(0, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

export function clockTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** "14:05" style countdown (m:ss, or h:mm:ss over an hour). */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
