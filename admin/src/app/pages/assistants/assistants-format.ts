/**
 * Plain words for the two assistant pages (`/ai/assistant`, `/ai/docs`): tool ids, error codes, how a turn or a
 * tool call ended. Numbers, money and time come from `shared/format.ts`.
 */
import type { AssistantTurnStatus } from '../../services/assistants-api.service';

import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** True at 960px and up (the two-column layout), kept current as the window changes. Call in an injection context. */
export function wideScreen(): Signal<boolean> {
  const query = typeof matchMedia === 'function' ? matchMedia('(min-width: 960px)') : null;
  const wide = signal(query?.matches ?? true);
  if (query) {
    const update = (event: MediaQueryListEvent) => wide.set(event.matches);
    query.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', update));
  }
  return wide.asReadonly();
}

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted';

/** The tools the assistants call most, as what they did. */
const TOOL_TEXT: Record<string, string> = {
  read_docs: 'Read the docs',
  search_docs: 'Searched the docs',
  test_command: 'Tested a command',
  search_ast_functions: 'Looked up functions',
  list_commands: 'Listed commands',
  get_command: 'Opened a command',
  create_command: 'Created a command',
  update_command: 'Changed a command',
  delete_command: 'Deleted a command',
  get_settings: 'Read settings',
  navigate: 'Opened a page',
  show_ui: 'Showed a form',
  channel_overview: 'Read the channel overview',
};

/** `read_docs` → "Read the docs"; others plainly: `create_timer` → "Create timer". */
export function toolLabel(name: string): string {
  if (TOOL_TEXT[name]) return TOOL_TEXT[name];
  const words = name.replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** `openai/gpt-6-luna` → `gpt-6-luna`: the owner cares which model ran, not the router prefix. */
export function modelName(model: string): string {
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

const ERROR_TEXT: Record<string, string> = {
  model_timeout: 'The model took too long',
  model_overloaded: 'The provider was overloaded',
  model_rate_limited: 'The provider hit its rate limit',
  model_error: 'The model returned an error',
  internal_error: 'Our server hit an error',
  lease_lost: 'Another server took over the message',
  access_revoked: 'The person lost access mid-answer',
  interrupted: 'The bot restarted mid-answer',
  expert_fallback: 'Expert declined, Standard answered',
};

/** An error code in plain words; unknown codes as written. */
export function errorLabel(code: string | null): string {
  if (!code) return 'Unknown error';
  return ERROR_TEXT[code] ?? code;
}

const STATUS: Record<AssistantTurnStatus, { label: string; tone: Tone }> = {
  completed: { label: 'Answered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  interrupted: { label: 'Interrupted', tone: 'danger' },
  cancelled: { label: 'Stopped by the person', tone: 'muted' },
  queued: { label: 'Waiting to start', tone: 'accent' },
  running: { label: 'Still answering', tone: 'accent' },
  awaiting_approval: { label: 'Waiting for approval', tone: 'accent' },
  awaiting_input: { label: 'Waiting for the person', tone: 'accent' },
};

export function turnStatus(status: string): { label: string; tone: Tone } {
  return STATUS[status as AssistantTurnStatus] ?? { label: status, tone: 'muted' };
}

const TOOL_STATE: Record<string, { label: string; tone: Tone }> = {
  done: { label: 'done', tone: 'ok' },
  error: { label: 'failed', tone: 'danger' },
  interrupted: { label: 'interrupted', tone: 'danger' },
  denied: { label: 'not allowed', tone: 'warn' },
  declined: { label: 'declined by the person', tone: 'warn' },
  expired: { label: 'expired', tone: 'warn' },
  superseded: { label: 'replaced', tone: 'muted' },
  pending: { label: 'waiting', tone: 'muted' },
  running: { label: 'running', tone: 'muted' },
  awaiting_approval: { label: 'waiting for approval', tone: 'muted' },
  awaiting_input: { label: 'waiting for the person', tone: 'muted' },
};

export function toolState(state: string): { label: string; tone: Tone } {
  return TOOL_STATE[state] ?? { label: state.replace(/_/g, ' '), tone: 'muted' };
}

const APPROVAL: Record<string, string> = {
  pending: 'approval pending',
  applied: 'approved and applied',
  skipped: 'skipped',
  expired: 'approval expired',
  failed: 'approved, apply failed',
  superseded: 'replaced',
};

export function approvalLabel(approval: string | null): string | null {
  return approval ? (APPROVAL[approval] ?? approval.replace(/_/g, ' ')) : null;
}

/** "The model took too long" → "the model took too long" (acronyms like AI stay). */
export function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Joins meta parts with " · ": each part keeps its own words together and the dot sticks to the part before it. */
export function metaLine(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).map((part) => part!.replace(/ /g, '\u00a0')).join('\u00a0· ');
}

/** Docs AI failure reasons (`timeout`, `busy`, `unavailable`). */
const DOCS_FAILURE: Record<string, string> = {
  timeout: 'The AI took too long',
  busy: 'Too many questions at once',
  unavailable: 'The AI was unavailable',
  error: 'Our server hit an error',
};

export function docsFailureLabel(reason: string | null): string {
  if (!reason) return 'Not answered';
  return DOCS_FAILURE[reason] ?? reason.replace(/_/g, ' ');
}

/** Stop reasons that mean "finished normally": nothing worth showing. */
export const NORMAL_STOPS = new Set(['end_turn', 'stop', 'stop_sequence', 'completed', 'tool_use']);

export const LANG_NAME: Record<string, string> = { en: 'English', es: 'Spanish' };
export const langName = (lang: string): string => LANG_NAME[lang] ?? lang.toUpperCase();

/** `https://docs.domdimabot.com/en/commands/` → `/en/commands/` for a compact source link label. */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.hash}` || url;
  } catch {
    return url;
  }
}

/** Only http(s) links leave the page. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
