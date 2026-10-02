import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { getConfigPersistenceKey, serializeConfigControlValue } from './chat-events.contract';
import {
  ChatEvent,
  ChatEventPendingAction,
  ChatNotice,
  ConfigControl,
  PlanTier,
  UserAccess
} from './chat-events.model';
import { ChatEventsService } from './chat-events.service';
import { EventCardComponent } from './components/event-card.component';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

const CHAT_NOTIFICATION_TYPE = 'channel.chat.notification';

/** Each notice has its own on/off flag and message on the shared subscription. */
const NOTICE_FIELDS: Readonly<Record<ChatNotice, { flag: string; message: string; i18n: string; icon: string }>> = {
  watch_streak: { flag: 'watchStreakEnabled', message: 'message', i18n: 'chatEvents.watchStreak', icon: 'Flame' },
  modiversary: { flag: 'modiversaryEnabled', message: 'modiversaryMessage', i18n: 'chatEvents.modiversary', icon: 'Award' }
};

type EventGroupId = 'community' | 'stream';

const STREAM_EVENT_TYPES: readonly string[] = ['stream.online', 'stream.offline', 'channel.ad_break.begin'];
const EVENT_ORDER: readonly string[] = [
  'channel.follow',
  'channel.raid',
  'channel.bits.use',
  `${CHAT_NOTIFICATION_TYPE}:watch_streak`,
  `${CHAT_NOTIFICATION_TYPE}:modiversary`,
  'stream.online',
  'stream.offline',
  'channel.ad_break.begin'
];

interface EventGroup {
  id: EventGroupId;
  events: ChatEvent[];
}

@Component({
  selector: 'app-chat-events-page',
  imports: [RouterLink, EventCardComponent, LfIconComponent],
  styleUrl: './chat-events-page.component.css',
  templateUrl: './chat-events-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatEventsPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly chatEventsService = inject(ChatEventsService);
  private readonly toastService = inject(ToastService);

  readonly streamer = toSignal(
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') }
  );
  readonly channelID = signal<string | null>(null);

  readonly events = signal<ChatEvent[]>([]);
  readonly isLoading = signal(true);
  readonly canManage = signal(false);
  readonly permissionLoaded = signal(false);
  readonly configuringEvent = signal<string | null>(null);
  readonly pendingActions = signal<Record<string, ChatEventPendingAction>>({});

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.getPlanTierForStreamer(this.streamer());
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  /** Events as shown to the streamer: chat notifications become one card per notice. */
  readonly cards = computed<ChatEvent[]>(() => {
    this.languageService.currentLanguage();
    const configuring = this.configuringEvent();
    return this.events()
      .flatMap((event) =>
        event.type === CHAT_NOTIFICATION_TYPE
          ? (Object.keys(NOTICE_FIELDS) as ChatNotice[]).map((notice) => this.buildNoticeCard(event, notice))
          : [event]
      )
      .map((event) => ({ ...event, isConfiguring: this.cardKey(event) === configuring }))
      .sort((a, b) => this.orderOf(a) - this.orderOf(b));
  });

  readonly groups = computed<EventGroup[]>(() => {
    const cards = this.cards();
    return (['community', 'stream'] as const)
      .map((id) => ({
        id,
        events: cards.filter((event) => (STREAM_EVENT_TYPES.includes(event.type) ? 'stream' : 'community') === id)
      }))
      .filter((group) => group.events.length > 0);
  });

  readonly enabledCount = computed(() => this.cards().filter((e) => e.enabled).length);

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer() ?? '';
    const resolvedChannelId = routeStreamer
      ? await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer))
      : this.sessionAuth.getPrimaryChannelID();

    if (!resolvedChannelId) {
      this.isLoading.set(false);
      this.toastService.error(this.t('chatErrors.loadTitle'), this.t('chatErrors.loadMessage'));
      return;
    }

    this.channelID.set(resolvedChannelId);
    void this.loadPermission(resolvedChannelId);
    this.loadEvents(resolvedChannelId);
  }

  private async loadPermission(channelID: string): Promise<void> {
    try {
      this.canManage.set(await firstValueFrom(this.sessionAuth.checkPermission(channelID, 'eventsubs:manage')));
    } catch {
      this.canManage.set(false);
    } finally {
      this.permissionLoaded.set(true);
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  loadEvents(channelId = this.channelID()): void {
    if (!channelId) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);

    this.chatEventsService.getEvents(channelId).subscribe({
      next: (events) => {
        this.events.set(events);
        this.isLoading.set(false);
      },
      error: () => {
        this.toastService.error(this.t('chatErrors.loadTitle'), this.t('chatErrors.loadMessage'));
        this.isLoading.set(false);
      }
    });
  }

  getUserAccess(event: ChatEvent): UserAccess {
    if (!event.premium && !event.pro) {
      return { canAccess: true };
    }

    const userPlan = this.userPlan();

    if (event.pro && userPlan !== 'premium_plus') {
      return {
        canAccess: false,
        reason: userPlan === 'premium' ? 'needs_pro' : 'needs_premium'
      };
    }

    if (event.premium && userPlan === 'none') {
      return { canAccess: false, reason: 'needs_premium' };
    }

    return { canAccess: true };
  }

  toggleConfigure(event: ChatEvent): void {
    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const key = this.cardKey(event);
    this.configuringEvent.update((current) => (current === key ? null : key));
  }

  cardKey(event: ChatEvent): string {
    return event.notice ? `${event.type}:${event.notice}` : event.type;
  }

  eventLabel(event: ChatEvent): string {
    return event.type === CHAT_NOTIFICATION_TYPE && !event.notice ? this.t('chatEvents.notificationsName') : event.name;
  }

  toggleFeature(event: ChatEvent): void {
    if (!this.canManage()) return;
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    if (event.notice) {
      this.toggleNotice(channelId, event, event.notice);
      return;
    }

    const newStatus = !event.enabled;
    this.setPendingAction(event.type, newStatus ? 'enabling' : 'disabling');

    this.chatEventsService.updateEventStatus(channelId, event.type, newStatus, { label: this.eventLabel(event) }).subscribe({
      next: (response) => {
        this.chatEventsService.clearCache(channelId);
        const nextSubscriptionId = response.data?._id ?? event.subscriptionId;

        this.events.update((events) =>
          events.map((e) =>
            e.type === event.type
              ? {
                  ...e,
                  enabled: newStatus,
                  isSubscribed: newStatus ? true : e.isSubscribed,
                  subscriptionId: nextSubscriptionId
                }
              : e
          )
        );
        if (!newStatus) {
          this.configuringEvent.update((current) => (current === this.cardKey(event) ? null : current));
        }
        this.clearPendingAction(event.type);
      },
      error: () => {
        this.clearPendingAction(event.type);
      }
    });
  }

  /**
   * Watch streaks and mod anniversaries share one Twitch subscription. Each card flips only its
   * own flag; the subscription itself is enabled while either notice is on.
   */
  private toggleNotice(channelId: string, card: ChatEvent, notice: ChatNotice): void {
    const base = this.events().find((e) => e.type === CHAT_NOTIFICATION_TYPE);
    if (!base) return;

    const other: ChatNotice = notice === 'watch_streak' ? 'modiversary' : 'watch_streak';
    const flag = NOTICE_FIELDS[notice].flag;
    const otherFlag = NOTICE_FIELDS[other].flag;
    const otherOn = Boolean(base.enabled && this.noticeFlag(base, other));
    const turningOn = !card.enabled;
    const label = card.name;

    this.setPendingAction(card.type, turningOn ? 'enabling' : 'disabling');

    const request = turningOn
      ? this.chatEventsService.updateEventStatus(channelId, CHAT_NOTIFICATION_TYPE, true, {
          fields: { [flag]: true, [otherFlag]: otherOn },
          label
        })
      : otherOn
        ? this.chatEventsService.saveEventConfiguration(channelId, CHAT_NOTIFICATION_TYPE, { [flag]: false })
        : this.chatEventsService.updateEventStatus(channelId, CHAT_NOTIFICATION_TYPE, false, {
            fields: { [flag]: false },
            label
          });

    request.subscribe({
      next: (response) => {
        this.chatEventsService.clearCache(channelId);
        const subscriptionId = response.data?._id ?? base.subscriptionId;
        this.events.update((events) =>
          events.map((e) =>
            e.type === CHAT_NOTIFICATION_TYPE
              ? {
                  ...e,
                  enabled: turningOn || otherOn,
                  isSubscribed: turningOn ? true : e.isSubscribed,
                  subscriptionId,
                  config: e.config?.map((control) => {
                    const key = getConfigPersistenceKey(control);
                    if (key === flag) return { ...control, value: turningOn };
                    if (key === otherFlag && turningOn) return { ...control, value: otherOn };
                    return control;
                  })
                }
              : e
          )
        );
        if (!turningOn) {
          this.configuringEvent.update((current) => (current === this.cardKey(card) ? null : current));
        }
        this.clearPendingAction(card.type);
      },
      error: () => {
        this.clearPendingAction(card.type);
      }
    });
  }

  private buildNoticeCard(base: ChatEvent, notice: ChatNotice): ChatEvent {
    const fields = NOTICE_FIELDS[notice];
    const name = this.t(`${fields.i18n}.name`);
    const description = this.t(`${fields.i18n}.description`);
    return {
      ...base,
      notice,
      name,
      icon: fields.icon,
      description: { en: description, es: description },
      enabled: Boolean(base.enabled && this.noticeFlag(base, notice)),
      config: base.config?.filter((control) => getConfigPersistenceKey(control) === fields.message)
    };
  }

  private noticeFlag(base: ChatEvent, notice: ChatNotice): boolean {
    const control = base.config?.find((c) => getConfigPersistenceKey(c) === NOTICE_FIELDS[notice].flag);
    return control?.value !== false;
  }

  private orderOf(event: ChatEvent): number {
    const index = EVENT_ORDER.indexOf(this.cardKey(event));
    return index === -1 ? EVENT_ORDER.length : index;
  }

  saveConfiguration(event: ChatEvent): void {
    if (!this.canManage()) return;
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    if (!event.config) {
      this.toastService.error(
        this.t('chatEvents.toasts.noConfigurationTitle'),
        this.t('chatEvents.toasts.noConfigurationMsg')
      );
      return;
    }

    const payload = this.prepareConfigForSave(event.config);
    this.setPendingAction(event.type, 'saving');

    this.chatEventsService.saveEventConfiguration(channelId, event.type, payload).subscribe({
      next: () => {
        this.chatEventsService.clearCache(channelId);
        this.clearPendingAction(event.type);
        this.toggleConfigure(event);
      },
      error: () => {
        this.clearPendingAction(event.type);
      }
    });
  }

  deleteEvent(event: ChatEvent): void {
    if (!this.canManage()) return;
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const confirmed = confirm(
      `${this.t('chatEvents.deleteConfirmation.areYouSure')} "${this.eventLabel(event)}"?\n\n${this.t('chatEvents.deleteConfirmation.warning')}`
    );

    if (!confirmed) {
      return;
    }

    this.setPendingAction(event.type, 'deleting');

    this.chatEventsService.deleteEvent(channelId, event.type).subscribe({
      next: () => {
        this.chatEventsService.clearCache(channelId);
        this.configuringEvent.update((current) => (current === this.cardKey(event) ? null : current));
        this.events.update((events) =>
          events.map((e) =>
            e.type === event.type
              ? {
                  ...e,
                  enabled: false,
                  isSubscribed: false,
                  subscriptionId: undefined
                }
              : e
          )
        );
        this.toastService.success(
          this.t('chatEvents.toasts.eventUnsubscribedTitle'),
          this.t('chatEvents.toasts.eventUnsubscribedMsg', { eventName: this.eventLabel(event) })
        );
        this.clearPendingAction(event.type);
      },
      error: () => {
        this.clearPendingAction(event.type);
      }
    });
  }

  getPendingAction(eventType: string): ChatEventPendingAction {
    return this.pendingActions()[eventType] ?? 'none';
  }

  onUpgrade(): void {
    if (!this.canManage()) return;
    const streamer = this.streamer();
    if (streamer) {
      void this.router.navigate([streamer, 'settings']);
    }
  }

  private setPendingAction(eventType: string, action: ChatEventPendingAction): void {
    this.pendingActions.update((state) => ({
      ...state,
      [eventType]: action
    }));
  }

  private clearPendingAction(eventType: string): void {
    this.pendingActions.update((state) => {
      const nextState = { ...state };
      delete nextState[eventType];
      return nextState;
    });
  }

  private prepareConfigForSave(configControls: ConfigControl[]): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const control of configControls) {
      const key = getConfigPersistenceKey(control);
      if (key && control.value !== undefined) {
        payload[key] = serializeConfigControlValue(control);
      }
    }
    return payload;
  }
}
