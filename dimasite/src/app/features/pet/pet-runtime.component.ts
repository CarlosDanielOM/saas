import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { io, Socket } from 'socket.io-client';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { PetBrowserPlayer, BrowserPetPlaybackReport } from './pet-browser-player';
import type { PetAck, PetLease, PetPlay, PetRequestView, PetSnapshot } from './pet-runtime.model';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const statuses: readonly string[] = ['accepted', 'generating', 'synthesizing', 'ready', 'playing', 'completed', 'cancelled', 'failed', 'expired'];
function requestView(value: unknown): value is PetRequestView {
  return record(value) && identifier(value['requestId']) && (value['operation'] === 'talk' || value['operation'] === 'ask') &&
    typeof value['status'] === 'string' && statuses.includes(value['status']) && integer(value['version']);
}
function snapshot(value: unknown): value is PetSnapshot {
  if (!record(value) || value['v'] !== 1 || !integer(value['generation']) || !integer(value['settingsRevision']) ||
    !identifier(value['peerId']) || !integer(value['serverTime']) || !record(value['appearance']) || !record(value['playback']) || !record(value['assets'])) return false;
  const appearance = value['appearance'], playback = value['playback'], assets = value['assets'], lease = value['lease'];
  return (appearance['kind'] === 'png' || appearance['kind'] === 'vts') && (playback['target'] === 'browser' || playback['target'] === 'desktop') &&
    (assets['idleUrl'] === null || typeof assets['idleUrl'] === 'string') && (assets['talkingUrl'] === null || typeof assets['talkingUrl'] === 'string') &&
    (value['active'] === null || requestView(value['active'])) && (lease === null || record(lease) && identifier(lease['leaseId']) && identifier(lease['holderPeerId']) && integer(lease['expiresAt']));
}
function play(value: unknown): value is PetPlay {
  return record(value) && value['v'] === 1 && identifier(value['requestId']) && integer(value['generation']) && identifier(value['leaseId']) &&
    integer(value['startBefore']) && record(value['audio']) && typeof value['audio']['url'] === 'string' &&
    (value['audio']['mimeType'] === 'audio/wav' || value['audio']['mimeType'] === 'audio/mpeg') &&
    integer(value['audio']['durationMs']) && value['audio']['durationMs'] > 0 && value['audio']['durationMs'] <= 60_000;
}

@Component({
  selector: 'app-pet-runtime',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main class="pet-canvas" [attr.aria-label]="t('rendererLabel')">
    @if (state()?.appearance?.kind === 'png') {
      @if (idleUrl(); as url) { <img class="pet-image" [class.visible]="!talking()" [src]="url" alt="" referrerpolicy="no-referrer" (load)="imageLoaded('idle', url)" (error)="imageFailed('idle', url)" /> }
      @if (talkingUrl(); as url) { <img class="pet-image" [class.visible]="talking()" [src]="url" alt="" referrerpolicy="no-referrer" (load)="imageLoaded('talking', url)" (error)="imageFailed('talking', url)" /> }
    }
    <span class="sr-only" role="status">{{ t(status()) }}</span>
    @if (status() === 'rendererAutoplay') { <button type="button" (click)="enableAudio()">{{ t('enableAudio') }}</button> }
    @if (status() === 'rendererOffline') { <button type="button" (click)="reconnect()">{{ t('retry') }}</button> }
  </main>`,
  styles: `:host { display:block; position:fixed; inset:0; background:transparent; color:#fff; font-family:'Plus Jakarta Sans',sans-serif } .pet-canvas { position:relative; width:100%; height:100%; overflow:hidden } .pet-image { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; visibility:hidden; pointer-events:none } .pet-image.visible { visibility:visible } .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0 } button { position:absolute; bottom:1rem; left:1rem; max-width:calc(100% - 2rem); min-height:44px; border:1px solid #c4b5fd; border-radius:.75rem; padding:.7rem 1rem; background:#171a21; color:#fff; font:inherit; cursor:pointer } button:focus-visible { outline:3px solid #c4b5fd; outline-offset:3px }`
})
export class PetRuntimeComponent {
  private readonly document = inject(DOCUMENT);
  private readonly language = inject(LanguageService);
  private readonly base = inject(LinksService).getApiUrl().replace(/\/$/, '');
  private readonly capability = inject(ActivatedRoute).snapshot.paramMap.get('capability') ?? '';
  readonly state = signal<PetSnapshot | null>(null);
  readonly talking = signal(false);
  readonly status = signal('rendererConnecting');
  readonly idleUrl = computed(() => this.assetUrl(this.state()?.assets.idleUrl));
  readonly talkingUrl = computed(() => this.assetUrl(this.state()?.assets.talkingUrl));
  private readonly loadedImages = new Map<'idle' | 'talking', string>();
  private readonly player = new PetBrowserPlayer(report => this.onPlayback(report), (id, positionMs, value) => this.onMouth(id, positionMs, value), speaking => this.talking.set(speaking));
  private readonly socket: Socket = io(`${this.base}/pet`, { path: '/socket.io/', transports: ['websocket'],
    auth: { v: 1, capability: this.capability }, autoConnect: false, reconnectionAttempts: 8, reconnectionDelay: 1000, reconnectionDelayMax: 30_000, randomizationFactor: .5 });
  private lease: PetLease | null = null;
  private leaseDeadline = 0;
  private leaseExpiry?: ReturnType<typeof setTimeout>;
  private renewal?: ReturnType<typeof setTimeout>;
  private acquireRetry?: ReturnType<typeof setTimeout>;
  private acquiring = false;
  private leaseAttempt = 0;
  private readyEpoch = 0;
  private readyInFlight = false;
  private readyAccepted = false;
  private audioReady = true;
  private readySignature = '';
  private progressInFlight = false;
  private connection = 0;
  private active: PetPlay | null = null;
  private sequence = 0;
  private lastProgress = 0;
  private lastMouth = 0;
  private disposed = false;
  private clock = { serverTime: 0, receivedAt: 0 };
  private readonly versions = new Map<string, number>();

  constructor() {
    const doc = this.document, oldBody = doc.body.style.background, oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent'; doc.documentElement.style.background = 'transparent';
    const referrer = doc.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; doc.head.append(referrer);
    this.socket.on('pet:snapshot', (value: unknown) => this.acceptSnapshot(value));
    this.socket.on('pet:request', (value: unknown) => this.acceptRequest(value));
    this.socket.on('pet:play', (value: unknown) => this.acceptPlay(value));
    this.socket.on('pet:stop', (value: unknown) => {
      if (record(value) && value['v'] === 1 && value['generation'] === this.state()?.generation && identifier(value['requestId'])) {
        if (value['requestId'] === this.active?.requestId) this.stopPlayback(true);
        if (value['requestId'] === this.state()?.active?.requestId) this.talking.set(false);
      }
    });
    this.socket.on('connect', () => { this.connection++; this.resetReady(); this.versions.clear(); this.state.set(null); this.status.set(this.audioReady ? 'rendererConnecting' : 'rendererAutoplay'); });
    this.socket.on('disconnect', reason => {
      this.connection++; this.resetReady(); this.releaseLease(); this.state.set(null); this.status.set('rendererOffline');
      if (reason === 'io server disconnect') this.socket.disconnect();
    });
    this.socket.on('connect_error', () => { this.connection++; this.resetReady(); this.releaseLease(); this.status.set('rendererOffline'); });
    if (/^[a-zA-Z0-9_-]{43}$/.test(this.capability)) this.socket.connect();
    else this.status.set('rendererUnavailable');
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true; this.connection++; this.releaseLease(); this.player.destroy(); this.socket.disconnect();
      doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; referrer.remove();
    });
  }

  t(key: string): string { return this.language.translate(`pet.${key}`); }
  reconnect(): void { if (!this.disposed) this.socket.connect(); }

  private assetUrl(raw: string | null | undefined): string {
    if (!raw || raw.length > 2048) return '';
    try {
      const url = new URL(raw, this.base + '/'), base = new URL(this.base);
      return url.origin === base.origin && url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/pets/public/${encodeURIComponent(this.capability)}/assets/`) && !url.search && !url.hash ? url.href : '';
    } catch { return ''; }
  }
  private audioUrl(message: PetPlay): string {
    if (message.audio.url.length > 4096) return '';
    try {
      const url = new URL(message.audio.url, this.base + '/'), base = new URL(this.base);
      return url.origin === base.origin && url.pathname === `${base.pathname.replace(/\/$/, '')}/pets/playback/${encodeURIComponent(message.requestId)}/audio` &&
        !!url.searchParams.get('ticket') && !url.hash ? url.href : '';
    } catch { return ''; }
  }
  imageLoaded(kind: 'idle' | 'talking', url: string): void { this.loadedImages.set(kind, url); this.ready(); }
  imageFailed(kind: 'idle' | 'talking', url: string): void { if (this.loadedImages.get(kind) === url) this.loadedImages.delete(kind); this.status.set('rendererImageError'); this.ready(); }
  private resetReady(): void { this.readyEpoch++; this.readyAccepted = false; this.readyInFlight = false; this.readySignature = ''; }
  private ready(): void {
    const state = this.state();
    if (!state || !this.socket.connected) return;
    const renderReady = state.appearance.kind === 'vts' || !!this.idleUrl() && !!this.talkingUrl() &&
      this.loadedImages.get('idle') === this.idleUrl() && this.loadedImages.get('talking') === this.talkingUrl();
    const signature = `${state.peerId}:${state.generation}:${renderReady}:${this.audioReady}`;
    if (this.readyInFlight) return;
    if (this.readyAccepted && this.readySignature === signature) { if (renderReady) this.acquireLease(); return; }
    this.readyAccepted = false; this.readyInFlight = true;
    const epoch = this.readyEpoch;
    this.socket.timeout(4000).emit('pet:ready', { v: 1, audioReady: this.audioReady, renderReady, vtsReady: false }, (error: Error | null, ack: unknown) => {
      if (this.disposed || epoch !== this.readyEpoch) return;
      this.readyInFlight = false;
      if (error || !record(ack) || ack['ok'] !== true) { this.readyAccepted = false; this.releaseLease(); this.status.set('rendererUnavailable'); return; }
      this.readyAccepted = true; this.readySignature = signature;
      if (renderReady && this.audioReady && !this.active && this.status() !== 'rendererAutoplay') this.status.set('rendererReady');
      this.ready();
    });
  }

  private acceptSnapshot(input: unknown): void {
    if (!snapshot(input) || this.disposed || !this.socket.connected) return;
    let value: PetSnapshot = input;
    const previous = this.state();
    if (previous && (value.generation === previous.generation && value.serverTime < previous.serverTime || value.generation < previous.generation || value.generation === previous.generation && value.settingsRevision < previous.settingsRevision)) return;
    if (previous && (previous.generation !== value.generation || previous.peerId !== value.peerId)) { this.resetReady(); this.releaseLease(); this.versions.clear(); }
    const incoming = value.active;
    if (previous?.generation === value.generation && incoming && incoming.version < (this.versions.get(incoming.requestId) ?? -1)) value = { ...value, active: previous.active };
    this.clock = { serverTime: value.serverTime, receivedAt: performance.now() };
    this.state.set(value);
    if (value.active) this.versions.set(value.active.requestId, Math.max(value.active.version, this.versions.get(value.active.requestId) ?? -1));
    while (this.versions.size > 128) this.versions.delete(this.versions.keys().next().value!);
    if (value.playback.target !== 'browser' || value.lease && value.lease.holderPeerId !== value.peerId ||
      this.lease && (!value.lease || value.lease.leaseId !== this.lease.leaseId)) this.releaseLease();
    if (!this.active) this.talking.set(value.active?.status === 'playing');
    this.ready();
  }
  private acceptRequest(value: unknown): void {
    const state = this.state();
    if (!state || !record(value) || value['v'] !== 1 || value['generation'] !== state.generation || !requestView(value['request'])) return;
    const request = value['request'];
    if (state.active && state.active.requestId !== request.requestId && !['completed', 'cancelled', 'failed', 'expired'].includes(state.active.status)) return;
    if ((this.versions.get(request.requestId) ?? -1) >= request.version) return;
    this.versions.set(request.requestId, request.version);
    while (this.versions.size > 128) this.versions.delete(this.versions.keys().next().value!);
    this.state.set({ ...state, active: request });
    if (!this.active) this.talking.set(request.status === 'playing');
    if (['completed', 'cancelled', 'failed', 'expired'].includes(request.status) && this.active?.requestId === request.requestId) this.stopPlayback(false);
  }

  private acquireLease(): void {
    const state = this.state();
    if (!state || this.disposed || !this.socket.connected || state.playback.target !== 'browser' || !this.audioReady || !this.readyAccepted || this.readyInFlight || this.lease || this.acquiring ||
      state.lease && state.lease.holderPeerId !== state.peerId) return;
    this.acquiring = true;
    const connection = this.connection, generation = state.generation, sentAt = performance.now(), attempt = ++this.leaseAttempt;
    this.socket.timeout(4000).emit('pet:lease', { v: 1, action: 'acquire' }, (error: Error | null, ack: PetAck<PetLease>) => {
      if (connection !== this.connection || this.disposed || generation !== this.state()?.generation || attempt !== this.leaseAttempt) return;
      this.acquiring = false;
      if (!error && this.acceptLease(ack, sentAt)) return;
      const retryAfter = ack && !ack.ok ? ack.error?.retryAfterMs ?? (ack.error?.code === 'lease_unavailable' ? 5000 : undefined) : undefined;
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
        clearTimeout(this.acquireRetry);
        this.acquireRetry = setTimeout(() => this.acquireLease(), Math.max(1000, Math.min(30_000, retryAfter)));
      }
    });
  }
  private acceptLease(ack: PetAck<PetLease>, sentAt: number): boolean {
    if (!record(ack) || ack['ok'] !== true || !record(ack['data'])) return false;
    const lease = ack['data'];
    if (!identifier(lease['leaseId']) || lease['generation'] !== this.state()?.generation || !integer(lease['ttlMs']) || lease['ttlMs'] < 1000 || lease['ttlMs'] > 15_000 ||
      !integer(lease['expiresAt']) || !integer(lease['serverTime']) || lease['expiresAt'] <= lease['serverTime'] || this.state()?.playback.target !== 'browser') return false;
    const ttl = Math.min(lease['ttlMs'], lease['expiresAt'] - lease['serverTime']) - 500;
    const remaining = sentAt + ttl - performance.now();
    if (remaining <= 0) return false;
    this.lease = lease as unknown as PetLease;
    this.clock = { serverTime: lease['serverTime'], receivedAt: performance.now() };
    // Use a monotonic local deadline. Never let a late renewal revive an expired local lease.
    this.leaseDeadline = sentAt + ttl;
    clearTimeout(this.leaseExpiry); clearTimeout(this.renewal);
    this.leaseExpiry = setTimeout(() => this.releaseLease(), remaining);
    this.renewal = setTimeout(() => this.renewLease(), Math.min(5000, Math.floor(remaining / 2)));
    return true;
  }
  private renewLease(): void {
    const lease = this.lease, connection = this.connection, sentAt = performance.now();
    if (!lease || performance.now() >= this.leaseDeadline) { this.releaseLease(); return; }
    this.socket.timeout(4000).emit('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation }, (error: Error | null, ack: PetAck<PetLease>) => {
      if (this.disposed || connection !== this.connection || this.lease !== lease) return;
      if (performance.now() >= this.leaseDeadline || error || !this.acceptLease(ack, sentAt)) this.releaseLease();
    });
  }
  private releaseLease(): void {
    clearTimeout(this.leaseExpiry); clearTimeout(this.renewal); clearTimeout(this.acquireRetry);
    this.acquiring = false; this.leaseAttempt++;
    this.stopPlayback(false);
    this.lease = null; this.leaseDeadline = 0;
  }
  private owns(message: PetPlay): boolean {
    return this.audioReady && !!this.lease && this.socket.connected && this.state()?.playback.target === 'browser' && message.leaseId === this.lease.leaseId &&
      message.generation === this.lease.generation && message.generation === this.state()?.generation && performance.now() < this.leaseDeadline;
  }
  private serverNow(): number { return this.clock.serverTime + performance.now() - this.clock.receivedAt; }
  private acceptPlay(value: unknown): void {
    if (!play(value) || !this.owns(value) || this.active || value.startBefore <= this.serverNow()) return;
    const url = this.audioUrl(value);
    if (!url) return;
    // Translate the server's start deadline from its latest snapshot without trusting the PC's clock.
    const startBefore = Date.now() + Math.min(15_000, value.startBefore - this.serverNow());
    this.active = value; this.sequence = 0; this.lastProgress = 0; this.lastMouth = 0;
    if (!this.player.prepare({ id: value.requestId, url, startBefore, maxDurationMs: value.audio.durationMs })) this.active = null;
  }
  private onPlayback(report: BrowserPetPlaybackReport): void {
    const active = this.active;
    if (!active || active.requestId !== report.id || !this.owns(active)) { this.stopPlayback(false); return; }
    if (report.state === 'ready') { void this.player.start(report.id); return; }
    this.emitPlayback(active, { v: 1, requestId: report.id, leaseId: active.leaseId, generation: active.generation,
      seq: ++this.sequence, phase: report.state === 'error' ? 'error' : report.state, positionMs: report.positionMs,
      ...(report.error ? { errorCode: report.error } : {}) });
    if (report.state === 'started') this.status.set('rendererReady');
    if (report.state === 'error') this.status.set(report.error === 'autoplay_blocked' ? 'rendererAutoplay' : 'rendererAudioError');
    if (report.state === 'ended' || report.state === 'error') { this.active = null; this.talking.set(false); }
    if (report.error === 'autoplay_blocked') {
      this.audioReady = false; this.releaseLease(); this.ready();
    }
  }
  private onMouth(id: string, positionMs: number, value: number): void {
    const active = this.active, now = performance.now();
    if (!active || active.requestId !== id || !this.owns(active)) { this.stopPlayback(false); return; }
    if (now - this.lastMouth < 90) return;
    this.lastMouth = now;
    this.socket.volatile.emit('pet:mouth', { v: 1, requestId: id, leaseId: active.leaseId, generation: active.generation, seq: ++this.sequence, positionMs, value });
    if (now - this.lastProgress >= 1000 && !this.progressInFlight) {
      this.lastProgress = now;
      this.emitPlayback(active, { v: 1, requestId: id, leaseId: active.leaseId, generation: active.generation, seq: ++this.sequence, phase: 'progress', positionMs }, true);
    }
  }
  private emitPlayback(active: PetPlay, frame: Record<string, unknown>, progress = false): void {
    if (!this.owns(active)) return;
    if (progress) this.progressInFlight = true;
    this.socket.timeout(4000).emit('pet:playback', frame, (error: Error | null, ack: unknown) => {
      if (this.disposed || this.active !== active) return;
      if (progress) this.progressInFlight = false;
      if (error || !record(ack) || ack['ok'] !== true) { this.releaseLease(); this.status.set('rendererAudioError'); }
    });
  }
  private stopPlayback(report: boolean): void {
    const active = this.active;
    this.active = null; this.progressInFlight = false; this.player.reset(); this.talking.set(false);
    if (report && active && this.owns(active)) this.emitPlayback(active, { v: 1, requestId: active.requestId, leaseId: active.leaseId,
      generation: active.generation, seq: ++this.sequence, phase: 'stopped', positionMs: 0 });
  }
  async enableAudio(): Promise<void> {
    // A gesture unlocks this renderer's audio context; a failed speech is never replayed.
    try { await this.player.unlock(); if (this.disposed) return; this.audioReady = true; this.status.set('rendererReady'); this.ready(); }
    catch { this.status.set('rendererAutoplay'); }
  }
}
