import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope, httpParams } from './api-util';
import { FeedOutcome } from './feed-api.service';

/** Per-channel debugging data for the channel workspace. */

export type BotLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** One line the bot logged about this channel (kept 7 days). */
export interface BotLogEntry {
  id: string;
  at: string;
  level: BotLogLevel;
  /** Where in the bot it was logged, e.g. "redemptionHandler"; null when the line did not say. */
  function: string | null;
  /** The line's message or error text, clipped to 300 characters; null when it had none. */
  message: string | null;
  /** Its other fields, flattened to plain values. Tokens, keys and emails are removed. */
  data: Record<string, string | number | boolean | null>;
}

export interface BotLogPage {
  /** Newest first. */
  entries: BotLogEntry[];
  /** More lines matched than were returned. */
  truncated: boolean;
  /** Lines per level in the 7 days, whatever the level filter. */
  counts: Record<BotLogLevel, number>;
}

export interface CommandStat {
  /** As typed in chat, e.g. "!so". */
  name: string;
  runs: number;
  ok: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** Runs that went wrong: failed, or refused for a reason that is not a setting. Absent from an older API. */
  problems?: number;
  /** Runs the bot answered, usage replies included. Absent from an older API (then `ok`). */
  answered?: number;
  lastAt: string;
  lastOutcome: FeedOutcome;
  lastReason: string | null;
  /** Why it did not answer, most common first, at most 3 (usage replies answered, so they are not here). */
  reasons: Array<{ reason: string; count: number }>;
}

export interface CommandStats {
  from: string;
  to: string;
  /** Most used first, at most 200. */
  commands: CommandStat[];
  /** When command runs started being recorded for this channel; null when none are recorded yet. */
  recordsSince: string | null;
}

/** What we know about one Twitch event type for this channel. */
export interface EventTypeActivity {
  /** Twitch type, e.g. "channel.follow". */
  type: string;
  /** Last notification of this type, in the last 30 days; null when none. */
  lastReceivedAt: string | null;
  received7d: number;
  /** The last chat alert for it: sent, or skipped and why. Null when this type has no chat alert or none ran. */
  lastAlert: { at: string; outcome: FeedOutcome; reason: string | null } | null;
  /** Deliveries of this type the bot gave up on, last 30 days. */
  failedDeliveries: number;
}

export interface EventsubActivity {
  types: EventTypeActivity[];
  /** Twitch subscriptions for this channel that Twitch revoked, last 30 days, newest first. */
  revoked: Array<{ at: string; type: string; reason: string | null }>;
}

@Injectable({ providedIn: 'root' })
export class ChannelDebugApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly url = (channelID: string) => `${this.links.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}`;

  /**
   * `GET /admin-site/users/:channelID/logs`
   * `level`: 'problems' (warn and above, the default) or one level. `limit` default 50, at most 200.
   */
  logs(channelID: string, query: { level?: 'problems' | BotLogLevel | null; limit?: number } = {}): Observable<Envelope<BotLogPage>> {
    return this.http.get<Envelope<BotLogPage>>(`${this.url(channelID)}/logs`, { params: httpParams(query) });
  }

  /** `GET /admin-site/users/:channelID/command-stats` (`days` default 7, at most 30) */
  commandStats(channelID: string, days = 7): Observable<Envelope<CommandStats>> {
    return this.http.get<Envelope<CommandStats>>(`${this.url(channelID)}/command-stats`, { params: httpParams({ days }) });
  }

  /** `GET /admin-site/users/:channelID/eventsub-activity` */
  eventsubActivity(channelID: string): Observable<Envelope<EventsubActivity>> {
    return this.http.get<Envelope<EventsubActivity>>(`${this.url(channelID)}/eventsub-activity`);
  }
}
