import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin, catchError, of } from 'rxjs';

import { ChannelApiService, type ChannelEventsub, type MergedEventsub, type StandardEventsub } from '../../services/channel-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { TestEventModalComponent, type TestEventPayload } from '../../shared/test-event-modal/test-event-modal.component';

@Component({
  selector: 'app-channel-eventsubs',
  templateUrl: './channel-eventsubs.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SkeletonComponent, TestEventModalComponent]
})
export class ChannelEventsubsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly channelApi = inject(ChannelApiService);
  private readonly toast = inject(ToastService);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly eventsubs = signal<MergedEventsub[]>([]);
  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalItems = signal(0);

  /** IDs of eventsubs currently being toggled */
  readonly loadingIds = signal<Set<string>>(new Set());

  /** Test modal state */
  readonly showTestModal = signal(false);
  readonly testPayload = signal<string>('');
  readonly testEventType = signal<string>('');

  readonly channelID = computed(() => this.route.snapshot.paramMap.get('channelID') || '');

  ngOnInit(): void {
    this.loadEventsubs();
  }

  loadEventsubs(): void {
    const channelID = this.channelID();
    if (!channelID) {
      this.error.set('No channel ID provided');
      this.toast.error('No channel ID provided');
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    // Use forkJoin to call both APIs simultaneously
    forkJoin({
      standard: this.channelApi.getStandardEventsubs().pipe(
        catchError(() => {
          this.toast.error('Failed to load standard eventsub types');
          return of({ data: { standardTypes: [] as StandardEventsub[] } });
        })
      ),
      channel: this.channelApi.getChannelEventsubs(channelID, 1, 100).pipe(
        catchError(() => {
          this.toast.error('Failed to load channel eventsubs');
          return of({ data: { rows: [] as ChannelEventsub[], pagination: { page: 1, limit: 100, total: 0, totalPages: 1 } } });
        })
      )
    }).subscribe({
      next: ({ standard, channel }) => {
        // Check if the response structure is what we expect
        if (!standard.data || !standard.data.standardTypes) {
          this.toast.error('Standard API returned unexpected format');
          console.error('Unexpected standard response structure:', standard);
          this.error.set('Unexpected API response format');
          this.isLoading.set(false);
          return;
        }

        const standardTypes = standard.data.standardTypes;
        const dbEventsubs = channel.data.rows;

        // Show detailed info about what we received
        this.toast.info(`Standard types received: ${standardTypes.length}, DB eventsubs: ${dbEventsubs.length}`);

        // If no standard types at all, that's a problem - we should always have 20
        if (standardTypes.length === 0) {
          this.error.set('Failed to load standard eventsub types - API returned empty list');
          this.toast.error('Standard eventsub types API returned empty - is the server running?');
          this.isLoading.set(false);
          return;
        }

        // Create a map of DB eventsubs by type+version for quick lookup
        const dbEventsubMap = new Map<string, ChannelEventsub>();
        for (const es of dbEventsubs) {
          const key = `${es.type}:${es.version}`;
          dbEventsubMap.set(key, es);
        }

        // Merge: iterate through standard types in order, check if DB has them
        const merged: MergedEventsub[] = [];

        for (const std of standardTypes) {
          const key = `${std.type}:${std.version}`;
          const dbEs = dbEventsubMap.get(key);

          if (dbEs) {
            // Found in DB
            merged.push({
              id: dbEs.id,
              type: dbEs.type,
              version: dbEs.version,
              status: dbEs.status,
              enabled: dbEs.enabled,
              created_at: dbEs.created_at,
              isMissing: false,
              condition: std.condition,
              config: std.config
            });
          } else {
            // Missing from DB
            merged.push({
              type: std.type,
              version: std.version,
              status: 'Missing',
              enabled: false,
              created_at: '',
              isMissing: true,
              condition: std.condition,
              config: std.config
            });
          }
        }

        // If we got no standard types and no DB types, show error
        if (standardTypes.length === 0 && dbEventsubs.length === 0) {
          this.error.set('Failed to load eventsub data');
          this.toast.error('Failed to load eventsub data - check console for details');
          this.isLoading.set(false);
          return;
        }

        // Log what we found
        const missingCount = merged.filter(m => m.isMissing).length;
        const foundCount = merged.filter(m => !m.isMissing).length;
        this.toast.info(`Loaded ${foundCount} eventsubs, ${missingCount} missing`);

        this.eventsubs.set(merged);
        this.currentPage.set(1);
        this.totalPages.set(1);
        this.totalItems.set(merged.length);
        this.isLoading.set(false);
      },
      error: () => {
        this.error.set('Failed to load eventsubs');
        this.toast.error('Failed to load eventsubs');
        this.isLoading.set(false);
      }
    });
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.loadEventsubs();
  }

  formatDate(date: string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString();
  }

  getStatusClass(eventsub: MergedEventsub): string {
    if (eventsub.isMissing) {
      return 'status-badge--missing';
    }
    switch (eventsub.status.toLowerCase()) {
      case 'enabled':
      case 'active':
        return 'status-badge--active';
      case 'disabled':
      case 'inactive':
        return 'status-badge--inactive';
      default:
        return '';
    }
  }

  getRowClass(eventsub: MergedEventsub): string {
    return eventsub.isMissing ? 'eventsub-row--missing' : '';
  }

  isLoadingId(id: string | undefined): boolean {
    return id ? this.loadingIds().has(id) : false;
  }

  toggleEventsub(eventsub: MergedEventsub): void {
    const channelID = this.channelID();
    const loadingSet = new Set(this.loadingIds());
    // Use type:version as loading key for both missing and existing
    const loadingKey = `${eventsub.type}:${eventsub.version}`;

    if (eventsub.isMissing) {
      // Subscribe to this standard eventsub type
      const standardType: StandardEventsub = {
        type: eventsub.type,
        version: eventsub.version,
        condition: eventsub.condition || {},
        config: eventsub.config
      };

      loadingSet.add(loadingKey);
      this.loadingIds.set(loadingSet);

      this.channelApi.subscribeStandardEventsub(channelID, standardType).subscribe({
        next: (response) => {
          loadingSet.delete(loadingKey);
          this.loadingIds.set(loadingSet);
          if (response.error) {
            this.toast.error(response.message);
          } else {
            this.toast.success(`Subscribed to ${eventsub.type}`);
            this.loadEventsubs();
          }
        },
        error: () => {
          loadingSet.delete(loadingKey);
          this.loadingIds.set(loadingSet);
          this.toast.error('Could not create eventsub');
        }
      });
    } else if (eventsub.id) {
      // Toggle enabled/disabled for existing eventsub
      const newEnabled = !eventsub.enabled;

      loadingSet.add(loadingKey);
      this.loadingIds.set(loadingSet);

      this.channelApi.patchChannelEventsub(channelID, eventsub.id, { enabled: newEnabled }).subscribe({
        next: (response) => {
          loadingSet.delete(loadingKey);
          this.loadingIds.set(loadingSet);
          if (response.error) {
            this.toast.error(response.message);
          } else {
            this.toast.success(`${eventsub.type} ${newEnabled ? 'enabled' : 'disabled'}`);
            this.loadEventsubs();
          }
        },
        error: () => {
          loadingSet.delete(loadingKey);
          this.loadingIds.set(loadingSet);
          this.toast.error('Could not update eventsub');
        }
      });
    }
  }

  /**
   * Open the test modal for a given eventsub
   */
  openTestModal(eventsub: MergedEventsub): void {
    if (!eventsub.id) return;

    const channelID = this.channelID();
    const payload = this.generateTestPayload(eventsub.type, channelID);

    this.testEventType.set(eventsub.type);
    this.testPayload.set(JSON.stringify(payload, null, 2));
    this.showTestModal.set(true);
  }

  /**
   * Close the test modal
   */
  closeTestModal(): void {
    this.showTestModal.set(false);
    this.testPayload.set('');
    this.testEventType.set('');
  }

  /**
   * Send the test event to the fake EventSub API endpoint
   */
  sendTestEvent(payload: TestEventPayload): void {
    this.channelApi.testEventsubEvent(this.channelID(), payload).subscribe({
      next: (result) => {
        if (result.success) {
          this.toast.success(`Test event "${payload.subscription['type']}" sent successfully`);
          this.closeTestModal();
        } else {
          this.toast.error(result.error || 'Failed to send test event');
        }
      },
      error: (err) => {
        this.toast.error('Failed to send test event: ' + (err.message || 'Unknown error'));
      }
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
        callback: 'https://subscriptions.domdimabot.com/eventsub'
      },
      created_at: now
    };

    const eventData = this.buildEventData(eventType, channelID, now, randomUserId, randomViewers);

    return {
      subscription: baseSubscription,
      event: eventData
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
      'channel.ban': '1'
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

  private buildEventData(type: string, channelID: string, now: string, randomUserId: string, randomViewers: number): Record<string, unknown> {
    const baseEvent: Record<string, unknown> = {
      broadcaster_user_id: channelID,
      broadcaster_user_login: 'teststreamer',
      broadcaster_user_name: 'TestStreamer'
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
            fragments: [{ text: 'This is a test message!', type: 'text' }]
          },
          message_type: 'text',
          badges: [],
          cheer: { bits: 0 },
          color: '#FF0000'
        };

      case 'channel.follow':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_name: 'TestFollower',
          user_login: 'testfollower',
          followed_at: now
        };

      case 'stream.online':
        return {
          ...baseEvent,
          started_at: now,
          type: 'live',
          id: `stream_online_${Date.now()}`
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
          viewers: randomViewers
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
            should_redemptions_skip_request_queue: false
          },
          user_input: 'test input',
          status: 'unfulfilled',
          redeemed_at: now
        };

      case 'channel.ad_break.begin':
        return {
          ...baseEvent,
          requester_user_id: randomUserId,
          requester_user_name: 'TestUser',
          requester_user_login: 'testuser',
          duration_seconds: 60,
          started_at: now,
          is_automatic: false
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
          is_permanent: true
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
          subscribed_at: now
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
          total: 5
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
          subscribed_at: now
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
          ended_at: now
        };

      case 'channel.bits.use':
        return {
          ...baseEvent,
          user_id: randomUserId,
          user_login: 'testuser',
          user_name: 'TestUser',
          bits: 100,
          type: 'cheer',
          is_anonymous: false
        };

      default:
        return baseEvent;
    }
  }
}
