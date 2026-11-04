import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import type { PetOverlayToken, PetOwnerRuntime } from './pet-runtime.model';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, firstValueFrom, map, of, switchMap, timeout } from 'rxjs';
import { PetAskLane, PetConfiguration, PetProvider, PetSettings } from '../../models/pet-settings.model';
import { PET_MOODS, defaultPetMoods, normalizePetMoodsSettings, type PetMood8, type PetMoods } from '../../models/pet-moods.model';
import { EXPRESSIVE_TTS_TAG_GROUPS } from '../../models/tts-settings.model';
import type { FishVoiceFavorite } from '../../models/tts-settings.model';
import { PetSettingsApiService } from '../../services/pet-settings-api.service';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import { AssetPreviewComponent } from '../../shared/asset-library/asset-preview.component';
import { DesignAsset } from '../../shared/asset-library/asset-library.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

type PetSection = 'pet-setup' | 'pet-look' | 'pet-moods' | 'pet-speech' | 'pet-voice' | 'pet-personality' | 'pet-behavior';
export interface PetStep { key: 'obs' | 'look' | 'speech' | 'on'; done: boolean; target: PetSection }
export interface PetProblem { key: string; target: PetSection }

@Component({
  selector: 'app-pet-page',
  imports: [ReactiveFormsModule, RouterLink, NgTemplateOutlet, LfIconComponent, AssetLibraryDialogComponent, AssetPreviewComponent],
  templateUrl: './pet-page.component.html',
  styleUrl: './pet-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PetPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(SessionAuthService);
  private readonly api = inject(PetSettingsApiService);
  private readonly ttsApi = inject(TtsSettingsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private disposed = false;
  private readonly fb = inject(FormBuilder).nonNullable;
  readonly config = signal<PetConfiguration | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);
  readonly fishFavorites = signal<FishVoiceFavorite[]>([]);
  readonly favoritesLoading = signal(false);
  readonly favoritesError = signal(false);
  readonly recoveryUrl = this.fb.control('');
  readonly pickingAsset = signal<'idle' | 'talking' | null>(null);
  readonly pickingMoodAsset = signal<{ mood: PetMood8; state: 'idle' | 'talking' } | null>(null);
  readonly moodNames = PET_MOODS;
  readonly moodDraft = signal<PetMoods>(defaultPetMoods());
  readonly moodTier = computed(() => this.auth.getPlanTierForStreamer(this.streamer()));
  readonly moodsAvailable = computed(() => this.moodTier() === 'premium' || this.moodTier() === 'pro');
  readonly moodImageLimit = computed(() => this.moodTier() === 'pro' ? 16 : this.moodTier() === 'premium' ? 8 : 0);
  readonly moodImageCount = computed(() => Object.values(this.moodDraft().images).reduce((n, image) => n + Number(!!image.idleAssetId) + Number(!!image.talkingAssetId), 0));
  readonly unassignedEmotions = computed(() => {
    const assigned = new Set(Object.values(this.moodDraft().emotions).flat());
    return [...EXPRESSIVE_TTS_TAG_GROUPS.emotions, ...EXPRESSIVE_TTS_TAG_GROUPS.sounds].filter(tag => !assigned.has(tag));
  });
  readonly runtime = signal<PetOwnerRuntime | null>(null);
  readonly runtimeLoading = signal(false);
  readonly runtimeError = signal(false);
  readonly token = signal<PetOverlayToken | null>(null);
  readonly tokenLoading = signal(false);
  readonly tokenError = signal('');
  readonly copied = signal(false);
  readonly confirmingRotation = signal(false);
  readonly overlayUrl = computed(() => {
    const token = this.token()?.token;
    return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? `${this.document.location.origin}/pet/${encodeURIComponent(token)}` : '';
  });
  readonly desktopSessions = computed(() => this.runtime()?.sessions ?? []);
  readonly audioSessionMissing = computed(() => !!this.draft().playback.desktopSessionId && !this.desktopSessions().some(s => s.sessionId === this.draft().playback.desktopSessionId));
  readonly vtsSessionMissing = computed(() => !!this.draft().playback.vtsSessionId && !this.desktopSessions().some(s => s.sessionId === this.draft().playback.vtsSessionId));
  readonly appearanceStates = ['idle', 'talking'] as const;
  private readonly initialDraft = signal('');
  readonly providers: PetProvider[] = ['piper', 'kokoro', 'fish'];
  readonly form = this.fb.group({
    enabled: false,
    moodsEnabled: false,
    moodHoldMs: [2000, [Validators.required, Validators.min(0), Validators.max(10000), Validators.pattern(/^\d+$/)]],
    independent: true,
    readTts: false,
    ttsAudio: this.fb.control<'pet' | 'overlay'>('pet'),
    name: ['Dima', [Validators.required, Validators.maxLength(40), Validators.pattern(/\S/)]],
    appearanceKind: this.fb.control<'png' | 'vts'>('png'),
    idleAssetId: this.fb.control<string | null>(null),
    talkingAssetId: this.fb.control<string | null>(null),
    playbackTarget: this.fb.control<'browser' | 'desktop'>('browser'),
    desktopSessionId: this.fb.control<string | null>(null),
    vtsSessionId: this.fb.control<string | null>(null),
    speechEnabled: true,
    provider: this.fb.control<PetProvider>('piper'),
    language: this.fb.control<'en' | 'es'>('es'),
    voice: ['', Validators.required],
    personalitySource: this.fb.control<'custom' | 'profile'>('custom'),
    profileId: '',
    prompt: ['', Validators.maxLength(4000)],
    rules: ['', Validators.maxLength(6020)],
    respondToChat: true,
    respondToEvents: true,
    cooldownSeconds: [15, [Validators.required, Validators.min(0), Validators.max(3600), Validators.pattern(/^\d+$/)]],
    maxReplyLength: [280, [Validators.required, Validators.min(30), Validators.max(500), Validators.pattern(/^\d+$/)]],
    queueSize: [5, [Validators.required, Validators.min(1), Validators.max(10), Validators.pattern(/^\d+$/)]],
    askLane: this.fb.control<PetAskLane>('independent')
  });
  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  readonly streamer = toSignal(this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer') ?? ''), distinctUntilChanged()), { initialValue: '' });
  readonly channelID = toSignal(this.route.paramMap.pipe(
    map(() => getRouteParam(this.route, 'streamer') ?? ''), distinctUntilChanged(),
    switchMap(streamer => this.auth.resolveChannelID(streamer).pipe(catchError(() => of(null))))
  ), { initialValue: null });
  readonly modulePath = computed(() => ['/', this.streamer(), 'modules']);
  readonly personalityPath = computed(() => ['/', this.streamer(), 'modules', 'ai-personality']);
  readonly ttsPath = computed(() => ['/', this.streamer(), 'modules', 'tts']);
  readonly commandsPath = computed(() => ['/', this.streamer(), 'commands']);
  readonly eventsPath = computed(() => ['/', this.streamer(), 'modules', 'chat-events']);
  readonly petFunctions = [
    { code: '$(pet.talk Hello chat!)', hint: 'fnTalk' },
    { code: '$(pet.ask Tell chat a fun fact)', hint: 'fnAsk' }
  ] as const;
  readonly copiedFn = signal('');
  private copiedFnTimer: ReturnType<typeof setTimeout> | undefined;
  readonly draft = computed<PetSettings>(() => {
    this.values();
    const value = this.form.getRawValue();
    return { moods: normalizePetMoodsSettings({ ...this.moodDraft(), enabled: value.moodsEnabled, holdMs: value.moodHoldMs }), enabled: value.enabled, sources: { independent: value.independent, readTts: value.readTts }, ttsAudio: value.ttsAudio, name: value.name.trim(),
      appearance: { kind: value.appearanceKind, idleAssetId: value.idleAssetId, talkingAssetId: value.talkingAssetId },
      playback: { target: value.playbackTarget, desktopSessionId: value.desktopSessionId, vtsSessionId: value.vtsSessionId },
      tts: { enabled: value.speechEnabled, provider: value.provider, language: value.language, voice: value.voice.trim() },
      personality: { source: value.personalitySource, profileId: value.profileId, prompt: value.prompt.trim() },
      rules: value.rules.split('\n').map(rule => rule.trim()).filter(Boolean),
      behavior: { respondToChat: value.respondToChat, respondToEvents: value.respondToEvents,
        cooldownSeconds: Number(value.cooldownSeconds), maxReplyLength: Number(value.maxReplyLength),
        queueSize: Number(value.queueSize), askLane: value.askLane } };
  });
  readonly dirty = computed(() => !!this.config() && JSON.stringify(this.draft()) !== this.initialDraft());
  readonly voices = computed<PetConfiguration['voices']>(() => (this.config()?.voices ?? []).filter(voice => voice.provider === this.draft().tts.provider &&
    (voice.language === this.draft().tts.language || voice.language === 'any')));
  readonly favoriteVoiceOptions = computed<FishVoiceFavorite[]>(() => {
    const seen = new Set(this.voices().map(voice => voice.id.toLowerCase()));
    return this.fishFavorites().filter(favorite => {
      const id = favorite.id.toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  });
  readonly customFishVoice = computed(() => this.draft().tts.provider === 'fish' && !!this.draft().tts.voice &&
    !this.voices().some(voice => voice.id === this.draft().tts.voice) &&
    !this.favoriteVoiceOptions().some(voice => voice.id === this.draft().tts.voice));
  readonly profileValid = computed(() => !this.draft().sources.independent || this.draft().personality.source !== 'profile' ||
    !!this.config()?.profiles.some(profile => profile.id === this.draft().personality.profileId));
  readonly rulesValid = computed(() => {
    this.values();
    const rules = this.draft().rules;
    return this.form.controls.rules.valid && rules.length <= 20 && rules.every(rule => rule.length <= 300);
  });
  /** Everything that blocks saving, in page order, each pointing at the card that fixes it. */
  readonly problems = computed<PetProblem[]>(() => {
    this.values();
    const value = this.draft(), controls = this.form.controls, list: PetProblem[] = [];
    const independent = value.sources.independent, voice = value.tts.voice;
    if (controls.name.invalid) list.push({ key: 'name', target: 'pet-look' });
    if (value.enabled && value.appearance.kind === 'png' && !(value.appearance.idleAssetId && value.appearance.talkingAssetId)) list.push({ key: 'images', target: 'pet-look' });
    if (value.enabled && value.appearance.kind === 'vts' && !value.playback.vtsSessionId) list.push({ key: 'vtsComputer', target: 'pet-look' });
    if (value.enabled && value.playback.target === 'desktop' && !value.playback.desktopSessionId) list.push({ key: 'audioComputer', target: 'pet-setup' });
    if (controls.voice.invalid || independent && (value.tts.provider === 'fish' ? !/^[a-f0-9]{32}$/i.test(voice) : !this.voices().some(item => item.id === voice))) {
      list.push({ key: 'voice', target: independent ? 'pet-voice' : 'pet-speech' });
    }
    if (controls.prompt.invalid || independent && value.personality.source === 'custom' && !value.personality.prompt) list.push({ key: 'prompt', target: 'pet-personality' });
    if (!this.profileValid()) list.push({ key: 'profile', target: 'pet-personality' });
    if (!this.rulesValid()) list.push({ key: 'rules', target: 'pet-personality' });
    if (controls.cooldownSeconds.invalid) list.push({ key: 'cooldown', target: 'pet-behavior' });
    if (controls.queueSize.invalid) list.push({ key: 'queueSize', target: 'pet-behavior' });
    if (controls.maxReplyLength.invalid) list.push({ key: 'maxLength', target: 'pet-behavior' });
    return list;
  });
  // Optional mood errors (hold time) never block otherwise-valid pet settings.
  readonly valid = computed(() => !this.problems().length);
  /** "Is my pet ready for stream?" — the four things it needs, from the current draft. */
  readonly steps = computed<PetStep[]>(() => {
    const value = this.draft(), token = this.token();
    return [
      { key: 'obs', done: !!token?.exists && (value.playback.target !== 'desktop' || !!value.playback.desktopSessionId), target: 'pet-setup' },
      { key: 'look', done: value.appearance.kind === 'png' ? !!(value.appearance.idleAssetId && value.appearance.talkingAssetId) : !!value.playback.vtsSessionId, target: 'pet-look' },
      { key: 'speech', done: value.sources.readTts || value.sources.independent, target: 'pet-speech' },
      { key: 'on', done: value.enabled, target: 'pet-setup' }
    ];
  });
  readonly stepsLeft = computed(() => this.steps().filter(step => !step.done).length);
  readonly petName = computed(() => this.draft().name || this.t('title'));
  readonly statusTitle = computed(() => {
    const left = this.stepsLeft(), name = this.petName();
    if (!left) return this.tp('statusReady', { name });
    if (left === 1 && !this.draft().enabled) return this.tp('statusOff', { name });
    return this.tp(left === 1 ? 'statusLeftOne' : 'statusLeft', { name, count: left });
  });
  readonly statusHint = computed(() => {
    const { readTts, independent } = this.draft().sources;
    if (this.stepsLeft()) return this.t('statusLeftHint');
    return this.t(readTts && independent ? 'statusReadyBoth' : readTts ? 'statusReadyTts' : 'statusReadyOwn');
  });
  /** Problems the server found in the saved settings that the checklist can't see. */
  readonly savedIssues = computed(() => {
    const config = this.config();
    if (!config) return [];
    const saved = config.settings;
    return config.runtime.issues.filter(issue =>
      issue === 'appearance_unavailable' ? saved.appearance?.kind !== 'vts' && !!saved.appearance?.idleAssetId && !!saved.appearance?.talkingAssetId :
      issue === 'vts_unavailable' ? !!saved.playback?.vtsSessionId : false);
  });
  readonly limitsSummary = computed(() => {
    const behavior = this.draft().behavior;
    return this.tp('limitsSummary', { lane: this.t(behavior.askLane === 'tts' ? 'laneShortTts' : 'laneShortOwn'), queue: behavior.queueSize, pause: behavior.cooldownSeconds });
  });
  readonly voiceSummary = computed(() => {
    const tts = this.draft().tts;
    if (!tts.enabled) return this.t('voiceMuted');
    const voice = this.voices().find(item => item.id === tts.voice)?.name ?? this.fishFavorites().find(item => item.id === tts.voice)?.name;
    return voice ? `${this.t(tts.provider)} · ${voice}` : this.t(tts.provider);
  });
  private loadSequence = 0;
  private runtimeSequence = 0;
  private tokenSequence = 0;
  private runtimeOwner = '';
  private tokenOwner = '';
  private favoritesSequence = 0;
  private favoritesOwner = '';

  constructor() {
    effect(() => {
      const channelID = this.channelID();
      untracked(() => {
        if (channelID) {
          void this.load(channelID); void this.refreshRuntime(channelID); void this.loadToken(channelID); void this.loadFavorites(channelID);
        } else {
          this.favoritesSequence++; this.favoritesOwner = '';
          this.fishFavorites.set([]); this.favoritesLoading.set(false); this.favoritesError.set(false);
        }
      });
    });
    this.destroyRef.onDestroy(() => { clearTimeout(this.copiedFnTimer); this.disposed = true; this.loadSequence++; this.favoritesSequence++; });
  }

  t(key: string): string { return this.language.translate(`pet.${key}`); }
  tp(key: string, params: Record<string, string | number>): string { return this.language.translate(`pet.${key}`, params); }

  /** Scroll to the card that fixes something and focus its first control. */
  goTo(target: PetSection): void {
    const section = this.document.getElementById(target) ?? this.document.getElementById('pet-speech');
    if (!section) return;
    const reduce = this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    // Open a folded group that hides the field to fix.
    section.querySelectorAll('details').forEach(details => { if (details.querySelector('[aria-invalid="true"]')) details.open = true; });
    const field = section.querySelector<HTMLElement>('[aria-invalid="true"]') ?? section.querySelector<HTMLElement>('.image-choice--missing button') ??
      section.querySelector<HTMLElement>('input:not([type=hidden]):not(:disabled), select, textarea, button');
    field?.focus({ preventScroll: true });
  }

  async copyFunction(code: string): Promise<void> {
    try {
      const clipboard = this.document.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error('clipboard_unavailable');
      await clipboard.writeText(code);
      this.copiedFn.set(code);
      clearTimeout(this.copiedFnTimer);
      this.copiedFnTimer = setTimeout(() => this.copiedFn.set(''), 2500);
    } catch { this.copiedFn.set(''); }
  }

  moodImagesFor(mood: PetMood8): number {
    return Number(!!this.moodAssetId(mood, 'idle')) + Number(!!this.moodAssetId(mood, 'talking'));
  }

  async loadFavorites(channelID = this.channelID()): Promise<void> {
    if (!channelID || this.disposed || this.favoritesOwner === channelID && this.favoritesLoading()) return;
    if (this.favoritesOwner !== channelID) this.fishFavorites.set([]);
    this.favoritesOwner = channelID;
    const sequence = ++this.favoritesSequence;
    this.favoritesLoading.set(true); this.favoritesError.set(false);
    try {
      const favorites = await firstValueFrom(this.ttsApi.getFavorites(channelID).pipe(
        timeout(10_000), takeUntilDestroyed(this.destroyRef)
      ));
      if (!this.disposed && sequence === this.favoritesSequence && channelID === this.channelID()) this.fishFavorites.set(Array.isArray(favorites) ? favorites : []);
    } catch {
      if (!this.disposed && sequence === this.favoritesSequence && channelID === this.channelID()) this.favoritesError.set(true);
    } finally {
      if (!this.disposed && sequence === this.favoritesSequence && channelID === this.channelID()) this.favoritesLoading.set(false);
    }
  }

  async load(channelID = this.channelID()): Promise<void> {
    if (!channelID) return;
    const sequence = ++this.loadSequence;
    this.loading.set(true); this.error.set(''); this.config.set(null); this.saved.set(false);
    try {
      const configuration = await firstValueFrom(this.api.get(channelID));
      if (this.disposed || sequence !== this.loadSequence || channelID !== this.channelID()) return;
      this.config.set(configuration); this.reset();
    } catch {
      if (sequence === this.loadSequence && channelID === this.channelID()) this.error.set('loadError');
    } finally { if (sequence === this.loadSequence) this.loading.set(false); }
  }

  reset(): void {
    const settings = this.config()?.settings;
    if (!settings) return;
    const moods = normalizePetMoodsSettings(settings.moods);
    this.moodDraft.set(moods);
    this.form.reset({ enabled: settings.enabled, name: settings.name, moodsEnabled: moods.enabled, moodHoldMs: moods.holdMs,
      independent: settings.sources?.independent ?? true, readTts: settings.sources?.readTts ?? false, ttsAudio: settings.ttsAudio ?? 'pet',
      appearanceKind: settings.appearance?.kind ?? 'png', idleAssetId: settings.appearance?.idleAssetId ?? null, talkingAssetId: settings.appearance?.talkingAssetId ?? null,
      playbackTarget: settings.playback?.target ?? 'browser', desktopSessionId: settings.playback?.desktopSessionId ?? null, vtsSessionId: settings.playback?.vtsSessionId ?? null,
      speechEnabled: settings.tts.enabled,
      provider: settings.tts.provider, language: settings.tts.language, voice: settings.tts.voice,
      personalitySource: settings.personality.source, profileId: settings.personality.profileId, prompt: settings.personality.prompt,
      rules: settings.rules.join('\n'), ...settings.behavior,
      queueSize: settings.behavior.queueSize ?? 5, askLane: settings.behavior.askLane ?? 'independent' });
    this.initialDraft.set(JSON.stringify(this.draft()));
    this.error.set('');
  }

  async refreshRuntime(channelID = this.channelID()): Promise<void> {
    if (!channelID || this.runtimeOwner === channelID && this.runtimeLoading()) return;
    if (this.runtimeOwner !== channelID) this.runtime.set(null);
    this.runtimeOwner = channelID;
    const sequence = ++this.runtimeSequence;
    this.runtimeLoading.set(true); this.runtimeError.set(false);
    try { const runtime = await firstValueFrom(this.api.runtime(channelID)); if (!this.disposed && sequence === this.runtimeSequence && channelID === this.channelID()) this.runtime.set(runtime); }
    catch { if (!this.disposed && sequence === this.runtimeSequence && channelID === this.channelID()) this.runtimeError.set(true); }
    finally { if (sequence === this.runtimeSequence) this.runtimeLoading.set(false); }
  }

  async loadToken(channelID = this.channelID()): Promise<void> {
    if (!channelID || this.tokenOwner === channelID && this.tokenLoading()) return;
    this.tokenOwner = channelID;
    const sequence = ++this.tokenSequence;
    this.copied.set(false); this.confirmingRotation.set(false);
    this.tokenLoading.set(true); this.tokenError.set(''); this.token.set(null);
    this.recoveryUrl.reset('');
    try { const token = await firstValueFrom(this.api.overlayToken(channelID)); if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) this.token.set(token); }
    catch { if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) this.tokenError.set('overlayLoadError'); }
    finally { if (sequence === this.tokenSequence) this.tokenLoading.set(false); }
  }

  async issueToken(rotate = false): Promise<void> {
    const channelID = this.channelID(), token = this.token();
    if (!channelID || !token || this.tokenLoading() || rotate && !this.confirmingRotation()) return;
    const sequence = ++this.tokenSequence;
    this.tokenLoading.set(true); this.tokenError.set(''); this.copied.set(false);
    try {
      const result = await firstValueFrom(this.api.issueOverlayToken(channelID, rotate ? { rotate: true, version: token.version } : {}));
      if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) { this.token.set(result); this.confirmingRotation.set(false); }
    } catch { if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) this.tokenError.set('overlaySaveError'); }
    finally { if (sequence === this.tokenSequence) this.tokenLoading.set(false); }
  }

  async recoverOverlayUrl(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || this.tokenLoading() || !this.token()?.exists) return;
    const raw = this.recoveryUrl.value.trim();
    let token = raw;
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) {
      try {
        const url = new URL(raw);
        token = url.origin === this.document.location.origin && !url.search && !url.hash ? url.pathname.split('/pet/')[1] ?? '' : '';
      } catch { token = ''; }
    }
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) { this.tokenError.set('overlayRecoverInvalid'); return; }
    const sequence = ++this.tokenSequence;
    this.tokenLoading.set(true); this.tokenError.set('');
    try {
      const result = await firstValueFrom(this.api.issueOverlayToken(channelID, { token }));
      if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) { this.token.set(result); this.recoveryUrl.reset(''); }
    } catch { if (!this.disposed && sequence === this.tokenSequence && channelID === this.channelID()) this.tokenError.set('overlayRecoverError'); }
    finally { if (sequence === this.tokenSequence) this.tokenLoading.set(false); }
  }

  async copyOverlayUrl(): Promise<void> {
    const url = this.overlayUrl();
    if (!url) return;
    this.copied.set(false); this.tokenError.set('');
    try {
      const clipboard = this.document.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error('clipboard_unavailable');
      await clipboard.writeText(url);
      if (url === this.overlayUrl()) this.copied.set(true);
    }
    catch { this.tokenError.set('copyError'); }
  }

  assetId(state: 'idle' | 'talking'): string | null {
    return state === 'idle' ? this.draft().appearance.idleAssetId : this.draft().appearance.talkingAssetId;
  }

  resetMoodEmotions(): void {
    if (!this.saving()) this.moodDraft.update(moods => ({ ...moods, emotions: defaultPetMoods().emotions }));
  }

  addMoodEmotion(mood: PetMood8, event: Event): void {
    const select = event.target as HTMLSelectElement, tag = select.value;
    if (!this.saving() && this.unassignedEmotions().includes(tag as typeof EXPRESSIVE_TTS_TAG_GROUPS.emotions[number])) {
      this.moodDraft.update(moods => ({ ...moods, emotions: { ...moods.emotions, [mood]: [...moods.emotions[mood], tag] } }));
    }
    select.value = '';
  }

  removeMoodEmotion(mood: PetMood8, tag: string): void {
    if (!this.saving()) this.moodDraft.update(moods => ({ ...moods, emotions: { ...moods.emotions, [mood]: moods.emotions[mood].filter(item => item !== tag) } }));
  }

  moodAssetId(mood: PetMood8, state: 'idle' | 'talking'): string | null {
    return this.moodDraft().images[mood]?.[state === 'idle' ? 'idleAssetId' : 'talkingAssetId'] ?? null;
  }

  moodImageInactive(mood: PetMood8, state: 'idle' | 'talking'): boolean {
    if (!this.moodAssetId(mood, state)) return false;
    let slot = 0;
    for (const name of PET_MOODS) for (const imageState of this.appearanceStates) {
      if (this.moodAssetId(name, imageState)) slot++;
      if (name === mood && imageState === state) return slot > this.moodImageLimit();
    }
    return false;
  }

  chooseMoodAsset(asset: DesignAsset): void {
    const selection = this.pickingMoodAsset();
    if (!selection || this.saving() || asset.kind !== 'image' || !this.moodsAvailable()) return;
    this.moodDraft.update(moods => ({ ...moods, images: { ...moods.images, [selection.mood]: {
      ...moods.images[selection.mood], [selection.state === 'idle' ? 'idleAssetId' : 'talkingAssetId']: asset.id
    } } }));
    this.pickingMoodAsset.set(null);
  }

  removeMoodAsset(mood: PetMood8, state: 'idle' | 'talking'): void {
    if (this.saving()) return;
    this.moodDraft.update(moods => {
      const image = { ...moods.images[mood] };
      delete image[state === 'idle' ? 'idleAssetId' : 'talkingAssetId'];
      return { ...moods, images: { ...moods.images, [mood]: image } };
    });
  }

  chooseAsset(asset: DesignAsset): void {
    const state = this.pickingAsset();
    if (!state || this.saving() || asset.kind !== 'image') return;
    this.form.controls[state === 'idle' ? 'idleAssetId' : 'talkingAssetId'].setValue(asset.id);
    this.pickingAsset.set(null);
  }

  removeAsset(state: 'idle' | 'talking'): void {
    if (!this.saving()) this.form.controls[state === 'idle' ? 'idleAssetId' : 'talkingAssetId'].setValue(null);
  }

  chooseProvider(provider: PetProvider): void {
    this.form.controls.provider.setValue(provider);
    this.ensureVoice();
  }

  ensureVoice(): void {
    // Fish references work in either reply language, even when not in the favorites list.
    if (this.form.controls.provider.value === 'fish' && /^[a-f0-9]{32}$/i.test(this.form.controls.voice.value.trim())) return;
    if (!this.voices().some(voice => voice.id === this.form.controls.voice.value)) {
      this.form.controls.voice.setValue(this.voices()[0]?.id ?? '');
    }
  }

  async save(): Promise<void> {
    const channelID = this.channelID(), config = this.config();
    if (!channelID || !config || !this.dirty() || !this.valid() || this.saving()) return;
    this.saving.set(true); this.error.set(''); this.saved.set(false);
    const settings = this.draft();
    this.form.disable();
    try {
      const result = await firstValueFrom(this.api.save(channelID, config.revision, settings));
      if (this.channelID() !== channelID) return;
      this.config.set(result); this.reset(); this.saved.set(true); void this.refreshRuntime();
    } catch (error) {
      if (this.channelID() !== channelID) return;
      const code = error instanceof HttpErrorResponse ? error.error?.message : '';
      this.error.set(code === 'settings_conflict' ? 'conflict' : code === 'personality_unavailable' ? 'profileMissing' : 'saveError');
    } finally { this.form.enable(); this.saving.set(false); }
  }
}
