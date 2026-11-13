import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, Pagination, httpParams } from './api-util';

/**
 * Chat protection decisions: every message the bot judged, by AI review or by a plain rule (caps, links,
 * blocked words), what it decided, what it did about it, what it cost, and the operator's verdict.
 */

/** What the reviewer concluded. `uncertain` covers "not sure" and reviews that never finished. */
export type DecisionVerdict = 'allow' | 'violation' | 'uncertain';
/** The operator's verdict: this message should be a ban, or should not. */
export type DecisionLabel = 'violation' | 'allow';

/**
 * What happened in chat, in the operator's terms:
 * - allowed: nothing was done (the message was fine, or the review was unsure and let it pass).
 * - acted: the bot acted (see `action`) and Twitch accepted it.
 * - action_failed: the bot tried to act and Twitch refused.
 * - not_reviewed: the review did not finish (timeout, provider down, no credits) so the message passed.
 */
export type DecisionOutcome = 'allowed' | 'acted' | 'action_failed' | 'not_reviewed';

/** Filter shortcuts over verdict + outcome. */
export type DecisionShow = 'acted' | 'bans' | 'near_miss' | 'allowed' | 'not_reviewed' | 'action_failed';

export interface DecisionRow {
  id: string;
  /** ISO time the message was sent. */
  at: string;
  channelID: string;
  channel: string | null;
  chatter: { id: string; login: string | null; name: string };
  messageText: string;
  /** 'ai' = judged by a model; 'rule' = a plain rule matched (caps, links, emote spam, blocked words). */
  kind: 'ai' | 'rule';
  /** 'builtin' for built-in chat protection, otherwise the rule's type (caps, links, emote_spam, blacklist). */
  ruleType: string;
  /** The rule's own reason text, as the streamer wrote it; null for built-in protection. */
  ruleReason: string | null;
  /** Why it was reviewed: the chatter's first messages, every message (opt-in), or a streamer rule. */
  source: 'first_message' | 'spam_continuous' | 'rule';
  /** For first-message reviews: which of the chatter's messages this was (1, 2 or 3); null otherwise. */
  messageOrdinal: number | null;
  verdict: DecisionVerdict;
  /** Raw review status: completed, uncertain, matched, timeout, unavailable, rate_limited, credits_unavailable… */
  status: string;
  outcome: DecisionOutcome;
  /** warn | delete | timeout | ban, when the bot acted or tried to. */
  action: string | null;
  /** Twitch's error text when the action failed. */
  actionError: string | null;
  /** Model without its date suffix ("openai/gpt-6-luna-decisions"); null for rules. */
  model: string | null;
  provider: string | null;
  /** 0–1 per category the model was asked about, plus `safe` and `violation` (the highest category). Null when it never answered. */
  scores: Record<string, number> | null;
  /** The ban bar this channel had at the time, 0–100; null for rules. */
  thresholdPercent: number | null;
  inputTokens: number;
  /** What the provider charged us, USD. */
  providerUSD: number;
  /** AI credits charged to the channel (0 for included reviews). */
  credits: number;
  /** One of the plan's included reviews: never charged. */
  included: boolean;
  /** Time the model took, ms; 0 for rules. */
  latencyMs: number;
  /** An AI review that came close: not a ban, but the top score reached 50% and the model was not sure it was safe. */
  nearMiss: boolean;
  feedback: { label: DecisionLabel; note: string | null; reviewedAt: string } | null;
}

export interface DecisionDetail extends DecisionRow {
  /** Chat in the minute before the message, oldest first. */
  context: Array<{ username: string; message: string; isBroadcaster: boolean; at: string | null }>;
  /** The streamer had invited viewers to share links, which changes what counts as self-promotion. */
  invited: boolean;
  /** Categories this channel had switched on. */
  categories: string[];
  /** The chatter's other decisions in this channel, newest first, at most 10 (this one excluded). */
  history: Array<Pick<DecisionRow, 'id' | 'at' | 'messageText' | 'verdict' | 'outcome' | 'action'>>;
}

export type DecisionSort = 'newest' | 'cost' | 'score' | 'slowest';

export interface DecisionQuery {
  channel?: string | null;
  /** Chatter Twitch id. */
  chatter?: string | null;
  /** Chatter display name or login, exact match, any case. */
  chatterName?: string | null;
  show?: DecisionShow | null;
  kind?: 'ai' | 'rule' | null;
  source?: DecisionRow['source'] | null;
  /** Model without date suffix. */
  model?: string | null;
  /** 'none' = no verdict yet; 'any' = has one; 'agree' / 'disagree' = the verdict matches / contradicts what the bot did. */
  feedback?: 'none' | 'any' | 'agree' | 'disagree' | null;
  /** ISO times. Default: the last 30 days. Decisions are kept 180 days. */
  from?: string | null;
  to?: string | null;
  sort?: DecisionSort | null;
  page?: number;
  /** Default 25, at most 50. */
  limit?: number;
}

export interface DecisionList {
  rows: DecisionRow[];
  pagination: Pagination;
}

export interface DecisionSummary {
  from: string;
  to: string;
  /** Everything in the range, AI reviews and rule hits. */
  total: number;
  aiReviews: number;
  ruleHits: number;
  /** AI reviews whose verdict was "violation". */
  violations: number;
  /** Bans that Twitch accepted / refused. */
  bans: number;
  bansFailed: number;
  /** Reviews that never finished (timeout, provider down…): the message passed unreviewed. */
  notReviewed: number;
  /** Reviews that were one of the plan's included ones. */
  included: number;
  providerUSD: number;
  credits: number;
  /** Median and 95th percentile model time over finished AI reviews, ms. */
  latencyP50Ms: number;
  latencyP95Ms: number;
  channels: number;
  /** Operator verdicts in the range. `agree` = the verdict matches what the bot did. */
  labelled: number;
  agree: number;
  disagree: number;
  /** Cards waiting in the review queue (all time, not just this range). */
  verdictsWaiting: number;
  /** One row per UTC day in the range, oldest first, zeros included. */
  daily: Array<{ date: string; reviews: number; violations: number; notReviewed: number; providerUSD: number }>;
  /** `violations` = the model's verdict was a ban; `bans` = bans Twitch accepted. */
  byModel: Array<{ model: string; reviews: number; violations: number; bans: number; notReviewed: number; providerUSD: number; latencyP50Ms: number }>;
  /** Busiest channels in the range, at most 10. */
  byChannel: Array<{ channelID: string; channel: string | null; reviews: number; violations: number; providerUSD: number }>;
}

@Injectable({ providedIn: 'root' })
export class DecisionsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly url = () => `${this.links.getApiUrl()}/admin-site/decisions`;

  /** `GET /admin-site/decisions` */
  list(query: DecisionQuery = {}): Observable<Envelope<DecisionList>> {
    return this.http.get<Envelope<DecisionList>>(this.url(), { params: httpParams(query) });
  }

  /** `GET /admin-site/decisions/summary` (takes channel, chatter, from, to) */
  summary(query: Pick<DecisionQuery, 'channel' | 'chatter' | 'from' | 'to'> = {}): Observable<Envelope<DecisionSummary>> {
    return this.http.get<Envelope<DecisionSummary>>(`${this.url()}/summary`, { params: httpParams(query) });
  }

  /** `GET /admin-site/decisions/:id` */
  get(id: string): Observable<Envelope<DecisionDetail>> {
    return this.http.get<Envelope<DecisionDetail>>(`${this.url()}/${encodeURIComponent(id)}`);
  }

  /**
   * `PUT /admin-site/decisions/:id/feedback`: saves the operator's verdict on this one decision;
   * `label: null` removes it. Changes nothing for the chatter. `note` is optional, at most 500 characters.
   */
  setFeedback(id: string, label: DecisionLabel | null, note?: string | null): Observable<Envelope<{ feedback: DecisionRow['feedback'] }>> {
    return this.http.put<Envelope<{ feedback: DecisionRow['feedback'] }>>(`${this.url()}/${encodeURIComponent(id)}/feedback`, { label, note: note || null });
  }
}
