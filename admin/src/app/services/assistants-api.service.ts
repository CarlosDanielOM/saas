import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, Pagination, httpParams } from './api-util';

/**
 * The two assistants.
 *
 * Dima assistant (inside the dashboard, for streamers and their editors): chats are private between the
 * person and DomDimaBot's operators. Nobody else on the channel can read them; the operator can, here.
 * The list gives each turn's question as a short preview; the detail gives the whole exchange.
 * (Refusals keep their own page, `/assistant-refusals`.)
 *
 * Docs assistant (public "Ask the docs"): anonymous; questions and answers are shown.
 */
export type AssistantTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'queued' | 'running' | 'awaiting_approval' | 'awaiting_input';

export interface AssistantTurn {
  id: string;
  /** When the person sent the message. */
  at: string;
  channelID: string;
  channel: string | null;
  user: { id: string; login: string; name: string; role: 'owner' | 'admin' };
  plan: 'free' | 'premium' | 'pro';
  level: 'standard' | 'expert';
  /** Expert was declined by the safety filter and Standard finished the turn. */
  fellBack: boolean;
  models: string[];
  status: AssistantTurnStatus;
  /** e.g. model_timeout, model_overloaded, internal_error; null when it ended normally. */
  errorCode: string | null;
  lang: string;
  /** Dashboard route the person was on. */
  pageRoute: string | null;
  /** What the person asked, clipped to 300 characters; null when there is no text (see `textKept`). */
  question: string | null;
  /**
   * False once the conversation text was cleared: the dashboard tells people their chat is kept for 3 days, so the
   * text is removed 3 days after the message and only the numbers remain.
   */
  textKept: boolean;
  steps: number;
  /** Tool names and how each call ended (done, error, denied, expired…). Arguments and results are in the detail. */
  tools: Array<{ name: string; state: string; ms: number | null; approval: string | null }>;
  /** Daily messages the turn used. */
  units: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  providerUSD: number;
  durationMs: number;
  activeMs: number;
  feedback: 'helpful' | 'unhelpful' | null;
}

/** One turn with the whole exchange. */
export interface AssistantTurnDetail extends Omit<AssistantTurn, 'tools'> {
  /** What the person wrote, in full (up to 4,000 characters); null when it was not recorded. */
  message: string | null;
  /** What they added while the assistant was working, oldest first. */
  steers: string[];
  /** Everything the assistant wrote back, in order (up to 12,000 characters); null when it wrote nothing or it was not recorded. */
  answer: string | null;
  /** Each tool call in order, with its arguments and result as text (each up to 2,000 characters; null when empty). */
  tools: Array<{ name: string; state: string; ms: number | null; approval: string | null; args: string | null; result: string | null }>;
}

export interface AssistantTurnQuery {
  channel?: string | null;
  /** Twitch id of the person who used it. */
  user?: string | null;
  /** 'problems' = failed or interrupted. */
  status?: 'completed' | 'cancelled' | 'problems' | null;
  level?: 'standard' | 'expert' | null;
  /** ISO times. Default: the last 30 days. Turns are kept 90 days. */
  from?: string | null;
  to?: string | null;
  sort?: 'newest' | 'cost' | 'slowest' | null;
  page?: number;
  limit?: number;
}

export interface AssistantDay {
  /** UTC day. */
  date: string;
  turns: number;
  completed: number;
  failed: number;
  cancelled: number;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  providerUSD: number;
  helpful: number;
  unhelpful: number;
}

export interface AssistantSummary {
  from: string;
  to: string;
  /**
   * Per-day totals for all channels, oldest first, zeros included. These come from the assistant's own day
   * counters, so they also cover the days before per-turn records were kept.
   */
  daily: AssistantDay[];
  totals: Omit<AssistantDay, 'date'> & { channels: number; people: number };
  /** From per-turn records in the range. */
  byLevel: Array<{ level: 'standard' | 'expert'; turns: number; failed: number; providerUSD: number; avgDurationMs: number }>;
  byModel: Array<{ model: string; turns: number; providerUSD: number }>;
  /** `cancelled` = stopped by the person. */
  byChannel: Array<{ channelID: string; channel: string | null; plan: 'free' | 'premium' | 'pro'; turns: number; failed: number; cancelled: number; units: number; providerUSD: number; lastAt: string }>;
  byTool: Array<{ name: string; calls: number; failed: number }>;
  errors: Array<{ code: string; count: number; lastAt: string }>;
  /** Expert answers the safety filter declined. */
  refusals: { week: number; total: number };
  /** Today's use of the daily message limit, per channel that used any. */
  limitsToday: Array<{ channelID: string; channel: string | null; used: number; limit: number }>;
  /** First day per-turn records exist; null while there are none. Lists and breakdowns start here. */
  recordsSince: string | null;
}

export interface AssistantTurnList {
  rows: AssistantTurn[];
  pagination: Pagination;
}

export interface DocsAnswer {
  id: string;
  at: string;
  lang: string;
  /** The docs page the visitor was on. */
  page: string | null;
  /** Position in the visitor's chat (1 = first question). */
  turn: number;
  question: string;
  answer: string;
  sources: string[];
  tools: string[];
  rounds: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  providerUSD: number;
  stopReason: string | null;
  /** Why it could not be answered (timeout, busy, unavailable); null for an answered question. */
  failed: string | null;
  feedback: 'helpful' | 'unhelpful' | null;
}

export interface DocsDay {
  date: string;
  asked: number;
  answered: number;
  failed: number;
  /** Asked but neither answered nor failed: the visitor closed the panel first. */
  abandoned: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  providerUSD: number;
  helpful: number;
  unhelpful: number;
}

export interface DocsSummary {
  from: string;
  to: string;
  /** Oldest first, zeros included. */
  daily: DocsDay[];
  totals: Omit<DocsDay, 'date'>;
  /** Failures by reason (timeout, busy, unavailable). */
  failures: Array<{ reason: string; count: number }>;
  /** From stored answers (kept 30 days). */
  byLang: Array<{ lang: string; answers: number }>;
  topPages: Array<{ page: string; answers: number }>;
  medianDurationMs: number;
}

export interface DocsAnswerQuery {
  lang?: 'en' | 'es' | null;
  /** 'none' = not rated. */
  feedback?: 'helpful' | 'unhelpful' | 'none' | null;
  sort?: 'newest' | 'cost' | 'slowest' | null;
  page?: number;
  limit?: number;
}

export interface DocsAnswerList {
  rows: DocsAnswer[];
  pagination: Pagination;
}

@Injectable({ providedIn: 'root' })
export class AssistantsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly base = () => `${this.links.getApiUrl()}/admin-site`;

  /** `GET /admin-site/assistant/summary` (from, to; default the last 30 days, at most 120) */
  assistantSummary(range: { from?: string | null; to?: string | null; channel?: string | null } = {}): Observable<Envelope<AssistantSummary>> {
    return this.http.get<Envelope<AssistantSummary>>(`${this.base()}/assistant/summary`, { params: httpParams(range) });
  }

  /** `GET /admin-site/assistant/turns` */
  assistantTurns(query: AssistantTurnQuery = {}): Observable<Envelope<AssistantTurnList>> {
    return this.http.get<Envelope<AssistantTurnList>>(`${this.base()}/assistant/turns`, { params: httpParams(query) });
  }

  /** `GET /admin-site/assistant/turns/:id`: one turn with what was asked, what the tools did and what was answered. */
  assistantTurn(id: string): Observable<Envelope<AssistantTurnDetail>> {
    return this.http.get<Envelope<AssistantTurnDetail>>(`${this.base()}/assistant/turns/${encodeURIComponent(id)}`);
  }

  /** `GET /admin-site/docs-assistant/summary` (from, to; default the last 30 days, at most 120) */
  docsSummary(range: { from?: string | null; to?: string | null } = {}): Observable<Envelope<DocsSummary>> {
    return this.http.get<Envelope<DocsSummary>>(`${this.base()}/docs-assistant/summary`, { params: httpParams(range) });
  }

  /** `GET /admin-site/docs-assistant/answers` */
  docsAnswers(query: DocsAnswerQuery = {}): Observable<Envelope<DocsAnswerList>> {
    return this.http.get<Envelope<DocsAnswerList>>(`${this.base()}/docs-assistant/answers`, { params: httpParams(query) });
  }
}
