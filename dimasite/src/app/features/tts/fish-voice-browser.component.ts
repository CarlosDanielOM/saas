import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, viewChild, effect, inject, input, output, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { debounceTime, firstValueFrom, startWith } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { FishPreview, FishVoice } from '../../models/tts-settings.model';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';

@Component({
  selector: 'app-fish-voice-browser',
  imports: [ReactiveFormsModule],
  templateUrl: './fish-voice-browser.component.html',
  styleUrl: './fish-voice-browser.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FishVoiceBrowserComponent {
  readonly channelID = input.required<string>();
  readonly selectedId = input('');
  readonly readOnly = input(false);
  readonly defaultLanguage = input<'en' | 'es'>('es');
  readonly selectVoice = output<FishVoice>();
  private readonly api = inject(TtsSettingsApiService);
  private readonly language = inject(LanguageService);
  private readonly links = inject(LinksService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly player = viewChild<ElementRef<HTMLAudioElement>>('player');
  readonly filters = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    gender: new FormControl('all', { nonNullable: true }),
    language: new FormControl('all', { nonNullable: true }),
    license: new FormControl('all', { nonNullable: true })
  });
  readonly voices = signal<FishVoice[]>([]);
  readonly loading = signal(false);
  readonly searchError = signal(false);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly previewing = signal<string | null>(null);
  readonly previewError = signal('');
  readonly preview = signal<FishPreview | null>(null);
  readonly audioUrl = signal('');
  readonly previewName = signal('');
  readonly playbackBlocked = signal(false);
  private requestVersion = 0;
  private previewVersion = 0;
  private socket?: Socket;

  constructor() {
    effect(onCleanup => {
      const channel = this.channelID();
      const subscription = this.filters.valueChanges.pipe(startWith(this.filters.getRawValue()), debounceTime(300))
        .subscribe(() => void this.search(1, channel));
      onCleanup(() => { subscription.unsubscribe(); this.requestVersion++; this.clearPreview(); });
    });
    this.destroyRef.onDestroy(() => { this.requestVersion++; this.clearPreview(); });
  }
  t(key: string, params?: Record<string, string | number>) { return this.language.translate(`modules.tts.browser.${key}`, params); }
  async search(page = 1, channel = this.channelID()) {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.searchError.set(false);
    try {
      const result = await firstValueFrom(this.api.searchVoices(channel, { ...this.filters.getRawValue(), page }));
      if (version !== this.requestVersion) return;
      this.voices.set(result.items);
      this.page.set(result.page);
      this.hasMore.set(result.hasMore);
    } catch {
      if (version === this.requestVersion) { this.searchError.set(true); this.voices.set([]); this.hasMore.set(false); }
    } finally { if (version === this.requestVersion) this.loading.set(false); }
  }
  async testVoice(voice: FishVoice) {
    if (this.readOnly() || this.previewing()) return;
    this.clearPreview();
    const version = this.previewVersion;
    this.previewing.set(voice.id);
    this.previewName.set(voice.name);
    this.previewError.set('');
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
      const language = this.filters.controls.language.value === 'all'
        ? this.defaultLanguage() : this.filters.controls.language.value;
      const result = await new Promise<{ error: boolean; code?: string; data?: FishPreview }>((resolve, reject) => {
        socket.timeout(90000).emit('preview', { voiceId: voice.id, language },
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
  private clearPreview() {
    this.previewVersion++;
    this.socket?.disconnect();
    this.socket = undefined;
    this.player()?.nativeElement.pause();
    if (this.audioUrl()) URL.revokeObjectURL(this.audioUrl());
    this.audioUrl.set('');
    this.preview.set(null);
    this.previewing.set(null);
    this.previewError.set('');
    this.playbackBlocked.set(false);
  }
}
