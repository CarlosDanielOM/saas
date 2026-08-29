import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import {
  type AiTtsProvider,
  type OpenRouterTtsModel,
  type TtsProvider,
  type TtsRole,
  type TtsSettings,
  type XaiExpressiveTagSettings,
  type XaiInlineSpeechTagSettings,
  type XaiWrappingSpeechTagSettings
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
type InlineExpressiveTagKey = keyof XaiInlineSpeechTagSettings;
type WrappingExpressiveTagKey = keyof XaiWrappingSpeechTagSettings;

interface ExpressiveTagCategory<TagKey extends string> {
  categoryKey: string;
  items: Array<{
    key: TagKey;
    tag: string;
  }>;
}

const DEFAULT_PIPER_EN_VOICE = 'en_US-ryan-medium';
const DEFAULT_PIPER_ES_VOICE = 'es_MX-ald-medium';
const DEFAULT_XAI_VOICE = 'eve';
const DEFAULT_OPENROUTER_VOICE = 'alloy';
const DEFAULT_OPENROUTER_MODEL: OpenRouterTtsModel = 'openai/gpt-4o-mini-tts-2025-12-15';

const PIPER_VOICE_OPTIONS: Record<TtsLanguage, VoiceOption[]> = {
  en: [{ value: DEFAULT_PIPER_EN_VOICE, label: 'Ryan - US English' }],
  es: [{ value: DEFAULT_PIPER_ES_VOICE, label: 'Ald - Mexican Spanish' }]
};

const XAI_VOICE_OPTIONS: VoiceOption[] = [
  { value: 'eve', label: 'Eve' },
  { value: 'ara', label: 'Ara' },
  { value: 'rex', label: 'Rex' },
  { value: 'sal', label: 'Sal' },
  { value: 'leo', label: 'Leo' }
];

const OPENROUTER_VOICE_OPTIONS: VoiceOption[] = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' }
];

const OPENROUTER_MODEL_OPTIONS: VoiceOption[] = [
  { value: 'openai/gpt-4o-mini-tts-2025-12-15', label: 'OpenAI 4o Mini TTS' },
  { value: 'hexgrad/kokoro-82m', label: 'Kokoro 82M' }
];

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

  readonly inlineExpressiveTagCategories: ExpressiveTagCategory<InlineExpressiveTagKey>[] = [
    {
      categoryKey: 'modules.tts.expressive.categories.pauses',
      items: [
        { key: 'pause', tag: '[pause]' },
        { key: 'longPause', tag: '[long-pause]' },
        { key: 'humTune', tag: '[hum-tune]' }
      ]
    },
    {
      categoryKey: 'modules.tts.expressive.categories.laughterCry',
      items: [
        { key: 'laugh', tag: '[laugh]' },
        { key: 'chuckle', tag: '[chuckle]' },
        { key: 'giggle', tag: '[giggle]' },
        { key: 'cry', tag: '[cry]' }
      ]
    },
    {
      categoryKey: 'modules.tts.expressive.categories.mouthSounds',
      items: [
        { key: 'tsk', tag: '[tsk]' },
        { key: 'tongueClick', tag: '[tongue-click]' },
        { key: 'lipSmack', tag: '[lip-smack]' }
      ]
    },
    {
      categoryKey: 'modules.tts.expressive.categories.breathing',
      items: [
        { key: 'breath', tag: '[breath]' },
        { key: 'inhale', tag: '[inhale]' },
        { key: 'exhale', tag: '[exhale]' },
        { key: 'sigh', tag: '[sigh]' }
      ]
    }
  ];

  readonly wrappingExpressiveTagCategories: ExpressiveTagCategory<WrappingExpressiveTagKey>[] = [
    {
      categoryKey: 'modules.tts.expressive.categories.volumeIntensity',
      items: [
        { key: 'soft', tag: '<soft>' },
        { key: 'whisper', tag: '<whisper>' },
        { key: 'loud', tag: '<loud>' },
        { key: 'buildIntensity', tag: '<build-intensity>' },
        { key: 'decreaseIntensity', tag: '<decrease-intensity>' }
      ]
    },
    {
      categoryKey: 'modules.tts.expressive.categories.pitchSpeed',
      items: [
        { key: 'higherPitch', tag: '<higher-pitch>' },
        { key: 'lowerPitch', tag: '<lower-pitch>' },
        { key: 'slow', tag: '<slow>' },
        { key: 'fast', tag: '<fast>' }
      ]
    },
    {
      categoryKey: 'modules.tts.expressive.categories.vocalStyle',
      items: [
        { key: 'singSong', tag: '<sing-song>' },
        { key: 'singing', tag: '<singing>' },
        { key: 'laughSpeak', tag: '<laugh-speak>' },
        { key: 'emphasis', tag: '<emphasis>' }
      ]
    }
  ];

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
    { value: 'xai', label: this.t('modules.tts.fields.providerXai') },
    { value: 'openrouter', label: this.t('modules.tts.fields.providerOpenRouter') },
    { value: 'fish', label: this.t('modules.tts.fields.providerFish') }
  ]);

  readonly aiProviderOptions = computed<VoiceOption[]>(() => [
    { value: 'xai', label: this.t('modules.tts.fields.providerXai') },
    { value: 'openrouter', label: this.t('modules.tts.fields.providerOpenRouter') }
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
  readonly selectedAiBaseOptions = computed(() =>
    this.ttsSettings()?.aiProvider === 'openrouter' ? OPENROUTER_VOICE_OPTIONS : XAI_VOICE_OPTIONS
  );
  readonly englishAiVoiceOptions = computed(() =>
    mergeCurrentOption(
      this.selectedAiBaseOptions(),
      this.getDisplayedAiVoice('en'),
      this.t('modules.tts.fields.savedValueOption', { value: this.getDisplayedAiVoice('en') })
    )
  );
  readonly spanishAiVoiceOptions = computed(() =>
    mergeCurrentOption(
      this.selectedAiBaseOptions(),
      this.getDisplayedAiVoice('es'),
      this.t('modules.tts.fields.savedValueOption', { value: this.getDisplayedAiVoice('es') })
    )
  );
  readonly openRouterModelOptions = computed(() =>
    mergeCurrentOption(
      OPENROUTER_MODEL_OPTIONS,
      this.getDisplayedOpenRouterModel(),
      this.t('modules.tts.fields.savedValueOption', { value: this.getDisplayedOpenRouterModel() })
    )
  );
  readonly showOpenRouterModelSettings = computed(() => {
    const settings = this.ttsSettings();
    return settings?.provider === 'openrouter' || settings?.aiProvider === 'openrouter';
  });
  readonly showExpressiveTagsSection = computed(() => true);
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
  readonly expressiveTagsEnabledCount = computed(() => {
    const settings = this.ttsSettings();
    if (!settings) {
      return 0;
    }

    const inlineCount = Object.values(settings.filters.expressiveTags.inline).filter(Boolean).length;
    const wrappingCount = Object.values(settings.filters.expressiveTags.wrapping).filter(Boolean).length;
    return inlineCount + wrappingCount;
  });
  readonly expressiveTagsTotalCount = computed(
    () =>
      this.inlineExpressiveTagCategories.flatMap((category) => category.items).length
      + this.wrappingExpressiveTagCategories.flatMap((category) => category.items).length
  );
  readonly currentDefaultProviderLabel = computed(() => this.getProviderLabel(this.ttsSettings()?.provider ?? 'piper'));
  readonly currentAiProviderLabel = computed(() => this.getAiProviderLabel());

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

  updateTtsAiProvider(provider: AiTtsProvider): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      aiProvider: provider,
      voices: {
        ...settings.voices,
        aiVoices: this.getProviderVoicePair(settings, provider)
      }
    }));
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

  updateTtsAiVoice(language: TtsLanguage, voiceValue: string): void {
    this.patchTtsSettings((settings) => {
      const currentXai = this.getProviderVoicePair(settings, 'xai');
      const currentOpenRouter = this.getProviderVoicePair(settings, 'openrouter');
      const activePair = this.getProviderVoicePair(settings, settings.aiProvider);
      const nextActivePair = { ...activePair, [language]: voiceValue };

      return {
        ...settings,
        voices: {
          ...settings.voices,
          aiVoices: nextActivePair,
          aiVoicesByProvider: {
            xai: settings.aiProvider === 'xai' ? nextActivePair : currentXai,
            openrouter: settings.aiProvider === 'openrouter' ? nextActivePair : currentOpenRouter
          }
        }
      };
    });
  }

  updateOpenRouterModel(model: OpenRouterTtsModel): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      providerSettings: {
        ...settings.providerSettings,
        openrouter: {
          ...settings.providerSettings.openrouter,
          model
        }
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

  updateInlineExpressiveTag(tag: InlineExpressiveTagKey, enabled: boolean): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        expressiveTags: {
          ...settings.filters.expressiveTags,
          inline: {
            ...settings.filters.expressiveTags.inline,
            [tag]: enabled
          }
        }
      }
    }));
  }

  updateWrappingExpressiveTag(tag: WrappingExpressiveTagKey, enabled: boolean): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        expressiveTags: {
          ...settings.filters.expressiveTags,
          wrapping: {
            ...settings.filters.expressiveTags.wrapping,
            [tag]: enabled
          }
        }
      }
    }));
  }

  isInlineExpressiveTagEnabled(tag: InlineExpressiveTagKey): boolean {
    return this.ttsSettings()?.filters.expressiveTags.inline[tag] ?? true;
  }

  isWrappingExpressiveTagEnabled(tag: WrappingExpressiveTagKey): boolean {
    return this.ttsSettings()?.filters.expressiveTags.wrapping[tag] ?? true;
  }

  getDisplayedAiVoice(language: TtsLanguage): string {
    const settings = this.ttsSettings();
    if (!settings) {
      return this.getDefaultAiVoice('xai');
    }

    return this.getProviderVoicePair(settings, settings.aiProvider)[language];
  }

  getDisplayedOpenRouterModel(): OpenRouterTtsModel {
    return this.ttsSettings()?.providerSettings.openrouter.model || DEFAULT_OPENROUTER_MODEL;
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
      // Store server data directly — no normalize on read.
      // Backend normalizes on save, so server response is already canonical.
      // Normalizing on read was replacing saved values with defaults.
      this.ttsRole.set(response.role);
      const settings = response.settings;
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
    if (provider === 'xai') {
      return this.t('modules.tts.fields.providerXai');
    }

    if (provider === 'openrouter') {
      return this.t('modules.tts.fields.providerOpenRouter');
    }

    return provider === 'fish'
      ? this.t('modules.tts.fields.providerFish')
      : this.t('modules.tts.fields.providerPiper');
  }

  private getAiProviderLabel(): string {
    const settings = this.ttsSettings();
    if (!settings) {
      return this.t('modules.tts.fields.providerXai');
    }

    return settings.aiProvider === 'openrouter'
      ? this.t('modules.tts.fields.providerOpenRouter')
      : this.t('modules.tts.fields.providerXai');
  }

  private getDefaultAiVoice(provider: AiTtsProvider): string {
    return provider === 'openrouter' ? DEFAULT_OPENROUTER_VOICE : DEFAULT_XAI_VOICE;
  }

  private getProviderVoicePair(settings: TtsSettings, provider: AiTtsProvider): { en: string; es: string } {
    if (provider === 'openrouter') {
      return {
        en: settings.voices.aiVoicesByProvider?.openrouter?.en || DEFAULT_OPENROUTER_VOICE,
        es: settings.voices.aiVoicesByProvider?.openrouter?.es || DEFAULT_OPENROUTER_VOICE
      };
    }

    return {
      en: settings.voices.aiVoicesByProvider?.xai?.en || settings.voices.aiVoices?.en || DEFAULT_XAI_VOICE,
      es: settings.voices.aiVoicesByProvider?.xai?.es || settings.voices.aiVoices?.es || DEFAULT_XAI_VOICE
    };
  }

  private normalizeTtsSettings(settings: TtsSettings): TtsSettings {
    const defaults = this.createDefaultTtsSettings(settings.channelID, settings.channel);
    const provider: TtsProvider =
      settings.provider === 'xai' || settings.provider === 'openrouter' || settings.provider === 'fish'
        ? settings.provider
        : 'piper';
    const aiProvider: AiTtsProvider = settings.aiProvider === 'openrouter' ? 'openrouter' : 'xai';
    const expressiveDefaults = this.createDefaultExpressiveTagSettings();
    const aiVoicesByProvider = settings.voices.aiVoicesByProvider;
    const sharedAiVoices = settings.voices.aiVoices;

    const xaiVoices = {
      en: aiVoicesByProvider?.xai?.en?.trim() || sharedAiVoices?.en?.trim() || DEFAULT_XAI_VOICE,
      es: aiVoicesByProvider?.xai?.es?.trim() || sharedAiVoices?.es?.trim() || DEFAULT_XAI_VOICE
    };

    const openRouterVoices = {
      en: aiVoicesByProvider?.openrouter?.en?.trim() || DEFAULT_OPENROUTER_VOICE,
      es: aiVoicesByProvider?.openrouter?.es?.trim() || DEFAULT_OPENROUTER_VOICE
    };

    return {
      ...defaults,
      ...settings,
      provider,
      aiProvider,
      defaultLanguage: settings.defaultLanguage === 'en' ? 'en' : 'es',
      voices: {
        en: settings.voices.en?.trim() || defaults.voices.en,
        es: settings.voices.es?.trim() || defaults.voices.es,
        aiDefault: settings.voices.aiDefault ?? defaults.voices.aiDefault,
        aiVoices: aiProvider === 'openrouter' ? { ...openRouterVoices } : { ...xaiVoices },
        aiVoicesByProvider: {
          xai: xaiVoices,
          openrouter: openRouterVoices
        },
        cloneDefault: settings.voices.cloneDefault ?? defaults.voices.cloneDefault ?? 'gojo'
      },
      filters: {
        skipEmotes: settings.filters.skipEmotes ?? defaults.filters.skipEmotes,
        stripLinks: settings.filters.stripLinks ?? defaults.filters.stripLinks,
        normalizeWhitespace: settings.filters.normalizeWhitespace ?? defaults.filters.normalizeWhitespace,
        maxLength: Number.isFinite(settings.filters.maxLength) ? Math.max(30, Math.min(500, settings.filters.maxLength)) : 280,
        expressiveTags: {
          inline: {
            ...expressiveDefaults.inline,
            ...(settings.filters.expressiveTags?.inline ?? {})
          },
          wrapping: {
            ...expressiveDefaults.wrapping,
            ...(settings.filters.expressiveTags?.wrapping ?? {})
          }
        }
      },
      queue: {
        maxItems: Number.isFinite(settings.queue.maxItems) ? Math.max(1, Math.min(20, settings.queue.maxItems)) : 5
      },
      providerSettings: {
        openrouter: {
          model:
            settings.providerSettings?.openrouter?.model === 'hexgrad/kokoro-82m'
              ? 'hexgrad/kokoro-82m'
              : DEFAULT_OPENROUTER_MODEL
        }
      }
    };
  }

  private createDefaultTtsSettings(channelID: string, channel: string): TtsSettings {
    return {
      channelID,
      channel,
      enabled: true,
      provider: 'piper',
      aiProvider: 'xai',
      defaultLanguage: 'es',
      voices: {
        en: DEFAULT_PIPER_EN_VOICE,
        es: DEFAULT_PIPER_ES_VOICE,
        aiDefault: null,
        aiVoices: {
          en: DEFAULT_XAI_VOICE,
          es: DEFAULT_XAI_VOICE
        },
        aiVoicesByProvider: {
          xai: {
            en: DEFAULT_XAI_VOICE,
            es: DEFAULT_XAI_VOICE
          },
          openrouter: {
            en: DEFAULT_OPENROUTER_VOICE,
            es: DEFAULT_OPENROUTER_VOICE
          }
        },
        cloneDefault: 'gojo'
      },
      filters: {
        skipEmotes: true,
        stripLinks: true,
        normalizeWhitespace: true,
        maxLength: 280,
        expressiveTags: this.createDefaultExpressiveTagSettings()
      },
      queue: {
        maxItems: 5
      },
      providerSettings: {
        openrouter: {
          model: DEFAULT_OPENROUTER_MODEL
        }
      }
    };
  }

  private createDefaultExpressiveTagSettings(): XaiExpressiveTagSettings {
    return {
      inline: {
        pause: true,
        longPause: true,
        humTune: true,
        laugh: true,
        chuckle: true,
        giggle: true,
        cry: true,
        tsk: true,
        tongueClick: true,
        lipSmack: true,
        breath: true,
        inhale: true,
        exhale: true,
        sigh: true
      },
      wrapping: {
        soft: true,
        whisper: true,
        loud: true,
        buildIntensity: true,
        decreaseIntensity: true,
        higherPitch: true,
        lowerPitch: true,
        slow: true,
        fast: true,
        singSong: true,
        singing: true,
        laughSpeak: true,
        emphasis: true
      }
    };
  }

  /**
   * Deep-clone without any normalizeTtsSettings call.
   * Used for initialTtsSettings so the dirty comparison is stable
   * regardless of whether normalize was called on load.
   */
  private deepCloneSettings(settings: TtsSettings): TtsSettings {
    return {
      ...settings,
      voices: {
        ...settings.voices,
        aiVoices: settings.voices.aiVoices ? { ...settings.voices.aiVoices } : undefined,
        aiVoicesByProvider: settings.voices.aiVoicesByProvider
          ? {
              xai: { ...settings.voices.aiVoicesByProvider.xai },
              openrouter: { ...settings.voices.aiVoicesByProvider.openrouter }
            }
          : undefined,
        cloneDefault: settings.voices.cloneDefault
      },
      filters: {
        ...settings.filters,
        expressiveTags: {
          inline: { ...settings.filters.expressiveTags.inline },
          wrapping: { ...settings.filters.expressiveTags.wrapping }
        }
      },
      queue: { ...settings.queue },
      providerSettings: {
        openrouter: {
          ...settings.providerSettings.openrouter
        }
      }
    };
  }

  private cloneTtsSettings(settings: TtsSettings): TtsSettings {
    const normalized = this.normalizeTtsSettings(settings);

    return {
      ...normalized,
      voices: {
        ...normalized.voices,
        aiVoices: normalized.voices.aiVoices ? { ...normalized.voices.aiVoices } : undefined,
        aiVoicesByProvider: normalized.voices.aiVoicesByProvider
          ? {
              xai: { ...normalized.voices.aiVoicesByProvider.xai },
              openrouter: { ...normalized.voices.aiVoicesByProvider.openrouter }
            }
          : undefined,
        cloneDefault: normalized.voices.cloneDefault
      },
      filters: {
        ...normalized.filters,
        expressiveTags: {
          inline: { ...normalized.filters.expressiveTags.inline },
          wrapping: { ...normalized.filters.expressiveTags.wrapping }
        }
      },
      queue: { ...normalized.queue },
      providerSettings: {
        openrouter: {
          ...normalized.providerSettings.openrouter
        }
      }
    };
  }

  private serializeTtsSettings(settings: TtsSettings | null): string {
    return settings ? JSON.stringify(settings) : '';
  }
}
