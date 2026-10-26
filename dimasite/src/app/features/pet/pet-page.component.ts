import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { PetOverlayToken, PetOwnerRuntime } from './pet-runtime.model';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, firstValueFrom, map, of, switchMap } from 'rxjs';
import { PetAskLane, PetConfiguration, PetProvider, PetSettings } from '../../models/pet-settings.model';
import { PetSettingsApiService } from '../../services/pet-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import { AssetPreviewComponent } from '../../shared/asset-library/asset-preview.component';
import { DesignAsset } from '../../shared/asset-library/asset-library.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

@Component({
  selector: 'app-pet-page',
  imports: [ReactiveFormsModule, RouterLink, LfIconComponent, AssetLibraryDialogComponent, AssetPreviewComponent],
  templateUrl: './pet-page.component.html',
  styleUrl: './pet-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PetPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(SessionAuthService);
  private readonly api = inject(PetSettingsApiService);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private disposed = false;
  private readonly fb = inject(FormBuilder).nonNullable;
  readonly config = signal<PetConfiguration | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);
  readonly recoveryUrl = this.fb.control('');
  readonly pickingAsset = signal<'idle' | 'talking' | null>(null);
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
  readonly draft = computed<PetSettings>(() => {
    this.values();
    const value = this.form.getRawValue();
    return { enabled: value.enabled, sources: { independent: value.independent, readTts: value.readTts }, ttsAudio: value.ttsAudio, name: value.name.trim(),
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
  readonly voices = computed(() => (this.config()?.voices ?? []).filter(voice => voice.provider === this.draft().tts.provider &&
    (voice.language === this.draft().tts.language || voice.language === 'any')));
  readonly customFishVoice = computed(() => this.draft().tts.provider === 'fish' && !this.voices().some(voice => voice.id === this.draft().tts.voice));
  readonly valid = computed(() => {
    const value = this.draft();
    return this.form.valid && (!value.sources.independent || (value.personality.source === 'custom' ? !!value.personality.prompt :
      !!this.config()?.profiles.some(profile => profile.id === value.personality.profileId))) &&
      (!value.enabled || (value.appearance.kind !== 'png' || !!value.appearance.idleAssetId && !!value.appearance.talkingAssetId) &&
        (value.playback.target !== 'desktop' || !!value.playback.desktopSessionId) &&
        (value.appearance.kind !== 'vts' || !!value.playback.vtsSessionId)) &&
      value.rules.length <= 20 && value.rules.every(rule => rule.length <= 300) &&
      (!value.sources.independent || (value.tts.provider === 'fish' ? /^[a-f0-9]{32}$/i.test(value.tts.voice) : this.voices().some(voice => voice.id === value.tts.voice)));
  });
  private loadSequence = 0;
  private runtimeSequence = 0;
  private tokenSequence = 0;
  private runtimeOwner = '';
  private tokenOwner = '';

  constructor() {
    effect(() => { const channelID = this.channelID(); if (channelID) untracked(() => { void this.load(channelID); void this.refreshRuntime(channelID); void this.loadToken(channelID); }); });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.loadSequence++; });
  }

  t(key: string): string { return this.language.translate(`pet.${key}`); }

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
    this.form.reset({ enabled: settings.enabled, name: settings.name,
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
