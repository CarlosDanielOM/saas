import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, firstValueFrom, map, of, switchMap } from 'rxjs';
import { PetConfiguration, PetProvider, PetSettings } from '../../models/pet-settings.model';
import { PetSettingsApiService } from '../../services/pet-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

@Component({
  selector: 'app-pet-page',
  imports: [ReactiveFormsModule, RouterLink, LfIconComponent],
  templateUrl: './pet-page.component.html',
  styleUrl: './pet-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PetPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(SessionAuthService);
  private readonly api = inject(PetSettingsApiService);
  private readonly language = inject(LanguageService);
  private readonly fb = inject(FormBuilder).nonNullable;
  readonly config = signal<PetConfiguration | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);
  private readonly initialDraft = signal('');
  readonly providers: PetProvider[] = ['piper', 'kokoro', 'fish'];
  readonly form = this.fb.group({
    enabled: false,
    name: ['Dima', [Validators.required, Validators.maxLength(40), Validators.pattern(/\S/)]],
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
    maxReplyLength: [280, [Validators.required, Validators.min(30), Validators.max(500), Validators.pattern(/^\d+$/)]]
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
    return { enabled: value.enabled, name: value.name.trim(),
      tts: { enabled: value.speechEnabled, provider: value.provider, language: value.language, voice: value.voice.trim() },
      personality: { source: value.personalitySource, profileId: value.profileId, prompt: value.prompt.trim() },
      rules: value.rules.split('\n').map(rule => rule.trim()).filter(Boolean),
      behavior: { respondToChat: value.respondToChat, respondToEvents: value.respondToEvents,
        cooldownSeconds: Number(value.cooldownSeconds), maxReplyLength: Number(value.maxReplyLength) } };
  });
  readonly dirty = computed(() => !!this.config() && JSON.stringify(this.draft()) !== this.initialDraft());
  readonly voices = computed(() => (this.config()?.voices ?? []).filter(voice => voice.provider === this.draft().tts.provider &&
    (voice.language === this.draft().tts.language || voice.language === 'any')));
  readonly customFishVoice = computed(() => this.draft().tts.provider === 'fish' && !this.voices().some(voice => voice.id === this.draft().tts.voice));
  readonly valid = computed(() => {
    const value = this.draft();
    return this.form.valid && (value.personality.source === 'custom' ? !!value.personality.prompt :
      !!this.config()?.profiles.some(profile => profile.id === value.personality.profileId)) &&
      value.rules.length <= 20 && value.rules.every(rule => rule.length <= 300) &&
      (value.tts.provider === 'fish' ? /^[a-f0-9]{32}$/i.test(value.tts.voice) : this.voices().some(voice => voice.id === value.tts.voice));
  });
  private loadSequence = 0;

  constructor() {
    effect(() => { const channelID = this.channelID(); if (channelID) void this.load(channelID); });
  }

  t(key: string): string { return this.language.translate(`pet.${key}`); }

  async load(channelID = this.channelID()): Promise<void> {
    if (!channelID) return;
    const sequence = ++this.loadSequence;
    this.loading.set(true); this.error.set(''); this.config.set(null); this.saved.set(false);
    try {
      const configuration = await firstValueFrom(this.api.get(channelID));
      if (sequence !== this.loadSequence || channelID !== this.channelID()) return;
      this.config.set(configuration); this.reset();
    } catch {
      if (sequence === this.loadSequence && channelID === this.channelID()) this.error.set('loadError');
    } finally { if (sequence === this.loadSequence) this.loading.set(false); }
  }

  reset(): void {
    const settings = this.config()?.settings;
    if (!settings) return;
    this.form.reset({ enabled: settings.enabled, name: settings.name, speechEnabled: settings.tts.enabled,
      provider: settings.tts.provider, language: settings.tts.language, voice: settings.tts.voice,
      personalitySource: settings.personality.source, profileId: settings.personality.profileId, prompt: settings.personality.prompt,
      rules: settings.rules.join('\n'), ...settings.behavior });
    this.initialDraft.set(JSON.stringify(this.draft()));
    this.error.set('');
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
      this.config.set(result); this.reset(); this.saved.set(true);
    } catch (error) {
      if (this.channelID() !== channelID) return;
      const code = error instanceof HttpErrorResponse ? error.error?.message : '';
      this.error.set(code === 'settings_conflict' ? 'conflict' : code === 'personality_unavailable' ? 'profileMissing' : 'saveError');
    } finally { this.form.enable(); this.saving.set(false); }
  }
}
