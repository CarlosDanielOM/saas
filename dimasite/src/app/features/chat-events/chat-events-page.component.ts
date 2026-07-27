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
  ConfigControl,
  PlanTier,
  UserAccess
} from './chat-events.model';
import { ChatEventsService } from './chat-events.service';
import { EventCardComponent } from './components/event-card.component';

@Component({
  selector: 'app-chat-events-page',
  imports: [RouterLink, EventCardComponent],
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
  readonly configuringEvent = signal<string | null>(null);
  readonly pendingActions = signal<Record<string, ChatEventPendingAction>>({});

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'none';
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly enabledCount = computed(() => this.events().filter((e) => e.enabled).length);
  readonly premiumCount = computed(() => this.events().filter((e) => e.premium || e.pro).length);

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
    this.loadEvents(resolvedChannelId);
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
        const configuringName = this.configuringEvent();
        this.events.set(
          events.map((event) => ({
            ...event,
            isConfiguring: event.name === configuringName
          }))
        );
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

    const currentlyConfiguring = this.configuringEvent();

    if (currentlyConfiguring === event.name) {
      this.configuringEvent.set(null);
    } else {
      this.configuringEvent.set(event.name);
    }

    this.events.update((events) =>
      events.map((e) => ({
        ...e,
        isConfiguring: e.name === this.configuringEvent()
      }))
    );
  }

  toggleFeature(event: ChatEvent): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const newStatus = !event.enabled;
    this.setPendingAction(event.type, newStatus ? 'enabling' : 'disabling');

    this.chatEventsService.updateEventStatus(channelId, event.type, newStatus).subscribe({
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
                  subscriptionId: nextSubscriptionId,
                  isConfiguring: newStatus ? e.isConfiguring : false
                }
              : e
          )
        );
        this.clearPendingAction(event.type);
      },
      error: () => {
        this.clearPendingAction(event.type);
      }
    });
  }

  saveConfiguration(event: ChatEvent): void {
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
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const confirmed = confirm(
      `${this.t('chatEvents.deleteConfirmation.areYouSure')} "${event.name}"?\n\n${this.t('chatEvents.deleteConfirmation.warning')}`
    );

    if (!confirmed) {
      return;
    }

    this.setPendingAction(event.type, 'deleting');

    this.chatEventsService.deleteEvent(channelId, event.type).subscribe({
      next: () => {
        this.chatEventsService.clearCache(channelId);
        this.configuringEvent.update((current) => (current === event.name ? null : current));
        this.events.update((events) =>
          events.map((e) =>
            e.type === event.type
              ? {
                  ...e,
                  enabled: false,
                  isSubscribed: false,
                  subscriptionId: undefined,
                  isConfiguring: false
                }
              : e
          )
        );
        this.toastService.success(
          this.t('chatEvents.toasts.eventUnsubscribedTitle'),
          this.t('chatEvents.toasts.eventUnsubscribedMsg', { eventName: event.name })
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
