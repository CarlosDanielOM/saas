import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { forkJoin, catchError, of } from 'rxjs';

import {
  ChannelApiService,
  type ChannelEventsub,
  type MergedEventsub,
  type StandardEventsub,
} from '../../services/channel-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { IconComponent } from '../../shared/icon/icon.component';
import {
  TestEventModalComponent,
  type TestEventPayload,
} from '../../shared/test-event-modal/test-event-modal.component';

/** Plain names for Twitch EventSub types; the raw type stays visible as secondary text. */
const EVENT_NAMES: Record<string, { name: string; what: string }> = {
  'channel.chat.message': { name: 'Chat messages', what: 'Commands, AI replies and moderation' },
  'channel.chat.notification': { name: 'Chat notifications', what: 'Sub, raid and announcement notices in chat' },
  'channel.follow': { name: 'Follows', what: 'Follow alerts and follow defense' },
  'stream.online': { name: 'Stream goes live', what: 'Go-live messages and stream tracking' },
  'stream.offline': { name: 'Stream ends', what: 'Stream summaries and wrap-up' },
  'channel.raid': { name: 'Raids', what: 'Raid alerts and shoutouts' },
  'channel.poll.progress': { name: 'Polls', what: 'Poll updates on overlays' },
  'channel.prediction.progress': { name: 'Predictions', what: 'Prediction updates on overlays' },
  'channel.hype_train.begin': { name: 'Hype train starts', what: 'Hype train alerts' },
  'channel.hype_train.progress': { name: 'Hype train progress', what: 'Hype train level updates' },
  'channel.hype_train.end': { name: 'Hype train ends', what: 'Hype train results' },
  'channel.shoutout.receive': { name: 'Shoutouts received', what: 'Thank-you messages for shoutouts' },
  'channel.ad_break.begin': { name: 'Ad breaks', what: 'Ad break warnings in chat' },
  'user.update': { name: 'Profile changes', what: 'Keeps their name and email in sync' },
  'channel.subscribe': { name: 'New subs', what: 'Sub alerts' },
  'channel.subscription.gift': { name: 'Gifted subs', what: 'Gift sub alerts' },
  'channel.subscription.message': { name: 'Resubs', what: 'Resub alerts with messages' },
  'channel.subscription.end': { name: 'Subs ending', what: 'Subscriber tracking' },
  'channel.update': { name: 'Title & category changes', what: 'Game and title tracking' },
  'channel.bits.use': { name: 'Bits', what: 'Bit alerts, TTS and bit-powered features' },
  'channel.cheer': { name: 'Cheers', what: 'Bit alerts (older event)' },
  'automod.message.hold': { name: 'AutoMod held messages', what: 'Moderation queue' },
  'channel.channel_points_custom_reward_redemption.add': { name: 'Channel point redemptions', what: 'Rewards and triggers' },
  'channel.ban': { name: 'Bans', what: 'Moderation history' },
};

@Component({
  selector: 'app-channel-eventsubs',
  templateUrl: './channel-eventsubs.component.html',
  styleUrl: './channel-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgTemplateOutlet, SkeletonComponent, TestEventModalComponent, IconComponent],
})
export class ChannelEventsubsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly channelApi = inject(ChannelApiService);
  private readonly toast = inject(ToastService);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly eventsubs = signal<MergedEventsub[]>([]);
  readonly channelName = signal<string | null>(null);

  /** type:version keys of eventsubs currently being changed */
  readonly loadingIds = signal<Set<string>>(new Set());

  /** Test modal state */
  readonly showTestModal = signal(false);
  readonly testPayload = signal<string>('');
  readonly testEventType = signal<string>('');
  readonly isSendingTest = signal(false);

  readonly channelID = computed(() => this.route.snapshot.paramMap.get('channelID') || '');

  readonly attention = computed(() => this.eventsubs().filter((es) => !this.isHealthy(es)));
  readonly healthy = computed(() => this.eventsubs().filter((es) => this.isHealthy(es)));
  readonly missingCount = computed(() => this.eventsubs().filter((es) => es.isMissing).length);
  readonly offCount = computed(
    () => this.eventsubs().filter((es) => !es.isMissing && !es.enabled).length,
  );
  /** The page's answer in one sentence. */
  readonly summary = computed(() => {
    const total = this.eventsubs().length;
    const problems = this.attention();
    if (!problems.length) {
      return { ok: true, title: `All ${total} events are connected and on`, text: 'The bot hears everything it needs from Twitch for this channel.' };
    }
    const names = problems.slice(0, 3).map((es) => this.eventName(es.type).toLowerCase());
    const more = problems.length > 3 ? ` and ${problems.length - 3} more` : '';
    const parts = [];
    if (this.missingCount()) parts.push(`${this.missingCount()} missing`);
    if (this.offCount()) parts.push(`${this.offCount()} turned off`);
    const other = problems.length - this.missingCount() - this.offCount();
    if (other > 0) parts.push(`${other} not confirmed by Twitch`);
    return {
      ok: false,
      title: `${problems.length} of ${total} events need attention`,
      text: `${parts.join(', ')} — the bot won't react to ${names.join(', ')}${more} until they're connected and on.`,
    };
  });

  ngOnInit(): void {
    this.loadEventsubs();
    this.channelApi.getChannel(this.channelID()).subscribe({
      next: (user) => this.channelName.set(user?.channel ?? null),
      error: () => this.channelName.set(null),
    });
  }

  eventName(type: string): string {
    return EVENT_NAMES[type]?.name ?? type;
  }

  eventWhat(type: string): string {
    return EVENT_NAMES[type]?.what ?? '';
  }

  isHealthy(es: MergedEventsub): boolean {
    return !es.isMissing && es.enabled && ['enabled', 'active'].includes(es.status.toLowerCase());
  }

  statusLabel(es: MergedEventsub): string {
    if (es.isMissing) return 'Missing';
    if (!es.enabled) return 'Off';
    const status = es.status.toLowerCase();
    if (status === 'enabled' || status === 'active') return 'On';
    if (status.includes('verification_pending')) return 'Waiting for Twitch';
    if (status.includes('revoked')) return 'Access revoked';
    return status.replaceAll('_', ' ');
  }

  key(es: MergedEventsub): string {
    return `${es.type}:${es.version}`;
  }

  loadEventsubs(): void {
    const channelID = this.channelID();
    if (!channelID) {
      this.error.set('No channel ID provided');
      this.toast.error('No channel ID provided');
      this.isLoading.set(false);
      return;
    }

    if (!this.eventsubs().length) this.isLoading.set(true);
    this.error.set(null);

    forkJoin({
      standard: this.channelApi.getStandardEventsubs().pipe(
        catchError(() => {
          this.toast.error("Couldn't load the list of Twitch events");
          return of({ data: { standardTypes: [] as StandardEventsub[] } });
        }),
      ),
      channel: this.channelApi.getChannelEventsubs(channelID, 1, 100).pipe(
        catchError(() => {
          this.toast.error("Couldn't load this channel's events");
          return of({
            data: {
              rows: [] as ChannelEventsub[],
              pagination: { page: 1, limit: 100, total: 0, totalPages: 1 },
            },
          });
        }),
      ),
    }).subscribe({
      next: ({ standard, channel }) => {
        if (!standard.data || !standard.data.standardTypes) {
          console.error('Unexpected standard response structure:', standard);
          this.error.set('The server sent an unexpected response. Try again in a moment.');
          this.isLoading.set(false);
          return;
        }

        const standardTypes = standard.data.standardTypes;
        const dbEventsubs = channel.data.rows;

        // There should always be a standard list; without it we can't tell what's missing.
        if (standardTypes.length === 0) {
          this.error.set("Couldn't load the list of Twitch events the bot needs. Is the API running?");
          this.isLoading.set(false);
          return;
        }

        const dbEventsubMap = new Map<string, ChannelEventsub>();
        for (const es of dbEventsubs) {
          dbEventsubMap.set(`${es.type}:${es.version}`, es);
        }

        const merged: MergedEventsub[] = standardTypes.map((std: StandardEventsub) => {
          const dbEs = dbEventsubMap.get(`${std.type}:${std.version}`);
          return dbEs
            ? {
                id: dbEs.id,
                type: dbEs.type,
                version: dbEs.version,
                status: dbEs.status,
                enabled: dbEs.enabled,
                created_at: dbEs.created_at,
                isMissing: false,
                condition: std.condition,
                config: std.config,
              }
            : {
                type: std.type,
                version: std.version,
                status: 'Missing',
                enabled: false,
                created_at: '',
                isMissing: true,
                condition: std.condition,
                config: std.config,
              };
        });

        this.eventsubs.set(merged);
        this.isLoading.set(false);
      },
      error: () => {
        this.error.set("Couldn't load Twitch events");
        this.isLoading.set(false);
      },
    });
  }

  isBusy(es: MergedEventsub): boolean {
    return this.loadingIds().has(this.key(es));
  }

  private setBusy(es: MergedEventsub, busy: boolean): void {
    const next = new Set(this.loadingIds());
    if (busy) next.add(this.key(es));
    else next.delete(this.key(es));
    this.loadingIds.set(next);
  }

  toggleEventsub(eventsub: MergedEventsub): void {
    const channelID = this.channelID();
    if (this.isBusy(eventsub)) return;
    const name = this.eventName(eventsub.type);

    if (eventsub.isMissing) {
      const standardType: StandardEventsub = {
        type: eventsub.type,
        version: eventsub.version,
        condition: eventsub.condition || {},
        config: eventsub.config,
      };
      this.setBusy(eventsub, true);
      this.channelApi.subscribeStandardEventsub(channelID, standardType).subscribe({
        next: (response) => {
          this.setBusy(eventsub, false);
          if (response.error) {
            this.toast.error(response.message);
          } else {
            this.toast.success(`${name} connected`);
            this.loadEventsubs();
          }
        },
        error: (err) => {
          this.setBusy(eventsub, false);
          this.toast.error(err?.error?.message || `Couldn't connect ${name}`);
        },
      });
    } else if (eventsub.id) {
      const newEnabled = !eventsub.enabled;
      // Optimistic: flip now, roll back if the server says no.
      this.patchLocal(eventsub, newEnabled);
      this.setBusy(eventsub, true);
      this.channelApi
        .patchChannelEventsub(channelID, eventsub.id, { enabled: newEnabled })
        .subscribe({
          next: (response) => {
            this.setBusy(eventsub, false);
            if (response.error) {
              this.patchLocal(eventsub, !newEnabled);
              this.toast.error(response.message);
            } else {
              this.toast.success(`${name} turned ${newEnabled ? 'on' : 'off'}`);
              this.loadEventsubs();
            }
          },
          error: (err) => {
            this.setBusy(eventsub, false);
            this.patchLocal(eventsub, !newEnabled);
            this.toast.error(err?.error?.message || `Couldn't update ${name}`);
          },
        });
    }
  }

  private patchLocal(eventsub: MergedEventsub, enabled: boolean): void {
    this.eventsubs.update((list) =>
      list.map((es) => (this.key(es) === this.key(eventsub) ? { ...es, enabled } : es)),
    );
  }

  openTestModal(eventsub: MergedEventsub): void {
    if (!eventsub.id) return;
    const payload = this.generateTestPayload(eventsub.type, this.channelID());
    this.testEventType.set(eventsub.type);
    this.testPayload.set(JSON.stringify(payload, null, 2));
    this.isSendingTest.set(false);
    this.showTestModal.set(true);
  }

  closeTestModal(): void {
    if (this.isSendingTest()) return;
    this.showTestModal.set(false);
    this.testPayload.set('');
    this.testEventType.set('');
  }

  /** Send the test event to the fake EventSub API endpoint */
  sendTestEvent(payload: TestEventPayload): void {
    this.isSendingTest.set(true);
    this.channelApi.testEventsubEvent(this.channelID(), payload).subscribe({
      next: (result) => {
        this.isSendingTest.set(false);
        if (result.success) {
          this.toast.success(`Test ${this.eventName(String(payload.subscription['type'])).toLowerCase()} event sent`);
          this.closeTestModal();
        } else {
          this.toast.error(result.error || "Couldn't send the test event");
        }
      },
      error: (err) => {
        this.isSendingTest.set(false);
        this.toast.error("Couldn't send the test event: " + (err.message || 'unknown error'));
      },
    });
  }

  /**
   * Generate a test payload for the given event type and channel
   */
  private generateTestPayload(eventType: string, channelID: string): object {
    const now = new Date().toISOString();
    const randomUserId = String(Math.floor(Math.random() * 900000000) + 100000000);
    const randomViewers = Math.floor(Math.random() * 500) + 10;

    const baseSubscription = {
      id: `test_sub_${Date.now()}`,
      type: eventType,
      version: this.getVersionForType(eventType),
      status: 'enabled',
      cost: 0,
      condition: this.buildCondition(eventType, channelID),
      transport: {
        method: 'webhook',
        callback: 'https://subscriptions.domdimabot.com/eventsub',
      },
      created_at: now,
    };

    const eventData = this.buildEventData(eventType, channelID, now, randomUserId, randomViewers);

    return {
      subscription: baseSubscription,
      event: eventData,
    };
  }

  private getVersionForType(type: string): string {
    const versions: Record<string, string> = {
      'channel.chat.message': '1',
      'channel.follow': '2',
      'stream.online': '1',
      'stream.offline': '1',
      'channel.raid': '1',
      'channel.poll.progress': '1',
      'channel.prediction.progress': '1',
      'channel.hype_train.begin': '2',
      'channel.hype_train.progress': '2',
      'channel.hype_train.end': '2',
      'channel.shoutout.receive': '1',
      'channel.ad_break.begin': '1',
      'channel.subscribe': '1',
      'channel.subscription.gift': '1',
      'channel.subscription.message': '1',
      'channel.subscription.end': '1',
      'channel.update': '1',
      'user.update': '1',
      'channel.bits.use': '1',
      'automod.message.hold': '1',
      'channel.channel_points_custom_reward_redemption.add': '1',
      'channel.ban': '1',
    };
    return versions[type] || '1';
  }

  private buildCondition(type: string, channelID: string): Record<string, string> {
    const MOD_ID = '698614112';

    switch (type) {
      case 'channel.chat.message':
        return { broadcaster_user_id: channelID, user_id: MOD_ID };
      case 'channel.follow':
        return { broadcaster_user_id: channelID, moderator_user_id: MOD_ID };
      case 'channel.raid':
        return { to_broadcaster_user_id: channelID };
      case 'channel.shoutout.receive':
        return { broadcaster_user_id: channelID, moderator_user_id: MOD_ID };
      case 'user.update':
        return { user_id: channelID };
      default:
        return { broadcaster_user_id: channelID };
    }
  }

  private buildEventData(
    type: string,
    channelID: string,
    now: string,
    randomUserId: string,
    randomViewers: number,
  ): Record<string, unknown> {
    const baseEvent: Record<string, unknown> = {
      broadcaster_user_id: channelID,
      broadcaster_user_login: 'teststreamer',
      broadcaster_user_name: 'TestStreamer',
    };

    switch (type) {
      case 'channel.chat.message':
        return {
          ...baseEvent,
          chatter_user_id: randomUserId,
          chatter_user_name: 'TestUser',
          chatter_user_login: 'testuser',
          message_id: `test_msg_${Date.now()}`,
          message: {
            text: 'This is a test message!',
            fragments: [{ text: 'This is a test message!', type: 'text' }],
          },
          message_type: 'text',
          badges: [],
          cheer: { bits: 0 },
          color: '#FF0000',
        };

      case 'channel.follow':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_name: 'TestFollower',
          user_login: 'testfollower',
          followed_at: now,
        };

      case 'stream.online':
        return {
          ...baseEvent,
          started_at: now,
          type: 'live',
          id: `stream_online_${Date.now()}`,
        };

      case 'stream.offline':
        return baseEvent;

      case 'channel.raid':
        return {
          ...baseEvent,
          to_broadcaster_user_id: channelID,
          to_broadcaster_user_login: 'teststreamer',
          to_broadcaster_user_name: 'TestStreamer',
          from_broadcaster_user_id: String(Math.floor(Math.random() * 900000000) + 100000000),
          from_broadcaster_user_login: 'raidstreamer',
          from_broadcaster_user_name: 'RaidStreamer',
          viewers: randomViewers,
        };

      case 'channel.channel_points_custom_reward_redemption.add':
        return {
          ...baseEvent,
          id: `redemption_${Date.now()}`,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          reward: {
            id: 'test_reward_id',
            title: 'Test Reward',
            prompt: 'This is a test reward',
            cost: 100,
            should_redemptions_skip_request_queue: false,
          },
          user_input: 'test input',
          status: 'unfulfilled',
          redeemed_at: now,
        };

      case 'channel.ad_break.begin':
        return {
          ...baseEvent,
          requester_user_id: randomUserId,
          requester_user_name: 'TestUser',
          requester_user_login: 'testuser',
          duration_seconds: 60,
          started_at: now,
          is_automatic: false,
        };

      case 'channel.ban':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_name: 'BannedUser',
          user_login: 'banneduser',
          moderator_user_id: '698614112',
          moderator_user_name: 'TestModBot',
          moderator_user_login: 'testmodbot',
          reason: 'Test ban reason',
          ends_at: null,
          is_permanent: true,
        };

      case 'channel.subscribe':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          tier: '1000',
          sub_tier: '1000',
          subscription_tier: '1000',
          is_gift: false,
          subscribed_at: now,
        };

      case 'channel.subscription.gift':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          tier: '1000',
          sub_tier: '1000',
          subscription_tier: '1000',
          is_gift: true,
          total: 5,
        };

      case 'channel.subscription.message':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          tier: '1000',
          sub_tier: '1000',
          subscription_tier: '1000',
          is_gift: false,
          subscribed_at: now,
        };

      case 'channel.subscription.end':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          tier: '1000',
          sub_tier: '1000',
          subscription_tier: '1000',
          is_gift: false,
          subscribed_at: now,
          ended_at: now,
        };

      case 'channel.bits.use':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          bits: 100,
          type: 'cheer',
          is_anonymous: false,
        };

      default:
        return baseEvent;
    }
  }
}
