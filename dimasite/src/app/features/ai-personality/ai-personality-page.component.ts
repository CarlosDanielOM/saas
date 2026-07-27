import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import {
  AiKnownUser,
  AiLearningConfig,
  AiMemoryPolicy,
  AiPersonalityProfile,
  AiPersonalitySettings,
  AiPersonalityTierInfo,
  AiVoiceProfile,
  PersonaMode,
  TonePreset,
  UpdateAiPersonalityRequest
} from '../../models/ai-personality.model';
import { AiPersonalityApiService } from '../../services/ai-personality-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-ai-personality-page',
  imports: [RouterLink],
  templateUrl: './ai-personality-page.component.html',
  styleUrl: './ai-personality-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AiPersonalityPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly aiPersonalityApi = inject(AiPersonalityApiService);

  readonly settings = signal<AiPersonalitySettings | null>(null);
  readonly learningExpanded = signal(true);
  readonly initialSettings = signal<AiPersonalitySettings | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly personaModes: Array<{ value: PersonaMode; labelKey: string }> = [
    { value: 'original', labelKey: 'modules.aiPersonality.personaModes.original' },
    { value: 'inspired', labelKey: 'modules.aiPersonality.personaModes.inspired' },
    { value: 'strict_roleplay', labelKey: 'modules.aiPersonality.personaModes.strictRoleplay' }
  ];

  readonly tonePresets: Array<{ value: TonePreset; labelKey: string }> = [
    { value: 'family_friendly', labelKey: 'modules.aiPersonality.tonePresets.familyFriendly' },
    { value: 'balanced', labelKey: 'modules.aiPersonality.tonePresets.balanced' },
    { value: 'dark_humor', labelKey: 'modules.aiPersonality.tonePresets.darkHumor' }
  ];

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
    return streamer ? (['/', streamer, 'modules'] as const) : (['/'] as const);
  });
  readonly planTier = computed(() => {
    const t = this.tier();
    if (t.isPremiumPlus) return 'pro' as const;
    if (t.isPremium) return 'premium' as const;
    return 'free' as const;
  });
  readonly tier = computed(() => this.settings()?.tier ?? this.getFallbackTier());
  readonly isAiEnabled = computed(() => this.settings()?.enabled !== false);
  readonly activeProfile = computed(() => {
    const settings = this.settings();
    if (!settings?.profiles.length) {
      return null;
    }

    return (
      settings.profiles.find((profile) => profile.profileID === settings.activeProfileId) ||
      settings.profiles[0] ||
      null
    );
  });
  readonly hasSettings = computed(() => this.settings() !== null);
  readonly profileCount = computed(() => this.settings()?.profiles.length ?? 0);
  readonly profileLimitReached = computed(() => this.profileCount() >= this.tier().limits.profiles);
  readonly rulesLimitReached = computed(() => {
    const limit = this.tier().limits.rules;
    return typeof limit === 'number' ? (this.settings()?.rules.length ?? 0) >= limit : false;
  });
  readonly knownUsersLimitReached = computed(() => {
    const limit = this.tier().limits.knownUsers;
    return typeof limit === 'number' ? (this.settings()?.knownUsers.length ?? 0) >= limit : false;
  });
  readonly dirty = computed(
    () => this.serializeSettings(this.settings()) !== this.serializeSettings(this.initialSettings())
  );

  private lastLoadedKey = '';

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();

      if (resolution.status === 'idle') {
        this.loading.set(false);
        this.errorMessage.set(this.t('modules.aiPersonality.errors.channelNotResolved'));
        this.settings.set(null);
        this.initialSettings.set(null);
        this.lastLoadedKey = '';
        return;
      }

      if (resolution.status === 'loading') {
        this.loading.set(true);
        return;
      }

      if (!resolution.channelID) {
        this.loading.set(false);
        this.errorMessage.set(this.t('modules.aiPersonality.errors.channelNotResolved'));
        this.settings.set(null);
        this.initialSettings.set(null);
        this.lastLoadedKey = '';
        return;
      }

      if (this.lastLoadedKey === resolution.channelID) {
        return;
      }

      this.lastLoadedKey = resolution.channelID;
      void this.loadSettings(resolution.channelID);
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  limitLabel(value: number | string): string {
    return typeof value === 'number' ? String(value) : this.t('modules.aiPersonality.unlimited');
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      await this.loadSettings(channelID);
    }
  }

  toggleLearning(): void {
    this.learningExpanded.update((expanded) => !expanded);
  }

  selectProfile(profileID: string): void {
    this.settings.update((settings) => (settings ? { ...settings, activeProfileId: profileID } : settings));
  }

  addProfile(): void {
    const settings = this.settings();
    if (!settings || this.profileLimitReached()) {
      return;
    }

    const profile = this.createProfile(settings.profiles.length + 1);
    this.settings.set({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.profileID
    });
  }

  removeProfile(profileID: string): void {
    const settings = this.settings();
    if (!settings || settings.profiles.length <= 1) {
      return;
    }

    const profiles = settings.profiles.filter((profile) => profile.profileID !== profileID);
    const activeProfileId =
      settings.activeProfileId === profileID ? (profiles[0]?.profileID ?? '') : settings.activeProfileId;

    this.settings.set({
      ...settings,
      profiles,
      activeProfileId
    });
  }

  updateActiveProfileField(field: keyof AiPersonalityProfile, value: string): void {
    this.patchActiveProfile((profile) => ({ ...profile, [field]: value }));
  }

  updateActivePersonaMode(value: PersonaMode): void {
    this.patchActiveProfile((profile) => ({ ...profile, personaMode: value }));
  }

  updateActiveTonePreset(value: TonePreset): void {
    this.patchActiveProfile((profile) => ({ ...profile, tonePreset: value }));
  }

  updateActiveVoiceField(field: keyof AiVoiceProfile, value: string): void {
    this.patchActiveProfile((profile) => ({
      ...profile,
      voiceProfile: {
        ...profile.voiceProfile,
        [field]: value
      }
    }));
  }

  addCatchphrase(): void {
    this.patchActiveProfile((profile) => ({
      ...profile,
      voiceProfile: {
        ...profile.voiceProfile,
        catchphrases: [...profile.voiceProfile.catchphrases, '']
      }
    }));
  }

  updateCatchphrase(index: number, value: string): void {
    this.patchActiveProfile((profile) => ({
      ...profile,
      voiceProfile: {
        ...profile.voiceProfile,
        catchphrases: profile.voiceProfile.catchphrases.map((entry, entryIndex) =>
          entryIndex === index ? value : entry
        )
      }
    }));
  }

  removeCatchphrase(index: number): void {
    this.patchActiveProfile((profile) => ({
      ...profile,
      voiceProfile: {
        ...profile.voiceProfile,
        catchphrases: profile.voiceProfile.catchphrases.filter((_, entryIndex) => entryIndex !== index)
      }
    }));
  }

  addRule(): void {
    const settings = this.settings();
    if (settings && !this.rulesLimitReached()) {
      this.settings.set({ ...settings, rules: [...settings.rules, ''] });
    }
  }

  updateRule(index: number, value: string): void {
    const settings = this.settings();
    if (settings) {
      this.settings.set({
        ...settings,
        rules: settings.rules.map((rule, ruleIndex) => (ruleIndex === index ? value : rule))
      });
    }
  }

  removeRule(index: number): void {
    const settings = this.settings();
    if (!settings || settings.rules.length <= 1) {
      return;
    }

    this.settings.set({
      ...settings,
      rules: settings.rules.filter((_, ruleIndex) => ruleIndex !== index)
    });
  }

  addKnownUser(): void {
    const settings = this.settings();
    if (settings && !this.knownUsersLimitReached()) {
      this.settings.set({
        ...settings,
        knownUsers: [...settings.knownUsers, this.createKnownUser()]
      });
    }
  }

  updateKnownUserField(index: number, field: keyof AiKnownUser, value: string): void {
    const settings = this.settings();
    if (settings) {
      this.settings.set({
        ...settings,
        knownUsers: settings.knownUsers.map((knownUser, knownUserIndex) =>
          knownUserIndex === index ? { ...knownUser, [field]: value } : knownUser
        )
      });
    }
  }

  removeKnownUser(index: number): void {
    const settings = this.settings();
    if (settings) {
      this.settings.set({
        ...settings,
        knownUsers: settings.knownUsers.filter((_, knownUserIndex) => knownUserIndex !== index)
      });
    }
  }

  updateEnabled(enabled: boolean): void {
    this.patchSettings((settings) => ({ ...settings, enabled }));
  }

  updateFeatureToggle(field: 'streamSummariesEnabled' | 'recommendationsEnabled', checked: boolean): void {
    this.patchSettings((settings) => ({
      ...settings,
      [field]: checked
    }));
  }

  updateLearningToggle(field: keyof AiLearningConfig, checked: boolean): void {
    this.patchSettings((settings) => ({
      ...settings,
      learningConfig: {
        ...settings.learningConfig,
        [field]: checked
      }
    }));
  }

  updateLearningNumber(field: keyof AiLearningConfig, value: string): void {
    this.patchSettings((settings) => {
      const currentValue = settings.learningConfig[field];
      const parsed = Number.parseFloat(value);

      return {
        ...settings,
        learningConfig: {
          ...settings.learningConfig,
          [field]: Number.isFinite(parsed) ? parsed : currentValue
        }
      };
    });
  }

  updateMemoryPolicy(field: keyof AiMemoryPolicy, checked: boolean): void {
    this.patchSettings((settings) => ({
      ...settings,
      memoryPolicy: {
        ...settings.memoryPolicy,
        [field]: checked
      }
    }));
  }

  async saveSettings(): Promise<void> {
    const channelID = this.channelID();
    const settings = this.settings();
    const activeProfile = this.activeProfile();

    if (!channelID || !settings || !activeProfile || this.saving() || !this.dirty()) {
      return;
    }

    this.saving.set(true);
    this.errorMessage.set(null);

    try {
      const payload: UpdateAiPersonalityRequest = {
        enabled: settings.enabled,
        streamSummariesEnabled: settings.streamSummariesEnabled,
        recommendationsEnabled: settings.recommendationsEnabled,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          name: profile.name.trim(),
          personality: profile.personality.trim(),
          personaReference: profile.personaReference.trim(),
          voiceProfile: {
            tone: profile.voiceProfile.tone.trim(),
            cadence: profile.voiceProfile.cadence.trim(),
            style: profile.voiceProfile.style.trim(),
            catchphrases: profile.voiceProfile.catchphrases.map((entry) => entry.trim()).filter(Boolean)
          }
        })),
        activeProfileId: settings.activeProfileId,
        personality: activeProfile.personality.trim(),
        personaMode: activeProfile.personaMode,
        personaReference: activeProfile.personaReference.trim(),
        tonePreset: activeProfile.tonePreset,
        voiceProfile: {
          tone: activeProfile.voiceProfile.tone.trim(),
          cadence: activeProfile.voiceProfile.cadence.trim(),
          style: activeProfile.voiceProfile.style.trim(),
          catchphrases: activeProfile.voiceProfile.catchphrases.map((entry) => entry.trim()).filter(Boolean)
        },
        learningConfig: {
          ...settings.learningConfig
        },
        memoryPolicy: {
          ...settings.memoryPolicy
        },
        rules: settings.rules.map((rule) => rule.trim()).filter(Boolean),
        knownUsers: settings.knownUsers
          .map((knownUser) => ({
            ...knownUser,
            username: knownUser.username.trim(),
            description: knownUser.description.trim(),
            relationship: knownUser.relationship.trim()
          }))
          .filter((knownUser) => Boolean(knownUser.username))
      };

      const response = await firstValueFrom(this.aiPersonalityApi.updateSettings(channelID, payload));
      const normalized = this.normalizeSettings(response);
      this.settings.set(normalized);
      this.initialSettings.set(this.cloneSettings(normalized));

      this.toastService.success(
        this.t('modules.aiPersonality.toasts.savedTitle'),
        this.t('modules.aiPersonality.toasts.savedMessage')
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : this.t('modules.aiPersonality.errors.saveFailed');
      this.errorMessage.set(message);
      this.toastService.error(this.t('modules.aiPersonality.toasts.errorTitle'), message);
    } finally {
      this.saving.set(false);
    }
  }

  private async loadSettings(channelID: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.aiPersonalityApi.getSettings(channelID));
      const normalized = this.normalizeSettings(response);
      this.settings.set(normalized);
      this.initialSettings.set(this.cloneSettings(normalized));
    } catch (error) {
      this.settings.set(null);
      this.initialSettings.set(null);
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('modules.aiPersonality.errors.loadFailed')
      );
    } finally {
      this.loading.set(false);
    }
  }

  private patchActiveProfile(updater: (profile: AiPersonalityProfile) => AiPersonalityProfile): void {
    const settings = this.settings();
    const activeProfile = this.activeProfile();

    if (!settings || !activeProfile) {
      return;
    }

    this.settings.set({
      ...settings,
      profiles: settings.profiles.map((profile) =>
        profile.profileID === activeProfile.profileID ? updater(profile) : profile
      )
    });
  }

  private normalizeSettings(settings: AiPersonalitySettings): AiPersonalitySettings {
    const profiles =
      Array.isArray(settings.profiles) && settings.profiles.length
        ? settings.profiles.map((profile) => this.normalizeProfile(profile))
        : [this.createProfile(1)];
    const activeProfileId =
      profiles.find((profile) => profile.profileID === settings.activeProfileId)?.profileID ||
      profiles[0].profileID;
    const activeProfile = profiles.find((profile) => profile.profileID === activeProfileId) || profiles[0];

    return {
      ...settings,
      channel: settings.channel || this.streamer() || '',
      enabled: settings.enabled ?? true,
      streamSummariesEnabled: settings.streamSummariesEnabled ?? true,
      recommendationsEnabled: settings.recommendationsEnabled ?? true,
      profiles,
      activeProfileId,
      personality: activeProfile.personality,
      personaMode: activeProfile.personaMode,
      personaReference: activeProfile.personaReference,
      tonePreset: activeProfile.tonePreset,
      voiceProfile: { ...activeProfile.voiceProfile },
      learningConfig: this.normalizeLearningConfig(settings.learningConfig),
      memoryPolicy: this.normalizeMemoryPolicy(settings.memoryPolicy),
      rules: Array.isArray(settings.rules) && settings.rules.length ? [...settings.rules] : [''],
      knownUsers: Array.isArray(settings.knownUsers) ? settings.knownUsers.map((entry) => ({ ...entry })) : [],
      tier: settings.tier ?? this.getFallbackTier()
    };
  }

  private normalizeProfile(profile: AiPersonalityProfile): AiPersonalityProfile {
    return {
      ...profile,
      profileID: profile.profileID || crypto.randomUUID(),
      name: profile.name || this.t('modules.aiPersonality.defaults.profileName'),
      personality: profile.personality || '',
      personaMode: profile.personaMode || 'original',
      personaReference: profile.personaReference || '',
      tonePreset: profile.tonePreset || 'balanced',
      voiceProfile: {
        tone: profile.voiceProfile?.tone || this.t('modules.aiPersonality.defaults.voiceTone'),
        cadence: profile.voiceProfile?.cadence || this.t('modules.aiPersonality.defaults.voiceCadence'),
        style: profile.voiceProfile?.style || this.t('modules.aiPersonality.defaults.voiceStyle'),
        catchphrases: Array.isArray(profile.voiceProfile?.catchphrases)
          ? [...profile.voiceProfile.catchphrases]
          : []
      }
    };
  }

  private createProfile(index: number): AiPersonalityProfile {
    return {
      profileID: crypto.randomUUID(),
      name: `${this.t('modules.aiPersonality.defaults.profileName')} ${index}`,
      personality: '',
      personaMode: 'original',
      personaReference: '',
      tonePreset: 'balanced',
      voiceProfile: {
        tone: this.t('modules.aiPersonality.defaults.voiceTone'),
        cadence: this.t('modules.aiPersonality.defaults.voiceCadence'),
        style: this.t('modules.aiPersonality.defaults.voiceStyle'),
        catchphrases: []
      }
    };
  }

  private createKnownUser(): AiKnownUser {
    return { username: '', description: '', relationship: '' };
  }

  private normalizeLearningConfig(learningConfig?: Partial<AiLearningConfig> | null): AiLearningConfig {
    return {
      enabled: learningConfig?.enabled ?? true,
      autoConfirmEnabled: learningConfig?.autoConfirmEnabled ?? true,
      autoConfirmThreshold: learningConfig?.autoConfirmThreshold ?? 0.82,
      minMessageLength: learningConfig?.minMessageLength ?? 12,
      maxPendingMemories: learningConfig?.maxPendingMemories ?? 250,
      maxConfirmedMemories: learningConfig?.maxConfirmedMemories ?? 2000,
      postStreamSummaryEnabled: learningConfig?.postStreamSummaryEnabled ?? true,
      weeklyMaintenanceEnabled: learningConfig?.weeklyMaintenanceEnabled ?? true,
      monthlyMaintenanceEnabled: learningConfig?.monthlyMaintenanceEnabled ?? true,
      autoApplyCreates: learningConfig?.autoApplyCreates ?? true,
      autoApplyEdits: learningConfig?.autoApplyEdits ?? true,
      autoApplyArchives: learningConfig?.autoApplyArchives ?? true,
      autoApplyPermanentDeletes: learningConfig?.autoApplyPermanentDeletes ?? true,
      summaryMinDurationMinutes: learningConfig?.summaryMinDurationMinutes ?? 20,
      summaryMinChatMessages: learningConfig?.summaryMinChatMessages ?? 30,
      createMinConfidence: learningConfig?.createMinConfidence ?? 0.72,
      editMinConfidence: learningConfig?.editMinConfidence ?? 0.74,
      archiveMinConfidence: learningConfig?.archiveMinConfidence ?? 0.8,
      deleteMinConfidence: learningConfig?.deleteMinConfidence ?? 0.88,
      maxActionsPerRun: learningConfig?.maxActionsPerRun ?? 20,
      maxDeletesPerRun: learningConfig?.maxDeletesPerRun ?? 5,
      minMemoryAgeDaysForDelete: learningConfig?.minMemoryAgeDaysForDelete ?? 30,
      minUnusedDaysForDelete: learningConfig?.minUnusedDaysForDelete ?? 21
    };
  }

  private normalizeMemoryPolicy(memoryPolicy?: Partial<AiMemoryPolicy> | null): AiMemoryPolicy {
    return {
      prioritizeRecentChat: memoryPolicy?.prioritizeRecentChat ?? true,
      allowSensitiveMemories: memoryPolicy?.allowSensitiveMemories ?? false,
      allowUserPreferenceMemories: memoryPolicy?.allowUserPreferenceMemories ?? true,
      allowRunningJokes: memoryPolicy?.allowRunningJokes ?? true
    };
  }

  private patchSettings(updater: (settings: AiPersonalitySettings) => AiPersonalitySettings): void {
    this.settings.update((settings) => (settings ? updater(settings) : settings));
  }

  private cloneSettings(settings: AiPersonalitySettings | null): AiPersonalitySettings | null {
    return settings ? JSON.parse(JSON.stringify(settings)) : null;
  }

  private serializeSettings(settings: AiPersonalitySettings | null): string {
    return JSON.stringify(settings);
  }

  private getFallbackTier(): AiPersonalityTierInfo {
    const planTier = this.sessionAuth.session()?.appUser.plan_tier ?? 'free';

    if (planTier === 'pro') {
      return {
        isPremiumPlus: true,
        isPremium: false,
        limits: { profiles: 3, rules: 'unlimited', knownUsers: 'unlimited', contextWindow: 35 }
      };
    }

    if (planTier === 'premium') {
      return {
        isPremiumPlus: false,
        isPremium: true,
        limits: { profiles: 2, rules: 5, knownUsers: 10, contextWindow: 15 }
      };
    }

    return {
      isPremiumPlus: false,
      isPremium: false,
      limits: { profiles: 1, rules: 3, knownUsers: 3, contextWindow: 7 }
    };
  }
}
