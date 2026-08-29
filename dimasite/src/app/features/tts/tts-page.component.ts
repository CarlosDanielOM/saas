import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import {
  type TtsProvider,
  type TtsRole,
  type TtsSettings
} from '../../models/tts-settings.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

interface VoiceOption {
  value: string;
  label: string;
  isSavedValue?: boolean;
}

type TtsLanguage = 'en' | 'es';
type TtsFilterKey = 'skipEmotes' | 'stripLinks' | 'normalizeWhitespace';

const DEFAULT_PIPER_EN_VOICE = 'en_US-ryan-medium';
const DEFAULT_PIPER_ES_VOICE = 'es_MX-ald-medium';

const PIPER_VOICE_OPTIONS: Record<TtsLanguage, VoiceOption[]> = {
  en: [{ value: DEFAULT_PIPER_EN_VOICE, label: 'Ryan - US English' }],
  es: [{ value: DEFAULT_PIPER_ES_VOICE, label: 'Ald - Mexican Spanish' }]
};

const FISH_VOICE_OPTIONS: VoiceOption[] = [
  { value: 'carlos_bodoque', label: 'Carlos Bodoque' },
  { value: 'gojo', label: 'Gojo' },
  { value: 'rias_gremory', label: 'Rias Gremory' },
  { value: 'toji_fushiguro', label: 'Toji Fushiguro' }
];

function mergeCurrentOption(options: VoiceOption[], currentValue: string | null | undefined, label: string): VoiceOption[] {
  const normalizedValue = typeof currentValue === 'string' ? currentValue.trim() : '';
  if (!normalizedValue || options.some((option) => option.value === normalizedValue)) {
    return options;
  }

  return [{ value: normalizedValue, label, isSavedValue: true }, ...options];
}

@Component({
  selector: 'app-tts-page',
  imports: [RouterLink],
  templateUrl: './tts-page.component.html',
  styleUrl: './tts-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TtsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly ttsSettingsApi = inject(TtsSettingsApiService);
  private readonly toastService = inject(ToastService);

  readonly urlCopied = signal(false);
  readonly ttsSettings = signal<TtsSettings | null>(null);
  readonly initialTtsSettings = signal<TtsSettings | null>(null);
  readonly ttsRole = signal<TtsRole>('none');
  readonly ttsLoading = signal(false);
  readonly ttsSaving = signal(false);
  readonly ttsErrorMessage = signal<string | null>(null);

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({ streamer, channelID: null, status: 'idle' });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const })),
        startWith({ streamer, channelID: null, status: 'loading' as const })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });

  readonly channelID = computed(() => this.channelResolution().channelID);
  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });
  readonly session = this.sessionAuth.session;
  readonly ownerChannelID = computed(() => this.session()?.appUser.twitch_user_id ?? '');
  readonly ownerLogin = computed(() => (this.session()?.twitchUser.login || '').trim().toLowerCase());
  readonly isOwnerView = computed(() => {
    const streamer = this.streamer();
    const channelID = this.channelID();

    return Boolean(streamer && this.ownerLogin() === streamer) || Boolean(channelID && channelID === this.ownerChannelID());
  });
  readonly hasTtsSettings = computed(() => this.ttsSettings() !== null);
  readonly ttsReadOnly = computed(() => this.ttsRole() !== 'owner');
  readonly ttsDirty = computed(
    () => this.serializeTtsSettings(this.ttsSettings()) !== this.serializeTtsSettings(this.initialTtsSettings())
  );
  readonly speechApiUrl = computed(() => {
    const channelID = this.channelID();
    return channelID ? `https://api.domdimabot.com/speech/${channelID}` : '';
  });
  readonly isPremiumOrPro = computed(() => {
    const planTier = this.session()?.appUser.plan_tier;
    return planTier === 'premium' || planTier === 'pro';
  });

  readonly isPro = computed(() => {
    const planTier = this.session()?.appUser.plan_tier;
    return planTier === 'pro';
  });

  readonly defaultProviderOptions = computed<VoiceOption[]>(() => [
    { value: 'piper', label: this.t('modules.tts.fields.providerPiper') },
    { value: 'fish', label: this.t('modules.tts.fields.providerFish') }
  ]);

  readonly englishVoiceOptions = computed(() =>
    mergeCurrentOption(
      PIPER_VOICE_OPTIONS.en,
      this.ttsSettings()?.voices.en,
      this.t('modules.tts.fields.savedValueOption', { value: this.ttsSettings()?.voices.en ?? '' })
    )
  );
  readonly spanishVoiceOptions = computed(() =>
    mergeCurrentOption(
      PIPER_VOICE_OPTIONS.es,
      this.ttsSettings()?.voices.es,
      this.t('modules.tts.fields.savedValueOption', { value: this.ttsSettings()?.voices.es ?? '' })
    )
  );
  readonly showCloneSettings = computed(() => this.ttsSettings()?.provider === 'fish');
  readonly cloneDefaultVoiceOptions = computed(() => {
    const current = this.ttsSettings()?.voices.cloneDefault;
    return mergeCurrentOption(FISH_VOICE_OPTIONS, current, this.t('modules.tts.fields.savedValueOption', { value: current ?? '' }));
  });
  readonly currentCloneDefaultVoiceLabel = computed(() => {
    const settings = this.ttsSettings();
    const voiceName = settings?.voices.cloneDefault;
    if (!voiceName) return 'Gojo';
    const found = FISH_VOICE_OPTIONS.find((v) => v.value === voiceName);
    return found?.label ?? voiceName;
  });
  readonly currentDefaultProviderLabel = computed(() => this.getProviderLabel(this.ttsSettings()?.provider ?? 'piper'));

  private lastLoadedChannelID = '';

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();

      if (resolution.status === 'idle') {
        this.resetPageState(this.t('modules.tts.errors.channelNotResolved'));
        return;
      }

      if (resolution.status === 'loading') {
        this.ttsLoading.set(true);
        return;
      }

      if (!resolution.channelID) {
        this.resetPageState(this.t('modules.tts.errors.channelNotResolved'));
        return;
      }

      if (this.lastLoadedChannelID === resolution.channelID) {
        return;
      }

      this.lastLoadedChannelID = resolution.channelID;
      void this.loadTtsSettings(resolution.channelID);
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  async copySpeechUrl(): Promise<void> {
    const url = this.speechApiUrl();
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      this.urlCopied.set(true);
      this.toastService.success(this.t('modules.tts.toasts.copiedTitle'), this.t('modules.tts.toasts.copiedMessage'));
      setTimeout(() => this.urlCopied.set(false), 2000);
    } catch {
      this.toastService.error(this.t('modules.tts.toasts.errorTitle'), this.t('modules.tts.errors.copyFailed'));
    }
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      await this.loadTtsSettings(channelID);
    }
  }

  updateTtsEnabled(enabled: boolean): void {
    this.patchTtsSettings((settings) => ({ ...settings, enabled }));
  }

  updateTtsDefaultLanguage(language: TtsLanguage): void {
    this.patchTtsSettings((settings) => ({ ...settings, defaultLanguage: language }));
  }

  updateTtsProvider(provider: TtsProvider): void {
    this.patchTtsSettings((settings) => ({ ...settings, provider }));
  }

  updateTtsVoice(language: TtsLanguage, voiceValue: string): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      voices: {
        ...settings.voices,
        [language]: voiceValue
      }
    }));
  }

  updateTtsCloneDefault(voiceValue: string): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      voices: {
        ...settings.voices,
        cloneDefault: voiceValue
      }
    }));
  }

  updateTtsFilter(filter: TtsFilterKey, enabled: boolean): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        [filter]: enabled
      }
    }));
  }

  updateTtsMaxLength(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const parsed = Number.parseInt(target.value || '', 10);
    const maxLength = Number.isFinite(parsed) ? Math.max(30, Math.min(500, parsed)) : 280;

    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        maxLength
      }
    }));
  }

  updateQueueMaxItems(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const parsed = Number.parseInt(target.value || '', 10);
    const maxItems = Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : 5;

    this.patchTtsSettings((settings) => ({
      ...settings,
      queue: {
        ...settings.queue,
        maxItems
      }
    }));
  }

  getCurrentPlanLabel(): string {
    const planTier = this.session()?.appUser.plan_tier;
    return planTier === 'pro'
      ? this.t('navbar.planPro')
      : planTier === 'premium'
        ? this.t('navbar.planPremium')
        : this.t('navbar.planFree');
  }

  async saveTtsSettings(): Promise<void> {
    const channelID = this.channelID();
    const settings = this.ttsSettings();

    if (!channelID || !settings || this.ttsReadOnly() || this.ttsSaving() || !this.ttsDirty()) {
      return;
    }

    this.ttsSaving.set(true);
    this.ttsErrorMessage.set(null);

    try {
      const response = await firstValueFrom(this.ttsSettingsApi.updateSettings(channelID, settings));
      const normalized = this.normalizeTtsSettings(response.settings);
      this.ttsRole.set(response.role);
      this.ttsSettings.set(normalized);
      this.initialTtsSettings.set(this.cloneTtsSettings(normalized));

      this.toastService.success(this.t('modules.tts.toasts.savedTitle'), this.t('modules.tts.toasts.savedMessage'));
    } catch (error) {
      console.error('Failed to save TTS settings:', {
        channelID,
        settings,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      const message = error instanceof Error ? error.message : this.t('modules.tts.errors.saveFailed');
      this.ttsErrorMessage.set(message);
      this.toastService.error(this.t('modules.tts.toasts.errorTitle'), message);
    } finally {
      this.ttsSaving.set(false);
    }
  }

  private async loadTtsSettings(channelID: string): Promise<void> {
    this.ttsLoading.set(true);
    this.ttsErrorMessage.set(null);

    try {
      const response = await firstValueFrom(this.ttsSettingsApi.getSettings(channelID));
      this.ttsRole.set(response.role);
      const settings = this.normalizeTtsSettings(response.settings);
      this.ttsSettings.set(settings);
      this.initialTtsSettings.set(this.deepCloneSettings(settings));
    } catch (error) {
      console.error('Failed to load TTS settings:', {
        channelID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      this.ttsRole.set('none');
      this.ttsSettings.set(null);
      this.initialTtsSettings.set(null);
      this.ttsErrorMessage.set(error instanceof Error ? error.message : this.t('modules.tts.errors.loadFailed'));
    } finally {
      this.ttsLoading.set(false);
    }
  }

  private patchTtsSettings(updater: (settings: TtsSettings) => TtsSettings): void {
    if (this.ttsReadOnly() || this.ttsSaving()) {
      return;
    }

    this.ttsSettings.update((settings) => (settings ? updater(settings) : settings));
  }

  private resetPageState(message: string): void {
    this.ttsLoading.set(false);
    this.ttsErrorMessage.set(message);
    this.ttsSettings.set(null);
    this.initialTtsSettings.set(null);
    this.lastLoadedChannelID = '';
  }

  private getProviderLabel(provider: TtsProvider): string {
    return provider === 'fish'
      ? this.t('modules.tts.fields.providerFish')
      : this.t('modules.tts.fields.providerPiper');
  }

  private normalizeTtsSettings(settings: TtsSettings): TtsSettings {
    const defaults = this.createDefaultTtsSettings(settings.channelID, settings.channel);
    const provider: TtsProvider = settings.provider === 'fish' ? 'fish' : 'piper';

    return {
      ...defaults,
      ...settings,
      provider,
      defaultLanguage: settings.defaultLanguage === 'en' ? 'en' : 'es',
      voices: {
        en: settings.voices.en?.trim() || defaults.voices.en,
        es: settings.voices.es?.trim() || defaults.voices.es,
        cloneDefault: settings.voices.cloneDefault ?? defaults.voices.cloneDefault ?? 'gojo'
      },
      filters: {
        skipEmotes: settings.filters.skipEmotes ?? defaults.filters.skipEmotes,
        stripLinks: settings.filters.stripLinks ?? defaults.filters.stripLinks,
        normalizeWhitespace: settings.filters.normalizeWhitespace ?? defaults.filters.normalizeWhitespace,
        maxLength: Number.isFinite(settings.filters.maxLength) ? Math.max(30, Math.min(500, settings.filters.maxLength)) : 280
      },
      queue: {
        maxItems: Number.isFinite(settings.queue.maxItems) ? Math.max(1, Math.min(20, settings.queue.maxItems)) : 5
      }
    };
  }

  private createDefaultTtsSettings(channelID: string, channel: string): TtsSettings {
    return {
      channelID,
      channel,
      enabled: true,
      provider: 'piper',
      defaultLanguage: 'es',
      voices: {
        en: DEFAULT_PIPER_EN_VOICE,
        es: DEFAULT_PIPER_ES_VOICE,
        cloneDefault: 'gojo'
      },
      filters: {
        skipEmotes: true,
        stripLinks: true,
        normalizeWhitespace: true,
        maxLength: 280
      },
      queue: {
        maxItems: 5
      }
    };
  }

  private deepCloneSettings(settings: TtsSettings): TtsSettings {
    return {
      ...settings,
      voices: { ...settings.voices },
      filters: { ...settings.filters },
      queue: { ...settings.queue }
    };
  }

  private cloneTtsSettings(settings: TtsSettings): TtsSettings {
    return this.deepCloneSettings(this.normalizeTtsSettings(settings));
  }

  private serializeTtsSettings(settings: TtsSettings | null): string {
    return settings ? JSON.stringify(settings) : '';
  }
}
