// @vitest-environment jsdom

import '@angular/compiler';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinksService } from '../../services/links.service';
import { ToastService } from '../../services/toast.service';
import { ChatEventsService } from './chat-events.service';

type HttpClientMock = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function createEventDefinition(options?: {
  beginControlId?: string;
  beginControlDbId?: string;
  beginControlValue?: string;
}): Record<string, unknown> {
  return {
    name: 'Ad Break Begin',
    type: 'channel.ad_break.begin',
    version: '1',
    condition: {
      broadcaster_user_id: 'user'
    },
    icon: 'BadgeInfo',
    color: '#ffffff',
    textColor: '#000000',
    releaseStage: 'stable',
    enabled: true,
    plan_tier: 'free',
    description: {
      EN: 'Announce when an ad break starts',
      ES: 'Anuncia cuando empieza un anuncio'
    },
    config: [
      {
        id: 'endMessage',
        label: { EN: 'End message', ES: 'Mensaje final' },
        type: 'text',
        value: 'Ad break ended',
        canDisable: true
      },
      {
        id: options?.beginControlId ?? 'beginMessage',
        dbId: options?.beginControlDbId,
        label: { EN: 'Begin message', ES: 'Mensaje inicial' },
        type: 'text',
        value: options?.beginControlValue ?? 'Default begin message',
        canDisable: true
      },
      {
        id: 'endEnabled',
        label: { EN: 'Send end message', ES: 'Enviar mensaje final' },
        type: 'checkbox',
        value: true,
        canDisable: false
      },
      {
        id: 'enableClip',
        label: { EN: 'Trigger clip', ES: 'Activar clip' },
        type: 'checkbox',
        value: false,
        canDisable: false
      }
    ],
    tierLimits: {
      free: 0,
      premium: 2,
      pro: 5
    }
  };
}

function createSubscription(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: 'subscription-1',
    id: 'twitch-subscription-1',
    status: 'enabled',
    type: 'channel.ad_break.begin',
    version: '1',
    enabled: true,
    condition: {
      broadcaster_user_id: '123'
    },
    transport: {
      method: 'webhook',
      callback: 'https://example.com/eventsub'
    },
    created_at: '2026-03-13T00:00:00.000Z',
    cost: 0,
    message: 'Saved begin message',
    endMessage: 'Saved end message',
    endEnabled: true,
    clipEnabled: false,
    ...overrides
  };
}

describe('ChatEventsService', () => {
  let service: ChatEventsService;
  let httpClient: HttpClientMock;
  let injector: Injector;
  const toastService = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  };

  beforeEach(() => {
    sessionStorage.clear();

    httpClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn()
    };

    toastService.success.mockReset();
    toastService.error.mockReset();
    toastService.warning.mockReset();
    toastService.info.mockReset();

    injector = Injector.create({
      providers: [
        { provide: HttpClient, useValue: httpClient },
        {
          provide: LinksService,
          useValue: {
            getApiUrl: () => 'http://api.test'
          }
        },
        { provide: ToastService, useValue: toastService }
      ],
      name: 'ChatEventsServiceSpecInjector'
    });

    service = runInInjectionContext(injector, () => new ChatEventsService());
  });

  afterEach(() => {
    service?.clearCache();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('hydrates backend message into the ad break begin control instead of the first message-like text control', async () => {
    httpClient.get.mockImplementation((url: string) => {
      if (url === 'http://api.test/site/events') {
        return of({
          error: false,
          message: 'ok',
          data: [createEventDefinition({ beginControlId: 'adBreakMessage' })]
        });
      }

      if (url === 'http://api.test/eventsubs/123') {
        return of({
          data: [createSubscription()]
        });
      }

      throw new Error(`Unexpected GET ${url}`);
    });

    const events = await firstValueFrom(service.getEvents('123'));
    const adBreakEvent = events.find((event) => event.type === 'channel.ad_break.begin');

    expect(adBreakEvent?.config?.find((control) => control.id === 'adBreakMessage')?.value).toBe('Saved begin message');
    expect(adBreakEvent?.config?.find((control) => control.id === 'endMessage')?.value).toBe('Saved end message');
  });

  it('hydrates message using dbId when a card defines a custom UI control id', async () => {
    httpClient.get.mockImplementation((url: string) => {
      if (url === 'http://api.test/site/events') {
        return of({
          error: false,
          message: 'ok',
          data: [createEventDefinition({ beginControlId: 'adStartCopy', beginControlDbId: 'message' })]
        });
      }

      if (url === 'http://api.test/eventsubs/123') {
        return of({
          data: [createSubscription()]
        });
      }

      throw new Error(`Unexpected GET ${url}`);
    });

    const events = await firstValueFrom(service.getEvents('123'));
    const adBreakEvent = events.find((event) => event.type === 'channel.ad_break.begin');

    expect(adBreakEvent?.config?.find((control) => control.id === 'adStartCopy')?.value).toBe('Saved begin message');
    expect(adBreakEvent?.config?.find((control) => control.id === 'endMessage')?.value).toBe('Saved end message');
  });

  it('normalizes ad break begin aliases to backend eventsub keys when creating a subscription', async () => {
    httpClient.get.mockImplementation((url: string) => {
      if (url === 'http://api.test/site/events') {
        return of({
          error: false,
          message: 'ok',
          data: [
            createEventDefinition({
              beginControlId: 'adBeginMessage',
              beginControlValue: '$(ad.time) seconds of ad break has begun!'
            })
          ]
        });
      }

      if (url === 'http://api.test/eventsubs/123') {
        return of({ data: [] });
      }

      throw new Error(`Unexpected GET ${url}`);
    });

    httpClient.post.mockReturnValue(of({
      error: false,
      message: 'created',
      data: createSubscription()
    }));

    await firstValueFrom(service.updateEventStatus('123', 'channel.ad_break.begin', true));

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post).toHaveBeenCalledWith(
      'http://api.test/eventsubs/123',
      expect.objectContaining({
        type: 'channel.ad_break.begin',
        version: '1',
        condition: {
          broadcaster_user_id: '123'
        },
        config: expect.objectContaining({
          message: '$(ad.time) seconds of ad break has begun!',
          endMessage: 'Ad break ended',
          endEnabled: true,
          clipEnabled: false
        })
      })
    );

    const createPayload = httpClient.post.mock.calls[0]?.[1] as { config?: Record<string, unknown> };
    expect(createPayload.config).not.toHaveProperty('adBeginMessage');
    expect(createPayload.config).not.toHaveProperty('adBreakMessage');
  });
});
