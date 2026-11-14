import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, httpParams } from './api-util';

/**
 * The activity feed: one time-ordered list of what happened, across every channel or for one channel or
 * one chatter. The API builds it from several stores (the bot's activity log, journaled Twitch events,
 * chat protection decisions, AI usage receipts, assistant turns, docs answers).
 */
export const FEED_KINDS = [
  'command', 'bot_message', 'twitch_event', 'alert', 'protection', 'voice', 'ai', 'assistant', 'docs', 'credits', 'system',
] as const;
/**
 * - command: a chat command ran, or was refused (cooldown, permission, turned off).
 * - bot_message: something the bot said in chat, or tried to say.
 * - twitch_event: a notification Twitch sent us (follow, sub, bits, raid, reward redeemed, stream start…).
 * - alert: the chat alert for an event: sent, or skipped and why.
 * - protection: a chat protection decision (AI review or a rule hit) and what was done about it.
 * - voice: a text-to-speech request.
 * - ai: other AI work charged to the channel (chat replies, memory summaries).
 * - assistant: a Dima assistant turn; `text` is what the person asked.
 * - docs: a question answered by the docs assistant.
 * - credits: credits added or removed (grants, packs, monthly reset).
 * - system: things the bot did on its own (a Twitch subscription was revoked, stream start/end steps).
 */
export type FeedKind = (typeof FEED_KINDS)[number];

/**
 * - ok: it happened as intended.
 * - skipped: deliberately not done (cooldown, the alert is turned off).
 * - blocked: refused (no permission, Twitch held the message).
 * - failed: it should have happened and did not (error, timeout).
 */
export type FeedOutcome = 'ok' | 'skipped' | 'blocked' | 'failed';

export interface FeedActor {
  /** Twitch user id; null when only the name is known. */
  id: string | null;
  login: string | null;
  /** Display name. */
  name: string | null;
}

export type FeedRefType = 'decision' | 'usage' | 'event' | 'assistant_turn' | 'docs_answer' | 'activity';

export interface FeedItem {
  /** Unique across the feed: `<source>:<id>`. */
  id: string;
  /** ISO time. */
  at: string;
  kind: FeedKind;
  /**
   * What it is within the kind: the command ("!so"), the Twitch type ("channel.follow"), the voice
   * provider ("fish"), the AI operation ("final_response"), where a bot message came from ("command").
   */
  name: string;
  outcome: FeedOutcome;
  /** Machine code when the outcome is not plain ok ("cooldown", "permission_denied", "alert_disabled", "timeout"); null otherwise. */
  reason: string | null;
  channelID: string | null;
  /** Channel login; null when the channel has no account here or the row has no channel. */
  channel: string | null;
  /** The chatter, viewer or dashboard user who caused it; null when nobody did. */
  actor: FeedActor | null;
  /** Short preview (≤300 characters): the chat line, what the bot said, the reviewed message, the question. */
  text: string | null;
  /** AI credits charged to the channel (0 = included or free); null when credits do not apply. */
  credits: number | null;
  /** What the provider charged us in USD, when the bot recorded it; null when unknown. */
  providerUSD: number | null;
  durationMs: number | null;
  /**
   * A few flat facts for the detail view. Keys by kind (all optional):
   * - command: func, trigger ('chat' | 'keyword' | 'timer' | 'redemption' | 'reference'), live
   * - bot_message: origin, messageId, httpStatus, twitchMessage
   * - twitch_event: amount, tier, months, viewers, rewardTitle, rewardCost, message, test, failedDeliveries
   * - alert: event, eventKey
   * - protection: verdict, status, action, actionSucceeded, actionError, topCategory, topScore (0–1), model, included, ruleType, source
   * - voice: provider, chars, source, voice, model
   * - ai: category, operation, provider, model, tokens, source
   * - assistant: level, status, steps, tools, model, errorCode, units
   * - docs: lang, page, feedback, rounds
   * - credits: adjustmentType, source
   */
  data: Record<string, string | number | boolean | null>;
  /** Where the full record lives, for "open details". */
  ref: { type: FeedRefType; id: string } | null;
}

export interface FeedQuery {
  /** Twitch channel id. */
  channel?: string | null;
  /** Chatter Twitch id. */
  actor?: string | null;
  /** Chatter login, when the id is not known. */
  actorLogin?: string | null;
  kinds?: FeedKind[] | null;
  /**
   * 'problems' = failed, or refused for a reason that is not a setting (Twitch held the bot's message, a broken
   * permission rule); 'failed' = failed only. Skipped rows (turned off, cooldown) are never problems.
   */
  outcome?: 'problems' | 'failed' | null;
  /** ISO times. Default: the last 7 days. The window can be at most 90 days. */
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  /** Default 40, at most 100. */
  limit?: number;
}

export interface FeedPage {
  /** Newest first. */
  items: FeedItem[];
  /** Pass back as `cursor` for the next (older) page; null when there is no more. */
  nextCursor: string | null;
  /** Kinds whose store could not be read in time; the rest of the page is still good. */
  partial: FeedKind[];
}

export interface FeedKindCount {
  kind: FeedKind;
  total: number;
  /** Skipped, blocked or failed. */
  problems: number;
  /** Failed only. */
  failed: number;
}

export interface FeedSummary {
  from: string;
  to: string;
  kinds: FeedKindCount[];
  partial: FeedKind[];
}

/** One journaled Twitch event with what each part of the bot did with it. */
export interface EventDetail {
  eventKey: string;
  /** Journal type, e.g. "channel.follow.received". */
  type: string;
  /** The Twitch type it came from, e.g. "channel.follow"; null for non-Twitch events. */
  twitchType: string | null;
  source: string;
  channelID: string | null;
  channel: string | null;
  occurredAt: string;
  journaledAt: string;
  /** A test event sent from the dashboard or the admin site. */
  test: boolean;
  actor: FeedActor | null;
  /** The event as Twitch sent it, with tokens and secrets removed. */
  payload: Record<string, unknown>;
  /** One row per consumer that handles this type. */
  deliveries: Array<{
    consumer: string;
    status: 'pending' | 'processing' | 'retry' | 'succeeded' | 'skipped' | 'dead';
    attempts: number;
    /** Why it was skipped or what went wrong; null when it simply worked. */
    reason: string | null;
    completedAt: string | null;
    durationMs: number | null;
  }>;
  /** Stream start/end only: the steps the bot ran (timers, rewards, editors…). */
  steps: Array<{ step: string; status: 'completed' | 'skipped' | 'failed'; reason: string | null; at: string | null }>;
  /** Id for the Analytics trace view, when the event was traced. */
  traceId: string | null;
}

@Injectable({ providedIn: 'root' })
export class FeedApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly base = () => `${this.links.getApiUrl()}/admin-site`;

  /** `GET /admin-site/feed` */
  list(query: FeedQuery = {}): Observable<Envelope<FeedPage>> {
    return this.http.get<Envelope<FeedPage>>(`${this.base()}/feed`, {
      params: httpParams({ ...query, kinds: query.kinds?.length ? query.kinds.join(',') : null }),
    });
  }

  /** `GET /admin-site/feed/summary`: counts per kind for the same filters (kinds, outcome and paging are ignored). */
  summary(query: Pick<FeedQuery, 'channel' | 'actor' | 'actorLogin' | 'from' | 'to'> = {}): Observable<Envelope<FeedSummary>> {
    return this.http.get<Envelope<FeedSummary>>(`${this.base()}/feed/summary`, { params: httpParams(query) });
  }

  /** `GET /admin-site/events/:eventKey` */
  event(eventKey: string): Observable<Envelope<EventDetail>> {
    return this.http.get<Envelope<EventDetail>>(`${this.base()}/events/${encodeURIComponent(eventKey)}`);
  }
}
