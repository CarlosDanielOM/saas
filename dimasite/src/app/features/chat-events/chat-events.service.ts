import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, of, forkJoin, throwError } from 'rxjs';
import { map, switchMap, tap, shareReplay, catchError } from 'rxjs/operators';

import {
  ChatEvent,
  ConfigControl,
  UserEventConfig,
  BackendSubscription,
  PlanTier,
  TierLimits,
  CheerTier
} from './chat-events.model';
import { LinksService } from '../../services/links.service';
import { ToastService } from '../../services/toast.service';
import { getConfigPersistenceKey, normalizeCheerTierArray, serializeConfigControlValue } from './chat-events.contract';

interface EventsApiResponse {
  error: boolean;
  message: string;
  data: unknown[];
}

interface SubscriptionsApiResponse {
  data: BackendSubscription[];
}

interface SubscriptionResponse<T = unknown> {
  error: boolean;
  message: string;
  data?: T;
}

const CANONICAL_BITS_EVENT_TYPE = 'channel.bits.use';
const LEGACY_BITS_EVENT_TYPES = ['channel.cheer', 'channel.bit.use'] as const;

function canonicalizeEventType(type: string): string {
  return LEGACY_BITS_EVENT_TYPES.includes(type as (typeof LEGACY_BITS_EVENT_TYPES)[number])
    ? CANONICAL_BITS_EVENT_TYPE
    : type;
}

function mergeConfigControls(
  existingControls: Partial<ConfigControl>[] | undefined,
  candidateControls: Partial<ConfigControl>[] | undefined
): Partial<ConfigControl>[] {
  const merged = new Map<string, Partial<ConfigControl>>();

  for (const control of existingControls || []) {
    if (control.id) {
      merged.set(control.id, control);
    }
  }

  for (const control of candidateControls || []) {
    if (!control.id) {
      continue;
    }

    const existing = merged.get(control.id);
    if (!existing) {
      merged.set(control.id, control);
      continue;
    }

    const existingValue = existing.value;
    const candidateValue = control.value;
    const existingHasValue = Array.isArray(existingValue)
      ? existingValue.length > 0
      : existingValue !== undefined && existingValue !== '';
    const candidateHasValue = Array.isArray(candidateValue)
      ? candidateValue.length > 0
      : candidateValue !== undefined && candidateValue !== '';

    merged.set(control.id, candidateHasValue && !existingHasValue ? control : existing);
  }

  return Array.from(merged.values());
}

@Injectable({
  providedIn: 'root'
})
export class ChatEventsService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly toastService = inject(ToastService);
  private readonly cacheKeyPrefix = 'eventsCache:v3';

  private readonly eventsCacheByChannel = new Map<string, Observable<ChatEvent[]>>();

  // Tier limits by plan
  readonly tierLimits = {
    default: { premium: 3, pro: 10 }
  };

  readonly isLoading = signal(false);

  getEvents(channelId: string): Observable<ChatEvent[]> {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return throwError(() => new Error('No channel ID found'));
    }

    const cachedEvents = this.eventsCacheByChannel.get(normalizedChannelId);
    if (cachedEvents) {
      return cachedEvents;
    }

    const cacheKey = this.getCacheKey(normalizedChannelId);
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown[];
      const hydrated = of(parsed.map((event) => this.normalizeChatEvent(event)));
      this.eventsCacheByChannel.set(normalizedChannelId, hydrated);
      return hydrated;
    }

    const events$ = this.getBotSupportedEvents().pipe(
      switchMap(allSupportedEvents => 
        forkJoin({
          allSupportedEvents: of(allSupportedEvents),
          userConfigs: this.getUserConfiguredEvents(normalizedChannelId, allSupportedEvents)
        })
      ),
      map(({ allSupportedEvents, userConfigs }) => {
        return allSupportedEvents.map(defaultEvent => {
          const userConfig = userConfigs.find(c => c.name === defaultEvent.type);

          if (!userConfig) {
            return { ...defaultEvent, isSubscribed: false };
          }

          const mergedEvent: ChatEvent = { 
            ...defaultEvent, 
            isSubscribed: true,
            enabled: userConfig.enabled ?? false,
            subscriptionId: userConfig.subscriptionId
          };

          if (userConfig.config) {
            if (!mergedEvent.config) {
              mergedEvent.config = [];
            }
            
            mergedEvent.config = mergedEvent.config.map(defaultControl => {
              const matchingUserControl = userConfig.config?.find((control) => {
                if (!control.id) {
                  return false;
                }

                return control.id === defaultControl.id || control.id === defaultControl.dbId;
              });

              const userValue = matchingUserControl?.value;
              if (userValue !== undefined) {
                const mergedControl = { ...defaultControl, value: userValue };
                if (userValue === '' && typeof defaultControl.value === 'string' && defaultControl.value) {
                  mergedControl.placeholder = defaultControl.value;
                }
                return mergedControl;
              }

              return defaultControl;
            });
          }
          
          return mergedEvent;
        });
      }),
      tap(events => {
        sessionStorage.setItem(cacheKey, JSON.stringify(events));
      }),
      shareReplay(1)
    );

    this.eventsCacheByChannel.set(normalizedChannelId, events$);
    return events$;
  }

  clearCache(channelId?: string): void {
    sessionStorage.removeItem('eventsCache');

    if (channelId) {
      const normalizedChannelId = channelId.trim();
      this.eventsCacheByChannel.delete(normalizedChannelId);
      sessionStorage.removeItem(this.getCacheKey(normalizedChannelId));
      return;
    }

    for (const cachedChannelId of this.eventsCacheByChannel.keys()) {
      sessionStorage.removeItem(this.getCacheKey(cachedChannelId));
    }

    this.eventsCacheByChannel.clear();
  }

  deleteEvent(channelId: string, eventType: string): Observable<SubscriptionResponse> {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return throwError(() => new Error('No channel ID found'));
    }

    return this.getEvents(normalizedChannelId).pipe(
      switchMap(events => {
        const event = events.find(e => e.type === eventType);
        if (!event?.subscriptionId) {
          this.toastService.error('Not Found', 'Could not find a subscription to delete for this event.');
          return throwError(() => new Error('Subscription not found for deletion.'));
        }

        return this.http.delete<SubscriptionResponse>(
          `${this.linksService.getApiUrl()}/eventsubs/${normalizedChannelId}/${event.subscriptionId}`
        ).pipe(
          tap(() => {
            this.clearCache(normalizedChannelId);
          })
        );
      })
    );
  }

  updateEventStatus(channelId: string, eventType: string, enabled: boolean): Observable<SubscriptionResponse<BackendSubscription | null>> {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return throwError(() => new Error('No channel ID found'));
    }

    if (enabled) {
      return this.getEvents(normalizedChannelId).pipe(
        switchMap(events => {
          const event = events.find(e => e.type === eventType);
          if (!event) {
            throw new Error(`Event ${eventType} not found in cached events`);
          }

          const subscriptionId = event.subscriptionId;

          if (subscriptionId) {
            return this.http.patch<SubscriptionResponse<BackendSubscription>>(
              `${this.linksService.getApiUrl()}/eventsubs/${normalizedChannelId}/${subscriptionId}`,
              { enabled: true }
            ).pipe(
              tap(() => {
                this.toastService.success('Status Updated', `${eventType} has been enabled.`);
              }),
              catchError((error: unknown) => {
                const err = error as { status?: number; error?: { message?: string }; message?: string };
                const statusCode = err.status || 'Unknown';
                const reason = err.error?.message || err.message || 'Unknown error occurred';
                this.toastService.error(`Error ${statusCode}`, reason);
                throw error;
              })
            );
          } else {
            return this.getBotSupportedEvents().pipe(
              switchMap(botEvents => {
                const eventDef = botEvents.find(e => e.type === eventType);
                if (!eventDef) {
                  throw new Error(`Bot event definition for ${eventType} not found`);
                }

                const condition: Record<string, string> = {};
                const conditionSchema = eventDef.condition || {};

                for (const key in conditionSchema) {
                  if (Object.prototype.hasOwnProperty.call(conditionSchema, key)) {
                    const idSource = conditionSchema[key];
                    switch (idSource) {
                      case 'user':
                        condition[key] = normalizedChannelId;
                        break;
                      case 'moderator':
                        condition[key] = '698614112';
                        break;
                      case 'channel':
                        this.toastService.error(
                          'Configuration Required',
                          `The '${key}' for event '${eventType}' must be configured manually.`
                        );
                        return throwError(() => new Error(`Manual configuration required for ${eventType}.`));
                      default:
                        condition[key] = idSource!;
                        break;
                    }
                  }
                }

                const body: Record<string, unknown> = {
                  type: eventDef.type,
                  version: eventDef.version,
                  condition: condition
                };

                if (eventDef.config && Array.isArray(eventDef.config)) {
                  const configPayload: Record<string, unknown> = {};
                  eventDef.config.forEach((control: ConfigControl) => {
                    const key = getConfigPersistenceKey(control);
                    if (key && typeof control.value !== 'undefined') {
                      configPayload[key] = serializeConfigControlValue(control);
                    }
                  });
                  if (Object.keys(configPayload).length > 0) {
                    body['config'] = configPayload;
                  }
                }

                return this.http.post<SubscriptionResponse<BackendSubscription>>(
                  `${this.linksService.getApiUrl()}/eventsubs/${normalizedChannelId}`,
                  body
                ).pipe(
                  tap(() => {
                    this.clearCache(normalizedChannelId);
                    this.toastService.success('Status Updated', `${eventType} has been enabled.`);
                  }),
                  catchError((error: unknown) => {
                    const err = error as { status?: number; error?: { message?: string }; message?: string };
                    const statusCode = err.status || 'Unknown';
                    const reason = err.error?.message || err.message || 'Unknown error occurred';
                    this.toastService.error(`Error ${statusCode}`, reason);
                    throw error;
                  })
                );
              })
            );
          }
        })
      );
    } else {
      return this.getEvents(normalizedChannelId).pipe(
        switchMap(events => {
          const event = events.find(e => e.type === eventType);
          if (!event) {
            throw new Error(`Event ${eventType} not found in cached events`);
          }
          
          const subscriptionId = event.subscriptionId;
          if (!subscriptionId) {
            return of({ error: false, message: 'Subscription not found, nothing to disable.', data: null });
          }
          
          return this.http.patch<SubscriptionResponse<BackendSubscription>>(
            `${this.linksService.getApiUrl()}/eventsubs/${normalizedChannelId}/${subscriptionId}`,
            { enabled: false }
          ).pipe(
            tap(() => {
              this.toastService.success('Status Updated', `${eventType} has been disabled.`);
            }),
            catchError((error: unknown) => {
              const err = error as { status?: number; error?: { message?: string }; message?: string };
              const statusCode = err.status || 'Unknown';
              const reason = err.error?.message || err.message || 'Unknown error occurred';
              this.toastService.error(`Error ${statusCode}`, reason);
              throw error;
            })
          );
        })
      );
    }
  }

  saveEventConfiguration(channelId: string, eventName: string, configToSave: Record<string, unknown>): Observable<SubscriptionResponse<BackendSubscription | null>> {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return throwError(() => new Error('No channel ID found'));
    }

    return this.getEvents(normalizedChannelId).pipe(
      switchMap(events => {
        const event = events.find(e => e.type === eventName);
        if (!event?.subscriptionId) {
          this.toastService.error('Not Found', 'Could not find a subscription to update for this event.');
          return throwError(() => new Error('Subscription not found for update.'));
        }

        return this.http.patch<SubscriptionResponse<BackendSubscription>>(
          `${this.linksService.getApiUrl()}/eventsubs/${normalizedChannelId}/${event.subscriptionId}`,
          configToSave
        ).pipe(
          tap(() => {
            this.clearCache(normalizedChannelId);
            this.toastService.success('Configuration Saved', 'Your changes have been saved successfully.');
          }),
          catchError((error: unknown) => {
            const err = error as { status?: number; error?: { message?: string }; message?: string };
            const statusCode = err.status || 'Unknown';
            const reason = err.error?.message || err.message || 'Unknown error occurred';
            this.toastService.error(`Error ${statusCode}`, reason);
            throw error;
          })
        );
      })
    );
  }

  private getBotSupportedEvents(): Observable<ChatEvent[]> {
    return this.http.get<EventsApiResponse>(
      `${this.linksService.getApiUrl()}/site/events`
    ).pipe(
      map(response => {
        const events = (response.data || []).map((event) => this.normalizeChatEvent(event));
        return events.filter((event, index, all) => all.findIndex((candidate) => candidate.type === event.type) === index);
      })
    );
  }

  private getUserConfiguredEvents(channelId: string, allSupportedEvents: ChatEvent[]): Observable<UserEventConfig[]> {
    return this.http.get<SubscriptionsApiResponse>(
      `${this.linksService.getApiUrl()}/eventsubs/${channelId}`
    ).pipe(
      map(response => {
        const subscriptionsArray = response.data || [];

        const configs = subscriptionsArray
          .filter((sub: BackendSubscription) => sub && sub.type)
          .map((subscription: BackendSubscription) => {
            const normalizedSubscriptionType = canonicalizeEventType(subscription.type);
            const eventDef = allSupportedEvents.find(e => e.type === normalizedSubscriptionType);
            const userConfigControls: Partial<ConfigControl>[] = [];

            if (subscription['message'] !== undefined && eventDef && eventDef.config) {
              const textControl = eventDef.config.find((control) =>
                control.type === 'text' && getConfigPersistenceKey(control) === 'message'
              ) ?? eventDef.config.find((control) =>
                control.type === 'text' && control.id.toLowerCase().includes('message')
              );
              const messageValue = this.asPrimitiveValue(subscription['message']);
              if (textControl) {
                userConfigControls.push({
                  id: textControl.id,
                  value: messageValue ?? ''
                });
              }
            }
            const clipEnabled = this.asBoolean(subscription['clipEnabled']);
            if (clipEnabled !== undefined) {
              userConfigControls.push({
                id: 'enableClip',
                value: clipEnabled
              });
            }
            const minViewers = this.asNumber(subscription['minViewers']);
            if (minViewers !== undefined) {
              userConfigControls.push({
                id: 'minViewers',
                value: minViewers
              });
            }
            const endMessage = this.asPrimitiveValue(subscription['endMessage']);
            if (endMessage !== undefined) {
              userConfigControls.push({
                id: 'endMessage',
                value: endMessage
              });
            }
            const endEnabled = this.asBoolean(subscription['endEnabled']);
            if (endEnabled !== undefined) {
              userConfigControls.push({
                id: 'endEnabled',
                value: endEnabled
              });
            }
            const cheerTiers = this.asCheerTierArray(subscription['cheerTiers']);
            if (normalizedSubscriptionType === CANONICAL_BITS_EVENT_TYPE && cheerTiers) {
              userConfigControls.push({
                id: 'cheerTiers',
                value: cheerTiers
              });
            }
            return {
              name: normalizedSubscriptionType,
              enabled: subscription.enabled,
              subscriptionId: subscription._id,
              config: userConfigControls,
            };
          });

        return configs.reduce<UserEventConfig[]>((acc, config) => {
          const existingIndex = acc.findIndex(item => item.name === config.name);
          if (existingIndex === -1) {
            acc.push(config);
            return acc;
          }

          const existing = acc[existingIndex];
          const shouldReplace = !existing.subscriptionId && !!config.subscriptionId;
          if (shouldReplace) {
            acc[existingIndex] = config;
            return acc;
          }

          acc[existingIndex] = {
            ...existing,
            enabled: existing.enabled === false ? false : config.enabled,
            subscriptionId: existing.subscriptionId || config.subscriptionId,
            config: mergeConfigControls(existing.config, config.config)
          };

          return acc;
        }, []);
      }),
      catchError((error: unknown) => {
        const err = error as { status?: number };
        if (err.status === 404) {
          return of([]);
        }

        return throwError(() => error);
      })
    );
  }

  // Helper methods for tier management
  getTierLimit(tierLimits: TierLimits | undefined, userPlan: PlanTier): number {
    if (!tierLimits) {
      return Infinity;
    }
    switch (userPlan) {
      case 'premium_plus':
        return tierLimits.pro;
      case 'premium':
        return tierLimits.premium;
      default:
        return 0;
    }
  }

  canAddTier(tierLimits: TierLimits | undefined, currentTiers: unknown[], userPlan: PlanTier): boolean {
    if (!tierLimits || !Array.isArray(currentTiers)) {
      return true;
    }
    const limit = this.getTierLimit(tierLimits, userPlan);
    return currentTiers.length < limit;
  }

  private asPrimitiveValue(value: unknown): string | number | boolean | undefined {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    return undefined;
  }

  private asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private asCheerTierArray(value: unknown): CheerTier[] | undefined {
    return normalizeCheerTierArray(value);
  }

  private normalizeChatEvent(event: unknown): ChatEvent {
    const source = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
    const planTier = typeof source['plan_tier'] === 'string' ? source['plan_tier'] : 'free';

    return {
      name: this.asString(source['name']),
      type: canonicalizeEventType(this.asString(source['type'])),
      version: this.asString(source['version'], '1'),
      condition: this.asCondition(source['condition']),
      description: this.normalizeLocalizedText(source['description']),
      icon: this.asString(source['icon'], 'X'),
      color: this.asString(source['color']),
      textColor: this.asString(source['textColor']),
      releaseStage: this.asReleaseStage(source['releaseStage']),
      enabled: this.asBoolean(source['enabled']) ?? false,
      premium: planTier === 'premium' || planTier === 'pro',
      pro: planTier === 'pro',
      config: this.normalizeConfigControls(source['config']),
      tierLimits: this.normalizeTierLimits(source['tierLimits'])
    };
  }

  private normalizeConfigControls(value: unknown): ConfigControl[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const controls = value
      .map((control): ConfigControl | null => {
        if (!control || typeof control !== 'object') {
          return null;
        }

        const source = control as Record<string, unknown>;
        const type = source['type'];
        const normalizedType =
          type === 'text' || type === 'number' || type === 'checkbox' || type === 'message-tiers' || type === 'select'
            ? type
            : 'text';

        return {
          id: this.asString(source['id']),
          dbId: this.asOptionalString(source['dbId']),
          label: this.normalizeLocalizedText(source['label']),
          type: normalizedType,
          value: this.normalizeControlValue(source['value'], normalizedType),
          placeholder: this.asOptionalString(source['placeholder']),
          showIf: this.normalizeShowIf(source['showIf']),
          canDisable: this.asBoolean(source['canDisable'])
        };
      })
      .filter((control): control is ConfigControl => control !== null);

    return controls.length > 0 ? controls : undefined;
  }

  private normalizeControlValue(value: unknown, type: ConfigControl['type']): ConfigControl['value'] {
    if (type === 'checkbox') {
      return this.asBoolean(value) ?? false;
    }

    if (type === 'number') {
      return this.asNumber(value) ?? 0;
    }

    if (type === 'message-tiers') {
      return this.asCheerTierArray(value) ?? [];
    }

    return typeof value === 'string' ? value : '';
  }

  private normalizeShowIf(value: unknown): ConfigControl['showIf'] | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const source = value as Record<string, unknown>;
    const controlId = this.asOptionalString(source['controlId']);
    const is = source['is'];

    if (!controlId || typeof is === 'undefined') {
      return undefined;
    }

    return { controlId, is };
  }

  private normalizeTierLimits(value: unknown): TierLimits | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const source = value as Record<string, unknown>;
    return {
      premium: this.asNumber(source['premium']) ?? 0,
      pro: this.asNumber(source['pro']) ?? 0
    };
  }

  private normalizeLocalizedText(value: unknown): { en: string; es: string } {
    if (!value || typeof value !== 'object') {
      return { en: '', es: '' };
    }

    const source = value as Record<string, unknown>;
    return {
      en: this.asString(source['en'] ?? source['EN']),
      es: this.asString(source['es'] ?? source['ES'])
    };
  }

  private asCondition(value: unknown): { [key: string]: string | undefined } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const condition: Record<string, string | undefined> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      condition[key] = typeof raw === 'string' ? raw : undefined;
    }
    return condition;
  }

  private asReleaseStage(value: unknown): ChatEvent['releaseStage'] {
    return value === 'stable'
      || value === 'beta'
      || value === 'alpha'
      || value === 'coming_soon'
      || value === 'maintenance'
      || value === 'unavailable'
      || value === 'deprecated'
      ? value
      : 'stable';
  }

  private asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
  }

  private asOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private getCacheKey(channelId: string): string {
    return `${this.cacheKeyPrefix}:${channelId}`;
  }
}
