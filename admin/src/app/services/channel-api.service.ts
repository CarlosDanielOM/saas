import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, catchError, of } from 'rxjs';

import { LinksService } from './links.service';

export interface ChannelUser {
  channelID: string;
  channel: string;
  email: string;
  plan_tier: 'free' | 'premium' | 'pro';
  actived: boolean;
  chat_enabled: boolean;
  has_permissions: boolean;
  up_to_date_permissions: boolean;
  reminder_sent_at?: string | Date | null;
  created_at?: Date;
  updated_at?: Date;
  isLive: boolean;
  liveViewers: number;
  commandsCount: number;
  eventsubsActiveCount: number;
  eventsubsDisabledCount: number;
}

export interface ChannelCommand {
  id: string;
  name: string;
  /** The trigger without "!" for commands; the phrase for keywords. */
  cmd: string;
  func: string;
  message: string;
  enabled: boolean;
  /** Seconds between uses. */
  cooldown: number;
  /** The owner set this cooldown here: chat uses it as stored, below a keyword's plan minimum too. */
  cooldownOverride?: boolean;
  userLevelName: string;
  /** 1 everyone … 10 broadcaster (see `COMMAND_USER_LEVELS`). Ignored by the bot when `permissionMode` is `tags`. */
  userLevel: number;
  /** `keyword` = fires when a chat message contains/starts with the phrase; its activation can't be changed. */
  activation: 'command' | 'keyword';
  keywordMatch: string | null;
  /** Built-in (default) command. The owner routes edit and delete it like any other; the site keeps it locked. */
  reserved: boolean;
  /** `blocks` = the reply is built with AST blocks (`blocks` holds the stored tree); the owner can edit both. */
  authoring: 'text' | 'blocks';
  /** `tags` = a custom permission rule (`permissionExpression`; picking a level replaces it); `invalid` = broken rule. */
  permissionMode: 'level' | 'tags' | 'invalid';
  /** The bot runs its own code for it (its function is a built-in action such as `promo`), so the stored reply is never posted. */
  runsBuiltIn?: boolean;
  /** The block tree of a block command as stored (`{ v, root }`), for editing as JSON; null otherwise. The owner routes accept the root or this wrapper. */
  blocks?: unknown;
  /** The custom permission rule (`permissionMode` tags/invalid), for editing as JSON; null in level mode. */
  permissionExpression?: unknown;
  description: string;
  /** The channel login stored on the command. */
  channel: string;
  createdAt?: string;
}

/** Legacy permission levels, as the site's command editor offers them (value → stored name). */
export const COMMAND_USER_LEVELS: ReadonlyArray<{ level: number; name: string; label: string }> = [
  { level: 1, name: 'everyone', label: 'Everyone' },
  { level: 2, name: 'tier1', label: 'Tier 1 subs and up' },
  { level: 3, name: 'tier2', label: 'Tier 2 subs and up' },
  { level: 4, name: 'tier3', label: 'Tier 3 subs and up' },
  { level: 5, name: 'vip', label: 'VIPs and up' },
  { level: 6, name: 'founder', label: 'Founders and up' },
  { level: 7, name: 'mod', label: 'Moderators and up' },
  { level: 8, name: 'editor', label: 'Editors and up' },
  { level: 9, name: 'admin', label: 'Admins and up' },
  { level: 10, name: 'broadcaster', label: 'Broadcaster only' },
];

/**
 * Body for creating or changing a command. The console uses the owner routes (`ownerCreateCommand` …), which
 * edit like the database: no plan limits, built-in commands fully editable and deletable, blocks on any plan,
 * activation switchable. Integrity checks stay (a trigger used twice, invalid blocks/permission rule, keyword
 * format). On update only the fields present change. See `dimabot/src/server/routes/admin_site/channel_edit.route.ts`.
 */
export interface CommandWrite {
  name?: string;
  cmd?: string;
  /** What runs: `custom` = the reply text/blocks; a built-in action name (see `builtInActions`) runs that code. */
  func?: string;
  message?: string;
  channel?: string;
  description?: string;
  /** Whole seconds 0–86,400 (no plan minimum for the owner). */
  cooldown?: number;
  enabled?: boolean;
  userLevel?: number;
  userLevelName?: string;
  /** `text` with `message`, or `blocks` with `blocks` (the server compiles them and stores the text). */
  authoring?: 'text' | 'blocks';
  blocks?: unknown;
  activation?: 'command' | 'keyword';
  keywordSettings?: { matchMode: 'start' | 'anywhere' | 'exact' };
  /** null switches to level mode (send `userLevel` too); an expression object switches to a custom rule. */
  permissionExpression?: unknown;
}

/** An owner write's answer: the saved row as the list shows it. */
export interface OwnerWriteResponse<T> {
  error: boolean;
  message: string;
  status: number;
  data: T;
}

/** The commands API's answer: `command` on success; `code` (e.g. `reserved`, `too_long`) and `message` on failure. */
export interface CommandWriteResponse {
  error: boolean;
  message: string;
  status: number;
  code?: string;
  command?: Record<string, unknown>;
}

export interface ChannelEventsub {
  id: string;
  /** The site's name for it: outgoing raids are `channel.raid.outgoing`, old cheer subscriptions `channel.bits.use`. */
  type: string;
  /** The type stored in the database (and sent by Twitch). */
  rawType: string;
  status: string;
  version: string;
  enabled: boolean;
  message: string;
  endMessage: string;
  /** Chat settings the console can edit; which ones apply to a type comes from the chat event catalog. */
  settings: EventsubSettings;
  /** Bits rules (cheer tiers) stored on it; edited on the site's Bits rules page, not here. */
  cheerTierCount: number;
  /** Twitch no longer lists this subscription since then (the bot reconnects it). */
  remoteMissingSince: string | null;
  created_at: string;
}

/** The stored chat fields of a Twitch event subscription, by their database names (every config field). */
export interface EventsubSettings {
  message: string;
  endMessage: string;
  endEnabled: boolean;
  minViewers: number;
  clipEnabled: boolean;
  /** Seconds (raids). */
  delay: number;
  modiversaryMessage: string;
  modiversaryEnabled: boolean;
  watchStreakEnabled: boolean;
  temporalBanMessage: string;
  todayFollows: boolean;
}

/**
 * One setting of a chat event, from the site's chat event catalog (`GET /site/events`), the same list the
 * site's Chat events page renders. `dbId` (or `id`) is the field it is saved to; see `chatEventFieldKey`.
 */
export interface ChatEventControl {
  id: string;
  dbId?: string;
  label: { EN?: string; ES?: string; en?: string; es?: string };
  type: 'text' | 'number' | 'checkbox' | 'message-tiers' | 'select' | string;
  /** The default for a new subscription. */
  value: unknown;
  placeholder?: string;
  /** Only shown while another control has this value (e.g. the end message while "endEnabled" is on). */
  showIf?: { controlId: string; is: unknown };
  canDisable?: boolean;
}

export interface ChatEventDefinition {
  name: string;
  type: string;
  version?: string;
  description?: { EN?: string; ES?: string; en?: string; es?: string };
  plan_tier?: 'free' | 'premium' | 'pro';
  releaseStage?: string;
  config?: ChatEventControl[];
}

/** Ids whose saved field has another name (mirrors dimasite `chat-events.contract.ts`). */
const CHAT_EVENT_FIELD_FALLBACKS: Record<string, string> = {
  adBeginMessage: 'message',
  adBreakMessage: 'message',
  beginMessage: 'message',
  enableClip: 'clipEnabled',
};

/** The eventsub field a catalog control is saved to. */
export function chatEventFieldKey(control: Pick<ChatEventControl, 'id' | 'dbId'>): string {
  return control.dbId?.trim() || CHAT_EVENT_FIELD_FALLBACKS[control.id] || control.id;
}

/**
 * Fields the console may send in an eventsub PATCH (`ownerPatchEventsub`): every stored chat setting, typed
 * (string/boolean/number). Never type, condition, status or ids; the owner route refuses anything else.
 */
export const EDITABLE_EVENTSUB_FIELDS: ReadonlyArray<keyof EventsubSettings> = [
  'message', 'endMessage', 'endEnabled', 'minViewers', 'clipEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled',
  'watchStreakEnabled', 'temporalBanMessage', 'todayFollows',
];

/** Plain names for the stored settings, for the console's "All stored settings" section. */
export const EVENTSUB_SETTING_LABELS: Record<keyof EventsubSettings, string> = {
  message: 'Chat message',
  endMessage: 'End message',
  endEnabled: 'End message on',
  minViewers: 'Minimum viewers',
  clipEnabled: 'Show a clip',
  delay: 'Delay (seconds)',
  modiversaryMessage: 'Mod anniversary message',
  modiversaryEnabled: 'Mod anniversaries on',
  watchStreakEnabled: 'Watch streaks on',
  temporalBanMessage: 'Timeout message',
  todayFollows: "Today's follows",
};

/** One shared Bits rule (cheers in chat + Overlay Studio looks): `dimabot/src/bits_rules/model.ts`. */
export interface BitsRule {
  id: string;
  name: string;
  enabled: boolean;
  min: number;
  /** null = no upper limit. */
  max: number | null;
  /** `default` = the event's default message, `custom` = `message`, `silent` = nothing in chat. */
  chat: { mode: 'default' | 'custom' | 'silent'; message: string };
  /** Shows the overlay alert. */
  alert: boolean;
}
export interface BitsRules {
  revision: number;
  rules: BitsRule[];
  maxRules: number;
  canManage: boolean;
  /** Overlay Studio looks per rule id. */
  looks: Record<string, number>;
  chat: { subscribed: boolean; enabled: boolean; defaultMessage: string };
}
export type BitsRuleWrite = Partial<Omit<BitsRule, 'id'>>;

export interface StandardEventsub {
  type: string;
  version: string;
  condition: Record<string, string>;
  config?: {
    message?: string;
    endMessage?: string;
    clipEnabled?: boolean;
  };
}

export interface MergedEventsub {
  id?: string;
  type: string;
  version: string;
  status: string;
  enabled: boolean;
  created_at: string;
  isMissing: boolean;
  condition?: Record<string, string>;
  config?: {
    message?: string;
    endMessage?: string;
    clipEnabled?: boolean;
  };
}

export interface ChannelReward {
  id: string;
  title: string;
  cost: number;
  enabled: boolean;
}

export interface ChannelTimer {
  id: string;
  name: string;
  interval: number;
  messages: string[];
  enabled: boolean;
}

export interface ChannelTrigger {
  id: string;
  name: string;
  type: string;
  file?: string;
  mediaType?: string;
  cost: number;
  enabled: boolean;
}

export interface PaginatedResponse<T> {
  rows: T[];
  /** Commands list only: function names that run built-in code (for the editor's "Runs" field). */
  meta?: { builtInActions?: string[] };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ChannelOverview {
  user: ChannelUser;
  commandsCount: number;
  eventsubsCount: number;
  rewardsCount: number;
  triggersCount: number;
  timersCount: number;
  filesCount: number;
  memoriesCount: number;
}

export interface AiCreditsGrantResponse {
  granted: number;
  chatAnnouncement?: 'sent' | 'skipped' | 'failed';
  before: {
    used: number;
    limit: number;
    balance: number;
  };
  after: {
    used: number;
    limit: number;
    balance: number;
  };
}

export interface AiCreditsData {
  version: number;
  used: number;
  limit: number;
  balance: number;
  meterId: string;
  updatedAt: string;
  available: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ChannelApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  /**
   * Get basic channel/user info from the users list endpoint
   * We use the admin-site/users search endpoint filtered by channelID.
   */
  getChannel(channelID: string): Observable<ChannelUser | null> {
    const queryParams = new URLSearchParams({
      page: '1',
      limit: '100',
      search: channelID
    });
    const url = `${this.linksService.getApiUrl()}/admin-site/users?${queryParams.toString()}`;

    return this.http.get<{ data: { rows: ChannelUser[] } }>(url).pipe(
      map(response => {
        const user = response.data.rows.find(r => r.channelID === channelID);
        return user || null;
      })
    );
  }

  /**
   * Get commands for a channel
   */
  getChannelCommands(channelID: string, page = 1, limit = 25): Observable<{ data: PaginatedResponse<ChannelCommand> }> {
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('limit', String(limit));

    const url = `${this.linksService.getApiUrl()}/admin-site/users/${channelID}/commands?${queryParams.toString()}`;
    return this.http.get<{ data: PaginatedResponse<ChannelCommand> }>(url).pipe(
      catchError(() => of({ data: { rows: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } } }))
    );
  }

  /**
   * Get eventsubs for a channel
   */
  getChannelEventsubs(channelID: string, page = 1, limit = 25): Observable<{ data: PaginatedResponse<ChannelEventsub> }> {
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('limit', String(limit));

    const url = `${this.linksService.getApiUrl()}/admin-site/users/${channelID}/eventsubs?${queryParams.toString()}`;
    return this.http.get<{ data: PaginatedResponse<ChannelEventsub> }>(url).pipe(
      catchError(() => of({ data: { rows: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } } }))
    );
  }

  /**
   * Get the list of standard eventsub types
   */
  getStandardEventsubs() {
    const url = `${this.linksService.getApiUrl()}/eventsubs/standard`;
    return this.http.get<{ data: { standardTypes: StandardEventsub[] } }>(url).pipe(
      catchError((err) => {
        console.error('getStandardEventsubs failed:', err);
        // Return empty array on error - caller will need to handle
        return of({ data: { standardTypes: [] as StandardEventsub[] } } as any);
      })
    );
  }

  /**
   * Subscribe to a standard eventsub (create + enable it for a channel)
   * MOD_ID = '698614112' (bot ID), '698614112' in condition is a placeholder for broadcaster
   */
  subscribeStandardEventsub(channelID: string, standardType: StandardEventsub): Observable<{ error: boolean; message: string; data?: ChannelEventsub }> {
    const url = `${this.linksService.getApiUrl()}/eventsubs/${channelID}`;

    // Build condition with actual channelID, replacing placeholders
    // broadcaster_user_id/to_broadcaster_user_id: replace '698614112' with actual channelID
    // user_id/moderator_user_id: keep as bot ID ('698614112' / MOD_ID)
    const BOT_ID = '698614112';
    const condition: Record<string, string> = {};
    if (standardType.condition) {
      for (const [key, value] of Object.entries(standardType.condition)) {
        if (key === 'broadcaster_user_id' || key === 'to_broadcaster_user_id') {
          // Broadcaster fields should be the actual channel
          condition[key] = channelID;
        } else {
          // user_id, moderator_user_id etc - use bot ID
          condition[key] = value === BOT_ID ? BOT_ID : value;
        }
      }
    }

    const body: Record<string, unknown> = {
      type: standardType.type,
      version: standardType.version,
      condition,
      enabled: true
    };

    // Only include config if it has actual values
    if (standardType.config && Object.keys(standardType.config).length > 0) {
      body['config'] = standardType.config;
    }

    return this.http.post<{ error: boolean; message: string; data?: ChannelEventsub }>(url, body);
  }

  /**
   * Patch (update) a channel eventsub - used for enable/disable
   */
  patchChannelEventsub(channelID: string, eventsubID: string, body: Record<string, unknown>): Observable<{ error: boolean; message: string }> {
    const url = `${this.linksService.getApiUrl()}/eventsubs/${channelID}/${eventsubID}`;
    return this.http.patch<{ error: boolean; message: string }>(url, body);
  }

  // ---- Owner edits (admin-site routes with `override`): edit like the database, see CommandWrite. ----

  ownerCreateCommand(channelID: string, body: CommandWrite & { cmd: string }): Observable<OwnerWriteResponse<ChannelCommand>> {
    return this.http.post<OwnerWriteResponse<ChannelCommand>>(`${this.linksService.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/commands`, body);
  }

  ownerUpdateCommand(channelID: string, commandID: string, body: CommandWrite): Observable<OwnerWriteResponse<ChannelCommand>> {
    return this.http.put<OwnerWriteResponse<ChannelCommand>>(
      `${this.linksService.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/commands/${encodeURIComponent(commandID)}`, body);
  }

  /** Built-in commands too. No undo. */
  ownerDeleteCommand(channelID: string, commandID: string): Observable<OwnerWriteResponse<{ id: string; cmd: string }>> {
    return this.http.delete<OwnerWriteResponse<{ id: string; cmd: string }>>(
      `${this.linksService.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/commands/${encodeURIComponent(commandID)}`);
  }

  /** Any stored chat setting (EDITABLE_EVENTSUB_FIELDS), no plan gate, "can't be disabled" or raid field list. */
  ownerPatchEventsub(channelID: string, eventsubID: string, body: Partial<EventsubSettings> & { enabled?: boolean }): Observable<OwnerWriteResponse<ChannelEventsub>> {
    return this.http.patch<OwnerWriteResponse<ChannelEventsub>>(
      `${this.linksService.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/eventsubs/${encodeURIComponent(eventsubID)}`, body);
  }

  // ---- Bits rules: the site's shared rules API (`/bits-rules/:channelID`), which the owner can use on any channel. ----

  getBitsRules(channelID: string): Observable<OwnerWriteResponse<BitsRules>> {
    return this.http.get<OwnerWriteResponse<BitsRules>>(`${this.linksService.getApiUrl()}/bits-rules/${encodeURIComponent(channelID)}`);
  }

  /** Answers the whole new state (+ `created`, the new rule id). Up to `maxRules` (50) rules. */
  createBitsRule(channelID: string, rule: BitsRuleWrite & { min: number }): Observable<OwnerWriteResponse<BitsRules & { created: string }>> {
    return this.http.post<OwnerWriteResponse<BitsRules & { created: string }>>(`${this.linksService.getApiUrl()}/bits-rules/${encodeURIComponent(channelID)}/rules`, rule);
  }

  updateBitsRule(channelID: string, ruleID: string, rule: BitsRuleWrite): Observable<OwnerWriteResponse<BitsRules>> {
    return this.http.patch<OwnerWriteResponse<BitsRules>>(
      `${this.linksService.getApiUrl()}/bits-rules/${encodeURIComponent(channelID)}/rules/${encodeURIComponent(ruleID)}`, rule);
  }

  deleteBitsRule(channelID: string, ruleID: string): Observable<OwnerWriteResponse<BitsRules>> {
    return this.http.delete<OwnerWriteResponse<BitsRules>>(
      `${this.linksService.getApiUrl()}/bits-rules/${encodeURIComponent(channelID)}/rules/${encodeURIComponent(ruleID)}`);
  }

  /** Create a command on any channel (owner access through the site's commands API). */
  createCommand(channelID: string, body: CommandWrite & { name: string; cmd: string; func: string; message: string; channel: string }): Observable<CommandWriteResponse> {
    const url = `${this.linksService.getApiUrl()}/commands/${encodeURIComponent(channelID)}`;
    return this.http.post<CommandWriteResponse>(url, body);
  }

  /** Change only the fields present in `body`. */
  updateCommand(channelID: string, commandID: string, body: CommandWrite): Observable<CommandWriteResponse> {
    const url = `${this.linksService.getApiUrl()}/commands/${encodeURIComponent(channelID)}/${encodeURIComponent(commandID)}`;
    return this.http.put<CommandWriteResponse>(url, body);
  }

  /** Built-in commands answer 403. There is no undo. */
  deleteCommand(channelID: string, commandID: string): Observable<CommandWriteResponse> {
    const url = `${this.linksService.getApiUrl()}/commands/${encodeURIComponent(channelID)}/${encodeURIComponent(commandID)}`;
    return this.http.delete<CommandWriteResponse>(url);
  }

  /** The chat event catalog (labels, field types, defaults) that the site's Chat events page renders. */
  getChatEventCatalog(): Observable<{ error: boolean; data: ChatEventDefinition[] }> {
    return this.http.get<{ error: boolean; data: ChatEventDefinition[] }>(`${this.linksService.getApiUrl()}/site/events`);
  }

  /**
   * Get rewards for a channel (from rewards route)
   */
  getChannelRewards(channelID: string): Observable<{ data: { rewards: ChannelReward[] } }> {
    const url = `${this.linksService.getApiUrl()}/rewards/${channelID}`;
    return this.http.get<{ data: { rewards: ChannelReward[] } }>(url).pipe(
      catchError(() => of({ data: { rewards: [] } }))
    );
  }

  /**
   * Get triggers for a channel
   */
  getChannelTriggers(channelID: string): Observable<{ data: { triggers: ChannelTrigger[] } }> {
    const url = `${this.linksService.getApiUrl()}/triggers/${channelID}`;
    return this.http.get<{ data: { triggers: ChannelTrigger[] } }>(url).pipe(
      catchError(() => of({ data: { triggers: [] } }))
    );
  }

  /**
   * Get timers for a channel
   */
  getChannelTimers(channelID: string): Observable<{ data: { timers: ChannelTimer[] } }> {
    const url = `${this.linksService.getApiUrl()}/timers/${channelID}`;
    return this.http.get<{ data: { timers: ChannelTimer[] } }>(url).pipe(
      catchError(() => of({ data: { timers: [] } }))
    );
  }

  /**
   * Get files for a channel
   */
  getChannelFiles(channelID: string): Observable<{ data: { files: { id: string; name: string; size: number; }[] } }> {
    const url = `${this.linksService.getApiUrl()}/triggers/files/${channelID}`;
    return this.http.get<{ data: { files: { id: string; name: string; size: number; }[] } }>(url).pipe(
      catchError(() => of({ data: { files: [] } }))
    );
  }

  /**
   * Get memories for a channel
   */
  getChannelMemories(channelID: string): Observable<{ data: { memories: { id: string; content: string; }[] } }> {
    const url = `${this.linksService.getApiUrl()}/memories/${channelID}`;
    return this.http.get<{ data: { memories: { id: string; content: string; }[] } }>(url).pipe(
      catchError(() => of({ data: { memories: [] } }))
    );
  }

  /**
   * Send a test event through the admin API fake endpoint.
   * The backend forwards the payload directly to the EventSub handler.
   */
  testEventsubEvent(channelID: string, payload: object): Observable<{ success: boolean; error?: string }> {
    const url = `${this.linksService.getApiUrl()}/eventsubs/${channelID}/test`;
    return this.http.post<{ error: boolean; message: string; status: number }>(url, payload).pipe(
      map((response) => response.error
        ? { success: false, error: response.message }
        : { success: true }
      ),
      catchError((err) => {
        console.error('testEventsubEvent failed:', err);
        return of({
            success: false,
            error: err.error?.message || err.message || 'Failed to send test event'
        });
      })
    );
  }

  grantAiCredits(channelID: string, credits: number, reason: string, announceInChat: boolean): Observable<{ error: boolean; message: string; data?: AiCreditsGrantResponse }> {
    const url = `${this.linksService.getApiUrl()}/admin-site/users/${channelID}/ai-credits/grant`;
    return this.http.post<{ error: boolean; message: string; data?: AiCreditsGrantResponse }>(url, {
      credits,
      reason,
      announceInChat
    });
  }

  /**
   * Get AI credit usage snapshot for a channel (used / limit / balance / available).
   * Returns null if the request fails so the channel page can still render.
   */
  getChannelAiCredits(channelID: string): Observable<AiCreditsData | null> {
    const url = `${this.linksService.getApiUrl()}/admin-site/users/${channelID}/ai-credits`;
    return this.http.get<{ error: boolean; message: string; data?: AiCreditsData }>(url).pipe(
      map((response) => response.data ?? null),
      catchError((err) => {
        console.warn('getChannelAiCredits failed:', err);
        return of(null);
      })
    );
  }

  /**
   * Get full channel overview with all stats
   * Makes multiple API calls to gather all info
   * Individual failing requests return default values so overview still loads
   */
  getChannelOverview(channelID: string): Observable<ChannelOverview> {
    return forkJoin({
      user: this.getChannel(channelID),
      commands: this.getChannelCommands(channelID, 1, 1),
      eventsubs: this.getChannelEventsubs(channelID, 1, 1),
      rewards: this.getChannelRewards(channelID),
      triggers: this.getChannelTriggers(channelID),
      timers: this.getChannelTimers(channelID),
      files: this.getChannelFiles(channelID),
      memories: this.getChannelMemories(channelID),
    }).pipe(
      map(results => {
        if (!results.user) {
          throw new Error('Channel not found');
        }
        return {
          user: results.user,
          commandsCount: results.commands.data.pagination.total,
          eventsubsCount: results.eventsubs.data.pagination.total,
          rewardsCount: results.rewards.data.rewards?.length || 0,
          triggersCount: results.triggers.data.triggers?.length || 0,
          timersCount: results.timers.data.timers?.length || 0,
          filesCount: results.files.data.files?.length || 0,
          memoriesCount: results.memories.data.memories?.length || 0,
        };
      })
    );
  }
}
