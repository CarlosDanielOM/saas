import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io, type Socket } from 'socket.io-client';
import { LinksService } from '../../services/links.service';
import { LanguageService } from '../../services/language.service';
import { PopPlayer, type PopAudioState } from '../../shared/chat-sound/pop-sound';

/** Must match CHAT_SOUND_PROTOCOL in dimabot/src/server/services/chat-sound-overlay.service.ts. */
const PROTOCOL = 1;
const READY_EVERY_MS = 5000;
type Link = 'connecting' | 'connected' | 'invalid' | 'offline';
interface Settings { enabled: boolean; volume: number }

/**
 * OBS browser source: a pop for each chat message the server lets through (filters and cooldown are decided there).
 * Nothing shows in OBS; opened in a normal browser tab it shows a small status card and a button to allow sound.
 */
@Component({
  selector: 'app-chat-sound-overlay', changeDetection: ChangeDetectionStrategy.OnPush,
  // OBS fires obsSource* events when the source goes live or becomes visible: a good moment to (re)start audio.
  host: { '(document:pointerdown)': 'unlock()', '(document:keydown)': 'unlock()', '(document:visibilitychange)': 'unlock()', '(window:obsSourceActiveChanged)': 'unlock()', '(window:obsSourceVisibleChanged)': 'unlock()' },
  template: `@if (!inObs) {
    <div class="tab-page"><main class="card" data-testid="chat-sound-tab" [attr.data-link]="link()" [attr.data-audio]="audio()">
      <h1><span class="dot" [class.on]="link() === 'connected' && audio() === 'running'" aria-hidden="true"></span>{{ t('title') }}</h1>
      <p role="status">{{ t('status.' + status()) }}</p>
      <!-- One button whose label changes: the pointerdown that allows audio must not swap it out before the click lands. -->
      @if (link() === 'connected') { <button type="button" [class.primary]="audio() !== 'running'" (click)="unlock(true)">{{ t(audio() === 'running' ? 'try' : 'allow') }}</button> }
      <small>{{ t('obsTip') }}</small>
    </main></div>
  }`,
  styles: `:host { display:block; font-family:'Plus Jakarta Sans','Segoe UI',system-ui,sans-serif; --fg:#f5f7fb; --muted:#a7b0c2; --tile:#171a21; --line:rgba(255,255,255,.1) }
  .tab-page { box-sizing:border-box; min-height:100dvh; padding:24px 16px; background:#0f1115 }
  .card { box-sizing:border-box; max-width:420px; padding:18px; border-radius:20px; background:var(--tile); color:var(--fg); border:1px solid var(--line); display:grid; gap:10px }
  h1 { display:flex; align-items:center; gap:10px; margin:0; font-size:20px }
  p { margin:0; color:var(--fg); font-size:14px; line-height:1.5 }
  small { color:var(--muted); font-size:12px; line-height:1.5 }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted) }
  .dot.on { background:#ef4444; box-shadow:0 0 0 4px rgba(239,68,68,.18) }
  button { min-height:44px; padding:10px 16px; border-radius:999px; border:1px solid var(--line); background:#1d2230; color:var(--fg); font:inherit; font-size:14px; font-weight:700; cursor:pointer; justify-self:start }
  button.primary { background:#7c3aed; border-color:#7c3aed; color:#fff }
  button:focus-visible { outline:3px solid #a78bfa; outline-offset:3px }`
})
export class ChatSoundOverlayComponent {
  private readonly language = inject(LanguageService);
  private readonly player = new PopPlayer();
  /** OBS (and OBS docks) expose window.obsstudio; anything else is a normal tab. */
  readonly inObs = typeof window !== 'undefined' && !!(window as Window & { obsstudio?: unknown }).obsstudio;
  readonly link = signal<Link>('connecting');
  readonly audio = signal<PopAudioState>('suspended');
  readonly settings = signal<Settings | null>(null);
  private socket: Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const route = inject(ActivatedRoute).snapshot, doc = inject(DOCUMENT), destroy = inject(DestroyRef);
    const oldBody = doc.body.style.background, oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent'; doc.documentElement.style.background = 'transparent';
    const channel = route.paramMap.get('channelID') ?? '', token = route.fragment ?? '';
    this.player.changed = state => { this.audio.set(state); this.ready(); };
    // OBS lets pages start audio on their own; a normal tab stays suspended until a click.
    void this.unlock();
    if (/^[0-9]{1,30}$/.test(channel) && /^[\w-]{43}$/.test(token)) {
      // One namespace for every channel; the channel and its private token travel in the handshake.
      const socket = this.socket = io(`${inject(LinksService).getApiUrl()}/overlays/chat-sound`, { auth: { channel, token }, transports: ['websocket'], reconnection: true });
      socket.on('connect', () => { this.link.set('connected'); this.ready(); });
      socket.on('chat-sound-settings', (data: Settings) => {
        if (typeof data?.enabled === 'boolean' && typeof data.volume === 'number') this.settings.set({ enabled: data.enabled, volume: data.volume });
      });
      socket.on('chat-sound-pop', (data: { test?: boolean; volume?: number }) => {
        const settings = this.settings();
        if (!data?.test && !settings?.enabled) return;
        const volume = data?.test && typeof data.volume === 'number' ? data.volume : settings?.volume ?? 70;
        if (!this.player.play(volume)) this.audio.set(this.player.state());
      });
      socket.on('chat-sound-revoked', () => this.link.set('invalid'));
      // Middleware refusals and server-side disconnects are not retried by Socket.IO on its own.
      socket.on('connect_error', error => {
        const invalid = /invalid/i.test(error?.message ?? '');
        this.link.set(invalid ? 'invalid' : 'offline');
        if (!socket.active) this.reconnectLater(invalid ? 60_000 : 10_000);
      });
      socket.on('disconnect', reason => {
        if (this.link() !== 'invalid') this.link.set('offline');
        if (reason === 'io server disconnect') this.reconnectLater(this.link() === 'invalid' ? 60_000 : 5000);
      });
    } else this.link.set('invalid');
    const timer = setInterval(() => this.ready(), READY_EVERY_MS);
    destroy.onDestroy(() => {
      clearInterval(timer); clearTimeout(this.retry); this.socket?.disconnect(); this.player.close();
      doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot;
    });
  }
  t(key: string): string { return this.language.translate('chatSound.tab.' + key); }
  status(): string {
    const link = this.link();
    if (link !== 'connected') return link;
    if (this.settings()?.enabled === false) return 'off';
    return this.audio() === 'running' ? 'on' : 'blocked';
  }
  /** A click or key press lets a normal tab start audio; `play` also plays one pop so the tab can be checked. */
  async unlock(play = false): Promise<void> {
    const state = await this.player.unlock();
    this.audio.set(state);
    if (play && state === 'running') this.player.play(this.settings()?.volume ?? 70);
    this.ready();
  }
  private ready(): void {
    if (!this.socket?.connected) return;
    this.socket.emit('chat-sound-ready', { v: PROTOCOL, audio: this.player.state(), obs: this.inObs });
  }
  private reconnectLater(ms: number): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { if (this.socket && !this.socket.connected) this.socket.connect(); }, ms);
  }
}
