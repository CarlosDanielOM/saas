import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, viewChild, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { debounceTime, firstValueFrom, startWith } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { FishPreview, FishVoice, FishVoiceFavorite } from '../../models/tts-settings.model';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

type FilterKey = 'language' | 'gender';
type FilterChip = { key: FilterKey; value: string; label: string };

@Component({
  selector: 'app-fish-voice-browser',
  imports: [ReactiveFormsModule, LfIconComponent],
  templateUrl: './fish-voice-browser.component.html',
  styleUrl: './fish-voice-browser.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FishVoiceBrowserComponent {
  readonly channelID = input.required<string>();
  readonly selectedId = input('');
  readonly favorites = input<FishVoiceFavorite[]>([]);
  readonly favoriteSavingId = input<string | null>(null);
  readonly readOnly = input(false);
  readonly defaultLanguage = input<'en' | 'es'>('es');
  readonly selectVoice = output<FishVoice>();
  readonly toggleFavorite = output<FishVoice>();
  readonly dismiss = output<void>();
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly resultsBody = viewChild<ElementRef<HTMLDivElement>>('resultsBody');
  private readonly samplePlayer = viewChild<ElementRef<HTMLAudioElement>>('samplePlayer');
  private readonly player = viewChild<ElementRef<HTMLAudioElement>>('player');
  private releaseDialog?: () => void;
  private readonly api = inject(TtsSettingsApiService);
  private readonly language = inject(LanguageService);
  private readonly links = inject(LinksService);
  private readonly destroyRef = inject(DestroyRef);
  readonly filters = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    gender: new FormControl('all', { nonNullable: true }),
    language: new FormControl('all', { nonNullable: true }),
    license: new FormControl('all', { nonNullable: true })
  });
  /** Mirrors the form so OnPush chips update when filters change. */
  readonly filterState = signal(this.filters.getRawValue());
  readonly hasFilters = computed(() => {
    const state = this.filterState();
    return !!state.name || state.gender !== 'all' || state.language !== 'all' || state.license !== 'all';
  });
  readonly filterGroups = computed<{ key: FilterKey; label: string; chips: FilterChip[] }[]>(() => {
    this.language.currentLanguage();
    const languages = this.defaultLanguage() === 'es' ? ['es', 'en'] : ['en', 'es'];
    return [
      { key: 'language', label: this.t('language'), chips: [
        ...languages.map(value => ({ key: 'language' as const, value, label: this.t(value === 'es' ? 'spanish' : 'english') })),
        { key: 'language', value: 'all', label: this.t('anyLanguage') }
      ] },
      { key: 'gender', label: this.t('gender'), chips: [
        { key: 'gender', value: 'all', label: this.t('anyGender') },
        { key: 'gender', value: 'female', label: this.t('female') },
        { key: 'gender', value: 'male', label: this.t('male') }
      ] }
    ];
  });
  readonly voices = signal<FishVoice[]>([]);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly searchError = signal(false);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly expandedId = signal<string | null>(null);
  // Fish's own sample clips: free, no credits.
  readonly sampleId = signal<string | null>(null);
  readonly samplePlaying = signal(false);
  readonly sampleProgress = signal(0);
  readonly sampleErrorId = signal<string | null>(null);
  // Paid test: one of our phrases in the streamer's language, charged in credits.
  readonly previewing = signal<string | null>(null);
  readonly previewVoiceId = signal<string | null>(null);
  readonly previewError = signal('');
  readonly preview = signal<FishPreview | null>(null);
  readonly audioUrl = signal('');
  readonly playbackBlocked = signal(false);
  private requestVersion = 0;
  private previewVersion = 0;
  private languageSeeded = false;
  private socket?: Socket;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      const previousFocus = document.activeElement;
      const bodyOverflow = document.body.style.overflow;
      const rootOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      dialog.showModal();
      this.releaseDialog = () => {
        dialog.close();
        document.body.style.overflow = bodyOverflow;
        document.documentElement.style.overflow = rootOverflow;
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      };
    });
    effect(onCleanup => {
      const channel = this.channelID();
      // Start with voices in the channel's TTS language; "Any language" stays one tap away.
      if (!this.languageSeeded) {
        this.languageSeeded = true;
        this.filters.controls.language.setValue(untracked(this.defaultLanguage), { emitEvent: false });
        this.filterState.set(this.filters.getRawValue());
      }
      const subscription = this.filters.valueChanges.pipe(startWith(this.filters.getRawValue()), debounceTime(300))
        .subscribe(() => {
          this.filterState.set(this.filters.getRawValue());
          void this.search(1, channel);
        });
      onCleanup(() => { subscription.unsubscribe(); this.requestVersion++; this.stopSample(); this.clearPreview(); });
    });
    this.destroyRef.onDestroy(() => { this.requestVersion++; this.stopSample(); this.clearPreview(); this.releaseDialog?.(); });
  }
  onBackdropClick(event: MouseEvent) {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.dismiss.emit();
  }
  t(key: string, params?: Record<string, string | number>) { return this.language.translate(`modules.tts.browser.${key}`, params); }
  isFavorite(id: string): boolean { return this.favorites().some(favorite => favorite.id === id); }
  isFilterOn(chip: FilterChip): boolean { return this.filterState()[chip.key] === chip.value; }
  setFilter(chip: FilterChip) { this.filters.controls[chip.key].setValue(chip.value); }
  toggleLicensedOnly() { this.filters.controls.license.setValue(this.filterState().license === 'licensed' ? 'all' : 'licensed'); }
  clearFilters() { this.filters.setValue({ name: '', gender: 'all', language: 'all', license: 'all' }); }
  toggleExpanded(id: string) { this.expandedId.update(current => current === id ? null : id); }
  voiceMeta(voice: FishVoice): string {
    const parts = [voice.gender ? this.t(voice.gender) : '', voice.languages.map(code => code.toUpperCase()).join(' · ')];
    if (voice.uses) {
      const count = new Intl.NumberFormat(this.language.currentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(voice.uses);
      parts.push(this.t('uses', { count }));
    }
    return parts.filter(Boolean).join(' · ');
  }
  initial(voice: FishVoice): string { return (voice.name.trim()[0] || '?').toUpperCase(); }

  async search(page = 1, channel = this.channelID()) {
    const version = ++this.requestVersion;
    const append = page > 1;
    if (!append) {
      this.resultsBody()?.nativeElement.scrollTo({ top: 0, behavior: 'instant' });
      this.expandedId.set(null);
    }
    (append ? this.loadingMore : this.loading).set(true);
    this.searchError.set(false);
    try {
      const result = await firstValueFrom(this.api.searchVoices(channel, { ...this.filters.getRawValue(), page }));
      if (version !== this.requestVersion) return;
      this.voices.update(current => {
        if (!append) return result.items;
        const seen = new Set(current.map(voice => voice.id));
        return [...current, ...result.items.filter(voice => !seen.has(voice.id))];
      });
      this.page.set(result.page);
      this.hasMore.set(result.hasMore);
    } catch {
      if (version === this.requestVersion) {
        this.searchError.set(true);
        if (!append) { this.voices.set([]); this.hasMore.set(false); }
      }
    } finally {
      if (version === this.requestVersion) { this.loading.set(false); this.loadingMore.set(false); }
    }
  }
  loadMore() { if (!this.loading() && !this.loadingMore() && this.hasMore()) void this.search(this.page() + 1); }
  retry() { void this.search(this.voices().length ? this.page() + 1 : 1); }

  toggleSample(voice: FishVoice) {
    const audio = this.samplePlayer()?.nativeElement;
    if (!audio || !voice.sample) return;
    if (this.sampleId() === voice.id) {
      if (audio.paused) void audio.play().catch(() => this.onSampleError());
      else audio.pause();
      return;
    }
    this.player()?.nativeElement.pause();
    this.sampleId.set(voice.id);
    this.samplePlaying.set(false);
    this.sampleProgress.set(0);
    this.sampleErrorId.set(null);
    audio.src = voice.sample.url;
    void audio.play().catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) this.onSampleError(); });
  }
  onSampleTime(audio: HTMLAudioElement) {
    if (audio.duration > 0) this.sampleProgress.set(Math.min(1, audio.currentTime / audio.duration));
  }
  onSampleEnded() { this.samplePlaying.set(false); this.sampleProgress.set(0); this.sampleId.set(null); }
  onSampleError() {
    if (!this.sampleId()) return;
    this.sampleErrorId.set(this.sampleId());
    this.samplePlaying.set(false);
    this.sampleId.set(null);
  }
  stopSample() {
    const audio = this.samplePlayer()?.nativeElement;
    if (audio && this.sampleId()) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    this.sampleId.set(null);
    this.samplePlaying.set(false);
    this.sampleProgress.set(0);
  }

  async testVoice(voice: FishVoice) {
    if (this.readOnly() || this.previewing()) return;
    this.stopSample();
    this.clearPreview();
    const version = this.previewVersion;
    this.previewing.set(voice.id);
    this.previewVoiceId.set(voice.id);
    this.expandedId.set(voice.id);
    try {
      const channel = this.channelID();
      const { ticket } = await firstValueFrom(this.api.createPreviewSession(channel));
      if (version !== this.previewVersion) return;
      const socket = io(`${this.links.getApiUrl()}/speech-preview/${channel}`, {
        auth: { ticket }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000
      });
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', () => reject(new Error('preview_unavailable')));
      });
      if (version !== this.previewVersion) return;
      const result = await new Promise<{ error: boolean; code?: string; data?: FishPreview }>((resolve, reject) => {
        socket.timeout(90000).emit('preview', { voiceId: voice.id, language: this.testLanguage() },
          (error: Error | null, response: { error: boolean; code?: string; data?: FishPreview }) => {
            if (error) reject(new Error('preview_timeout')); else resolve(response);
          });
      });
      if (version !== this.previewVersion) return;
      if (result.error || !result.data) throw new Error(result.code || 'preview_unavailable');
      this.preview.set(result.data);
      const bytes = Uint8Array.from(atob(result.data.audio), c => c.charCodeAt(0));
      this.audioUrl.set(URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType })));
      // Native controls remain available when a browser requires a second gesture to play audio.
      setTimeout(() => {
        if (version === this.previewVersion) void this.player()?.nativeElement.play().catch(() => this.playbackBlocked.set(true));
      });
    } catch (error) {
      if (version === this.previewVersion) {
        const code = error instanceof Error ? error.message : '';
        this.previewError.set(['insufficient_credits', 'preview_busy', 'voice_unavailable', 'synthesis_failed', 'preview_timeout'].includes(code) ? code : 'preview_unavailable');
      }
    } finally {
      if (version === this.previewVersion) { this.previewing.set(null); this.socket?.disconnect(); this.socket = undefined; }
    }
  }
  /** Phrase language for paid tests: the language filter, or the channel's TTS language. */
  testLanguage(): 'en' | 'es' {
    const filter = this.filterState().language;
    return filter === 'en' || filter === 'es' ? filter : this.defaultLanguage();
  }
  private clearPreview() {
    this.previewVersion++;
    this.socket?.disconnect();
    this.socket = undefined;
    this.player()?.nativeElement.pause();
    if (this.audioUrl()) URL.revokeObjectURL(this.audioUrl());
    this.audioUrl.set('');
    this.preview.set(null);
    this.previewing.set(null);
    this.previewVoiceId.set(null);
    this.previewError.set('');
    this.playbackBlocked.set(false);
  }
}
