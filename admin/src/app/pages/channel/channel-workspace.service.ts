import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';

import { ChannelApiService, type ChannelUser } from '../../services/channel-api.service';
import { FeedApiService, type FeedKind, type FeedSummary } from '../../services/feed-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { hoursAgo } from '../../shared/format';

/**
 * What the channel workspace frame knows about the open channel, shared with its tab pages so they never
 * re-request the channel just to show its name. Provided by `ChannelShellComponent` (one per open channel).
 */
@Injectable()
export class ChannelWorkspaceService {
  private readonly channelApi = inject(ChannelApiService);
  private readonly feedApi = inject(FeedApiService);
  private userSub?: Subscription;
  private summarySub?: Subscription;

  readonly channelID = signal('');
  readonly user = signal<ChannelUser | null>(null);
  readonly loading = signal(true);
  /** 'missing' = no channel with this id; 'failed' = the request failed. */
  readonly error = signal<'missing' | 'failed' | null>(null);

  /** The feed summary for this channel over the last 24 hours (one request, used by the tab badges and Overview). */
  readonly summary = signal<FeedSummary | null>(null);
  readonly summaryLoading = signal(false);
  readonly summaryError = signal<string | null>(null);

  readonly name = computed(() => this.user()?.channel ?? null);
  /** Failed rows per kind in the last 24 hours. */
  readonly failed = computed(() => {
    const counts = new Map<FeedKind, number>();
    for (const row of this.summary()?.kinds ?? []) counts.set(row.kind, row.failed);
    return counts;
  });

  open(channelID: string): void {
    if (channelID === this.channelID()) return;
    this.channelID.set(channelID);
    this.user.set(null);
    this.summary.set(null);
    this.load();
    this.loadSummary();
  }

  /** Loads the channel; `quiet` keeps the current one on screen while it refreshes (after a write). */
  load(quiet = false): void {
    const channelID = this.channelID();
    this.userSub?.unsubscribe();
    if (!quiet) {
      this.loading.set(true);
      this.error.set(null);
    }
    this.userSub = this.channelApi.getChannel(channelID).subscribe({
      next: (user) => {
        if (user) this.user.set(user);
        else if (!quiet) this.error.set('missing');
        this.loading.set(false);
      },
      error: () => {
        if (!quiet) this.error.set('failed');
        this.loading.set(false);
      },
    });
  }

  loadSummary(): void {
    const channel = this.channelID();
    this.summarySub?.unsubscribe();
    this.summaryLoading.set(true);
    this.summaryError.set(null);
    this.summarySub = this.feedApi.summary({ channel, from: hoursAgo(24) }).subscribe({
      next: (response) => {
        this.summary.set(response.data);
        this.summaryLoading.set(false);
      },
      error: (err) => {
        this.summaryError.set(apiErrorMessage(err, "Couldn't load the last 24 hours"));
        this.summaryLoading.set(false);
      },
    });
  }
}
