import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AnalyticsService } from './analytics.service';
import { LanguageService } from './language.service';
import { LinksService } from './links.service';
import { SessionAuthService } from './session-auth.service';
import { ToastService } from './toast.service';
import { rememberLoginReturn } from '../shared/utils/login-return.util';

export type ChatJoinResult = 'ok' | 'needs-twitch-ok' | 'error';

interface PendingJoin {
  channelID: string;
  expires: number;
}

/** Marker kept across the Twitch round-trip (localStorage, like the OAuth state, survives a new tab). */
const PENDING_JOIN_KEY = 'dimasite.bot-chat-join.v1';
const PENDING_JOIN_TTL_MS = 15 * 60_000;

/**
 * The signed-in streamer's bot setup, in two levels:
 * - **In chat**: the bot reads and answers chat. Needs only the `channel:bot` approval that
 *   sign-in asks for, so custom commands (e.g. a TTS command) work right away.
 * - **Full access** ("activated"): the long Twitch approval that turns on built-in commands,
 *   alerts/chat events, automod, channel points, polls and the rest.
 */
@Injectable({ providedIn: 'root' })
export class BotAccessService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly links = inject(LinksService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly analytics = inject(AnalyticsService);

  readonly ownChannelID = computed(() => this.sessionAuth.session()?.appUser.twitch_user_id || null);
  /** Full access granted (the account's `actived` flag). */
  readonly hasFullAccess = computed(() => Boolean(this.sessionAuth.session()?.appUser.actived));
  readonly chatEnabled = computed(() => Boolean(this.sessionAuth.session()?.appUser.chat_enabled));
  readonly chatBusy = signal(false);
  /** Channel whose join Twitch refused for a missing approval (per account, so a switch resets it). */
  private readonly needsOkChannel = signal<string | null>(null);
  /** Twitch refused the join: this sign-in predates the chat approval. */
  readonly chatNeedsTwitchOk = computed(() => Boolean(this.ownChannelID()) && this.needsOkChannel() === this.ownChannelID());
  /** When this tab last changed the bot's chat state; older snapshots must not undo it. */
  private chatChangedAt = 0;

  isOwnChannel(channelID: string | null | undefined): boolean {
    return Boolean(channelID) && channelID === this.ownChannelID();
  }

  /**
   * Keeps the session in step with a fresher value (e.g. the dashboard bootstrap).
   * `requestedAt` is when that snapshot was requested: a join/leave since then wins.
   */
  syncChatEnabled(enabled: boolean, requestedAt = Date.now()): void {
    if (this.chatBusy() || this.chatChangedAt >= requestedAt) {
      return;
    }
    if (this.sessionAuth.getSessionSnapshot() && this.chatEnabled() !== enabled) {
      this.sessionAuth.patchAppUser({ chat_enabled: enabled });
    }
  }

  /** Adds the bot to (or removes it from) the signed-in streamer's chat. */
  async setChat(enabled: boolean, options: { afterTwitchOk?: boolean } = {}): Promise<ChatJoinResult> {
    const channelID = this.ownChannelID();
    if (!channelID || this.chatBusy()) {
      return 'error';
    }

    this.chatBusy.set(true);
    try {
      const response = await firstValueFrom(
        this.http.post<{ error: boolean; message?: string }>(`${this.links.getApiUrl()}/users/chat/${channelID}`, { enabled })
      );
      if (response?.error) {
        throw new Error(response.message || '');
      }
      if (this.ownChannelID() !== channelID) {
        // Another account signed in (e.g. in another tab) meanwhile: this result isn't theirs.
        return 'error';
      }
      this.chatChangedAt = Date.now();
      this.needsOkChannel.set(null);
      this.sessionAuth.patchAppUser({ chat_enabled: enabled });
      this.analytics.capture(enabled ? 'bot_chat_joined' : 'bot_chat_left', { full_access: this.hasFullAccess() });
      this.toast.success(
        this.t(enabled ? 'botAccess.toast.joinedTitle' : 'botAccess.toast.leftTitle'),
        this.t(enabled ? 'botAccess.toast.joinedMessage' : 'botAccess.toast.leftMessage')
      );
      return 'ok';
    } catch (error) {
      if (this.ownChannelID() !== channelID) {
        return 'error';
      }
      const code = error instanceof HttpErrorResponse ? error.error?.code : undefined;
      if (enabled && code === 'chat_permission_missing') {
        this.needsOkChannel.set(channelID);
        this.analytics.capture('bot_chat_needs_twitch_ok', { after_twitch_ok: Boolean(options.afterTwitchOk) });
        if (options.afterTwitchOk) {
          // They just came back from Twitch and it still refuses: don't loop them through sign-in again silently.
          this.toast.warning(this.t('botAccess.toast.stillNeedsOkTitle'), this.t('botAccess.toast.stillNeedsOkMessage'), 9000);
        } else {
          this.toast.warning(this.t('botAccess.toast.needsOkTitle'), this.t('botAccess.toast.needsOkMessage'), 7000);
        }
        return 'needs-twitch-ok';
      }
      if (enabled && code === 'chat_join_failed') {
        // Twitch refused even though the streamer approved chat access: nothing for them to approve.
        this.needsOkChannel.set(null);
        this.analytics.capture('bot_chat_join_refused');
        this.toast.error(this.t('botAccess.toast.refusedTitle'), this.t('botAccess.toast.refusedMessage'), 9000);
        return 'error';
      }
      this.toast.error(
        this.t(enabled ? 'botAccess.toast.joinFailedTitle' : 'botAccess.toast.leaveFailedTitle'),
        this.t('botAccess.toast.failedMessage')
      );
      return 'error';
    } finally {
      this.chatBusy.set(false);
    }
  }

  /**
   * Signs in with Twitch again so the streamer can approve the chat permission, then
   * comes back to this page and joins (see `resumePendingJoin`).
   */
  allowChatOnTwitch(): void {
    const channelID = this.ownChannelID();
    if (!channelID) {
      return;
    }
    try {
      localStorage.setItem(PENDING_JOIN_KEY, JSON.stringify({ channelID, expires: Date.now() + PENDING_JOIN_TTL_MS } satisfies PendingJoin));
    } catch {
      // Storage blocked: after sign-in the streamer taps Join chat again.
    }
    rememberLoginReturn(this.router.url);
    this.analytics.capture('bot_chat_allow_on_twitch');
    this.sessionAuth.startTwitchLogin();
  }

  /** Finishes a join that was waiting for the Twitch approval. Call once a session is valid. */
  resumePendingJoin(): void {
    let pending: PendingJoin | null = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_JOIN_KEY) || 'null') as PendingJoin | null;
      localStorage.removeItem(PENDING_JOIN_KEY);
    } catch {
      return;
    }
    if (!pending || pending.expires < Date.now() || !this.isOwnChannel(pending.channelID) || this.chatEnabled()) {
      return;
    }
    void this.setChat(true, { afterTwitchOk: true });
  }

  /** The long Twitch approval ("activation"). Leaves the site. */
  startFullAccess(source: string): void {
    const login = this.sessionAuth.session()?.twitchUser.login?.trim().toLowerCase();
    if (!login) {
      return;
    }
    this.analytics.capture('permission_cta_clicked', { action: 'activate', source });
    const params = new URLSearchParams({ state: login, action: 'activate' });
    window.location.href = `${this.links.getApiUrl()}/auth/authorize?${params.toString()}`;
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }
}
