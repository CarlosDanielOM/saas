import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { VoicePreview } from '../../models/tts-settings.model';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';

@Component({
  selector: 'app-tts-voice-preview',
  templateUrl: './tts-voice-preview.component.html',
  styleUrl: './tts-voice-preview.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TtsVoicePreviewComponent {
  readonly channelID = input.required<string>();
  readonly provider = input.required<'piper' | 'kokoro'>();
  readonly voice = input.required<string>();
  readonly language = input.required<'en' | 'es'>();
  readonly readOnly = input(false);
  /** Show the cost line and hint; off for a second preview in the same card. */
  readonly hint = input(true);
  readonly preparing = signal(false);
  readonly error = signal('');
  readonly preview = signal<VoicePreview | null>(null);
  readonly audioUrl = signal('');
  readonly playbackBlocked = signal(false);
  private readonly api = inject(TtsSettingsApiService);
  private readonly links = inject(LinksService);
  private readonly translations = inject(LanguageService);
  private readonly player = viewChild<ElementRef<HTMLAudioElement>>('player');
  private version = 0;
  private socket?: Socket;

  constructor() {
    effect(onCleanup => {
      // A sample always belongs to the currently selected voice and phrase language.
      this.channelID(); this.provider(); this.voice(); this.language();
      onCleanup(() => untracked(() => this.clear()));
    });
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  t(key: string, params?: Record<string, string | number>) {
    return this.translations.translate(`modules.tts.${key}`, params);
  }

  async testVoice() {
    if (this.readOnly() || this.preparing()) return;
    this.clear();
    const version = this.version;
    const channel = this.channelID();
    const request = { provider: this.provider(), voiceId: this.voice(), language: this.language() };
    this.preparing.set(true);
    try {
      const { ticket } = await firstValueFrom(this.api.createPreviewSession(channel));
      if (version !== this.version) return;
      const socket = io(`${this.links.getApiUrl()}/speech-preview/${channel}`, {
        auth: { ticket }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000
      });
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', () => reject(new Error('preview_unavailable')));
      });
      if (version !== this.version) return;
      const result = await new Promise<{ error: boolean; code?: string; data?: VoicePreview }>((resolve, reject) => {
        socket.timeout(90000).emit('preview', request,
          (error: Error | null, response: { error: boolean; code?: string; data?: VoicePreview }) => {
            if (error) reject(new Error('preview_timeout')); else resolve(response);
          });
      });
      if (version !== this.version) return;
      if (result.error || !result.data) throw new Error(result.code || 'preview_unavailable');
      this.preview.set(result.data);
      const bytes = Uint8Array.from(atob(result.data.audio), c => c.charCodeAt(0));
      this.audioUrl.set(URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType })));
      setTimeout(() => {
        if (version === this.version) void this.player()?.nativeElement.play().catch(() => this.playbackBlocked.set(true));
      });
    } catch (error) {
      if (version === this.version) {
        const code = error instanceof Error ? error.message : '';
        this.error.set(['insufficient_credits', 'preview_busy', 'voice_unavailable', 'synthesis_failed', 'preview_timeout'].includes(code) ? code : 'preview_unavailable');
      }
    } finally {
      if (version === this.version) { this.preparing.set(false); this.socket?.disconnect(); this.socket = undefined; }
    }
  }

  private clear() {
    this.version++;
    this.socket?.disconnect();
    this.socket = undefined;
    this.player()?.nativeElement.pause();
    if (this.audioUrl()) URL.revokeObjectURL(this.audioUrl());
    this.audioUrl.set('');
    this.preview.set(null);
    this.preparing.set(false);
    this.error.set('');
    this.playbackBlocked.set(false);
  }
}
