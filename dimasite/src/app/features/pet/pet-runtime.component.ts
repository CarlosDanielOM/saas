import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { io, Socket } from 'socket.io-client';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { PetBrowserPlayer, BrowserPetPlaybackReport } from './pet-browser-player';
import { PetMoodDisplay } from './pet-mood-display';
import { normalizePetMood, normalizePetMoodMetadata, type PetMood } from '../../models/pet-moods.model';
import { warnPetMood } from '../../models/pet-mood-warning';
import { PetFollowClock } from './pet-follow-clock';
import type { PetAck, PetLease, PetPlay, PetRequestView, PetSnapshot } from './pet-runtime.model';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const transientAck = (error: Error | null, ack: unknown): boolean => {
  if (error) return true;
  if (!record(ack) || ack['ok'] !== false || !record(ack['error'])) return false;
  const code = ack['error']['code'];
  return code === 'rate_limited' || code === 'temporarily_unavailable';
};
const retryDelay = (ack: PetAck<unknown> | undefined): number | null => {
  const delay = ack && !ack.ok ? ack.error?.retryAfterMs : undefined;
  if (delay === undefined) return 1000;
  // Refuse unusable timer values rather than overflow to a tight retry loop or
  // shorten a server-requested wait. Reconnect remains an explicit recovery.
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0 && delay <= 2_147_483_647 ? Math.max(1000, delay) : null;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const statuses: readonly string[] = ['accepted', 'generating', 'synthesizing', 'ready', 'playing', 'completed', 'cancelled', 'failed', 'expired'];
function requestView(value: unknown): value is PetRequestView {
  return record(value) && identifier(value['requestId']) && (value['operation'] === 'talk' || value['operation'] === 'ask' || value['operation'] === 'tts') &&
    typeof value['status'] === 'string' && statuses.includes(value['status']) && integer(value['version']);
}
function moodField(value: unknown): PetMood | undefined {
  try {
    if (!record(value) || value['mood'] === undefined) return undefined;
    const mood = value['mood'];
    if (typeof mood !== 'string') warnPetMood('metadata');
    return normalizePetMood(mood);
  } catch { warnPetMood('metadata'); return 'neutral'; }
}
function safeRequestMood(request: PetRequestView): PetRequestView {
  const mood = moodField(request);
  return { requestId: request.requestId, operation: request.operation, status: request.status, version: request.version,
    ...(request.text !== undefined ? { text: request.text } : {}), ...(request.errorCode !== undefined ? { errorCode: request.errorCode } : {}),
    ...(mood !== undefined ? { mood } : {}) };
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
      @for (attempt of [moodAttempt()]; track attempt) {
        @if (moodPreloadIdleUrl(); as url) { <img hidden class="pet-preload" [src]="url" alt="" referrerpolicy="no-referrer" (load)="moodImageLoaded(url, attempt)" (error)="moodImageFailed(url, attempt)" /> }
        @if (moodPreloadTalkingUrl(); as url) { <img hidden class="pet-preload" [src]="url" alt="" referrerpolicy="no-referrer" (load)="moodImageLoaded(url, attempt)" (error)="moodImageFailed(url, attempt)" /> }
      }

      @if (idleUrl(); as url) { <img class="pet-image" [class.visible]="!talking()" [src]="url" alt="" referrerpolicy="no-referrer" (load)="imageLoaded('idle', url)" (error)="imageFailed('idle', url)" /> }
      @if (talkingUrl(); as url) { <img class="pet-image" [class.visible]="talking()" [src]="url" alt="" referrerpolicy="no-referrer" (load)="imageLoaded('talking', url)" (error)="imageFailed('talking', url)" /> }
    }
    <span class="sr-only" role="status">{{ t(status()) }}</span>
    @if (status() === 'rendererAutoplay') { <button type="button" (click)="enableAudio()">{{ t('enableAudio') }}</button> }
  </main>`,
  styles: `:host { display:block; position:fixed; inset:0; background:transparent; color:#fff; font-family:'Plus Jakarta Sans',sans-serif } .pet-canvas { position:relative; width:100%; height:100%; overflow:hidden } .pet-image { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; visibility:hidden; pointer-events:none } .pet-image.visible { visibility:visible } .pet-preload { display:none !important } .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0 } button { position:absolute; bottom:1rem; left:1rem; max-width:calc(100% - 2rem); min-height:44px; border:1px solid #c4b5fd; border-radius:.75rem; padding:.7rem 1rem; background:#171a21; color:#fff; font:inherit; cursor:pointer } button:focus-visible { outline:3px solid #c4b5fd; outline-offset:3px }`
})
export class PetRuntimeComponent {
  private readonly document = inject(DOCUMENT);
  private readonly language = inject(LanguageService);
  private readonly base = inject(LinksService).getApiUrl().replace(/\/$/, '');
  private readonly capability = inject(ActivatedRoute).snapshot.paramMap.get('capability') ?? '';
  readonly state = signal<PetSnapshot | null>(null);
  readonly talking = signal(false);
  readonly status = signal('rendererConnecting');
  readonly mood = signal<PetMood>('neutral');
  private readonly moodDisplay = new PetMoodDisplay(mood => this.mood.set(mood));
  readonly idleUrl = computed(() => this.imageUrl('idle'));
  readonly talkingUrl = computed(() => this.imageUrl('talking'));
  private readonly loadedImages = new Set<string>();
  private readonly failedMoodUrls = signal<ReadonlySet<string>>(new Set());
  private readonly loadedMoodUrls = signal<ReadonlySet<string>>(new Set());
  readonly moodAttempt = signal(0);
  readonly moodPreloadIdleUrl = computed(() => this.moodImageCandidate('idle'));
  readonly moodPreloadTalkingUrl = computed(() => this.moodImageCandidate('talking'));
  private moodRequestId: string | null = null;
  private readonly follow = new PetFollowClock();
  private followMoodId: string | null = null;
  private followTimer?: ReturnType<typeof setTimeout>;
  private readonly player = new PetBrowserPlayer(report => this.onPlayback(report), (id, positionMs, value) => this.onMouth(id, positionMs, value), speaking => { if (!this.follow.live) this.talking.set(speaking); });
  private readonly socket: Socket = io(`${this.base}/pet`, { path: '/socket.io/', transports: ['websocket'],
    auth: { v: 1, capability: this.capability }, autoConnect: false, reconnection: false });
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private lease: PetLease | null = null;
  private leaseDeadline = 0;
  private leaseRetryAt = 0;
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
    this.socket.on('pet:follow', (value: unknown) => {
      const state = this.state();
      if (!state || !this.socket.connected || state.appearance.kind !== 'png' || this.active ||
        state.active && !['completed', 'cancelled', 'failed', 'expired'].includes(state.active.status)) return;
      if (this.follow.accept(value, state.generation)) {
        if (record(value) && typeof value['followId'] === 'string' && this.followMoodId !== value['followId']) {
          this.followMoodId = value['followId'];
          this.startMood(this.followMoodId, moodField(value));
        }
        this.tickFollow();
      }
    });
    this.socket.on('pet:follow-end', (value: unknown) => { if (this.follow.end(value)) { this.stopFollow(); this.talking.set(false); } });
    this.socket.on('pet:stop', (value: unknown) => {
      if (record(value) && value['v'] === 1 && value['generation'] === this.state()?.generation && identifier(value['requestId'])) {
        this.stopFollow();
        if (value['requestId'] === this.active?.requestId) this.stopPlayback(true);
        if (value['requestId'] === this.state()?.active?.requestId) this.talking.set(false);
      }
    });
    this.socket.on('connect', () => { this.moodRequestId = null; this.resetMoodImages(); this.moodDisplay.reset(); clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.stopFollow(); this.connection++; this.resetReady(); this.versions.clear(); this.state.set(null); this.status.set(this.audioReady ? 'rendererConnecting' : 'rendererAutoplay'); });
    this.socket.on('disconnect', () => {
      this.moodDisplay.reset(); this.stopFollow(); this.connection++; this.resetReady(); this.releaseLease(); this.state.set(null); this.status.set('rendererOffline');
      this.scheduleReconnect();
    });
    this.socket.on('connect_error', () => { this.stopFollow(); this.connection++; this.resetReady(); this.releaseLease(); this.status.set('rendererOffline'); this.scheduleReconnect(); });
    if (/^[a-zA-Z0-9_-]{43}$/.test(this.capability)) this.socket.connect();
    else this.status.set('rendererUnavailable');
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true; this.moodDisplay.reset(); clearTimeout(this.reconnectTimer); this.stopFollow(); this.connection++; this.releaseLease(); this.player.destroy(); this.socket.disconnect();
      doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; referrer.remove();
    });
  }

  t(key: string): string { return this.language.translate(`pet.${key}`); }
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    // A server namespace disconnect and an authentication rejection are not
    // retried by Socket.IO. One capped backoff handles those and transport loss.
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts++, 5) * (0.75 + Math.random() * 0.5), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.disposed && !this.socket.connected) this.socket.connect();
    }, delay);
  }
  private tickFollow(): void {
    clearTimeout(this.followTimer); this.followTimer = undefined;
    const sample = this.follow.sample(); this.talking.set(sample.talking);
    if (sample.ticking) this.followTimer = setTimeout(() => this.tickFollow(), 20);
  }
  private stopFollow(): void {
    const following = this.follow.live;
    if (this.followMoodId) this.moodDisplay.end(this.followMoodId);
    this.followMoodId = null;
    clearTimeout(this.followTimer); this.followTimer = undefined;
    this.follow.retire(); if (following) this.talking.set(false);
  }

  private moodImageCandidate(state: 'idle' | 'talking'): string {
    const snapshot = this.state(), mood = this.mood();
    const property = state === 'idle' ? 'idleUrl' : 'talkingUrl';
    if (snapshot?.moods?.available && snapshot.moods.enabled && mood !== 'neutral') {
      const url = this.assetUrl(snapshot.assets.moods?.[mood]?.[property]);
      if (url && !this.failedMoodUrls().has(url)) return url;
    }
    return '';
  }
  private imageUrl(state: 'idle' | 'talking'): string {
    const moodUrl = this.moodImageCandidate(state);
    if (moodUrl && this.loadedMoodUrls().has(moodUrl)) return moodUrl;
    return this.assetUrl(this.state()?.assets[state === 'idle' ? 'idleUrl' : 'talkingUrl']);
  }
  private resetMoodImages(): void {
    this.failedMoodUrls.set(new Set()); this.loadedMoodUrls.set(new Set());
    this.moodAttempt.update(attempt => attempt + 1);
  }
  moodImageLoaded(url: string, attempt: number): void {
    if (attempt === this.moodAttempt()) this.loadedMoodUrls.update(loaded => new Set([...loaded, url]));
  }
  moodImageFailed(url: string, attempt: number): void {
    if (attempt === this.moodAttempt()) this.imageFailed('idle', url);
  }

  private startMood(requestId: string, followMood?: unknown): void {
    const state = this.state(), request = state?.active;
    if (this.moodRequestId !== requestId) { this.moodRequestId = requestId; this.resetMoodImages(); }
    if (!state?.moods?.available || !state.moods.enabled) { this.moodDisplay.reset(); return; }
    this.moodDisplay.start(requestId, followMood ?? (request?.requestId === requestId ? request.mood : 'neutral'), state.moods.holdMs);
  }

  private assetUrl(raw: string | null | undefined): string {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) return '';
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
  imageLoaded(_kind: 'idle' | 'talking', url: string): void { this.loadedImages.add(url); this.ready(); }
  imageFailed(_kind: 'idle' | 'talking', url: string): void {
    this.loadedImages.delete(url);
    const state = this.state();
    const normalUrls = [this.assetUrl(state?.assets.idleUrl), this.assetUrl(state?.assets.talkingUrl)];
    if (!normalUrls.includes(url)) {
      // Mood images decorate an already-ready renderer. A missing file only changes
      // this state's image back to normal; it cannot affect audio or readiness.
      this.failedMoodUrls.update(failed => new Set([...failed, url]));
      this.loadedMoodUrls.update(loaded => new Set([...loaded].filter(value => value !== url)));
      warnPetMood('asset');
      return;
    }
    this.status.set('rendererImageError'); this.ready();
  }
  private resetReady(): void { this.readyEpoch++; this.readyAccepted = false; this.readyInFlight = false; this.readySignature = ''; }
  private ready(): void {
    const state = this.state();
    if (!state || !this.socket.connected) return;
    // Optional mood images must never revoke a renderer that loaded its normal PNGs.
    // Keep successful URLs across mood transitions, even while only one new state has loaded.
    const idleUrl = this.assetUrl(state.assets.idleUrl), talkingUrl = this.assetUrl(state.assets.talkingUrl);
    const renderReady = state.appearance.kind === 'vts' || !!idleUrl && !!talkingUrl &&
      this.loadedImages.has(idleUrl) && this.loadedImages.has(talkingUrl);
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
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.reconnectAttempts = 0;
    let decoration: ReturnType<typeof normalizePetMoodMetadata>;
    try { decoration = normalizePetMoodMetadata(input.moods, input.assets.moods); }
    catch { warnPetMood('metadata'); decoration = { moods: { available: false, enabled: false } }; }
    let value: PetSnapshot = { v: input.v, serverTime: input.serverTime, peerId: input.peerId,
      generation: input.generation, settingsRevision: input.settingsRevision, appearance: input.appearance, playback: input.playback,
      assets: { idleUrl: input.assets.idleUrl, talkingUrl: input.assets.talkingUrl, ...(decoration.assets ? { moods: decoration.assets } : {}) },
      active: input.active ? safeRequestMood(input.active) : null, lease: input.lease,
      ...(decoration.moods ? { moods: decoration.moods } : {}) };
    const previous = this.state();
    if (previous && (value.generation === previous.generation && value.serverTime < previous.serverTime || value.generation < previous.generation || value.generation === previous.generation && value.settingsRevision < previous.settingsRevision)) return;
    if (!previous || previous.generation !== value.generation || previous.settingsRevision !== value.settingsRevision || previous.peerId !== value.peerId) { this.stopFollow(); this.follow.reset(value.generation); }
    if (previous && (previous.generation !== value.generation || previous.peerId !== value.peerId)) { this.resetReady(); this.releaseLease(); this.versions.clear(); }
    if (previous && previous.settingsRevision !== value.settingsRevision) this.resetMoodImages();
    const incoming = value.active;
    if (previous?.generation === value.generation && incoming && incoming.version < (this.versions.get(incoming.requestId) ?? -1)) value = { ...value, active: previous.active };
    this.clock = { serverTime: value.serverTime, receivedAt: performance.now() };
    this.state.set(value);
    if (!value.moods?.available || !value.moods.enabled || previous && previous.settingsRevision !== value.settingsRevision) this.moodDisplay.reset();
    if (value.active) this.versions.set(value.active.requestId, Math.max(value.active.version, this.versions.get(value.active.requestId) ?? -1));
    while (this.versions.size > 128) this.versions.delete(this.versions.keys().next().value!);
    if (value.playback.target !== 'browser' || value.lease && value.lease.holderPeerId !== value.peerId ||
      this.lease && (!value.lease || value.lease.leaseId !== this.lease.leaseId)) this.releaseLease();
    if (value.active && !['completed', 'cancelled', 'failed', 'expired'].includes(value.active.status)) this.stopFollow();
    if (!this.active && !this.follow.live) this.talking.set(value.active?.status === 'playing');
    this.ready();
  }
  private acceptRequest(value: unknown): void {
    const state = this.state();
    if (!state || !record(value) || value['v'] !== 1 || value['generation'] !== state.generation || !requestView(value['request'])) return;
    const request = safeRequestMood(value['request']);
    if (state.active && state.active.requestId !== request.requestId && !['completed', 'cancelled', 'failed', 'expired'].includes(state.active.status)) return;
    if ((this.versions.get(request.requestId) ?? -1) >= request.version) return;
    this.versions.set(request.requestId, request.version);
    while (this.versions.size > 128) this.versions.delete(this.versions.keys().next().value!);
    this.state.set({ ...state, active: request });
    this.stopFollow();
    if (!this.active) this.talking.set(request.status === 'playing');
    if (['completed', 'cancelled', 'failed', 'expired'].includes(request.status)) {
      this.moodDisplay.end(request.requestId);
      if (this.active?.requestId === request.requestId) this.stopPlayback(false);
    }
  }

  private acquireLease(): void {
    const state = this.state();
    if (!state || this.disposed || performance.now() < this.leaseRetryAt || !this.socket.connected || state.playback.target !== 'browser' || !this.audioReady || !this.readyAccepted || this.readyInFlight || this.lease || this.acquiring ||
      state.lease && state.lease.holderPeerId !== state.peerId) return;
    this.acquiring = true;
    const connection = this.connection, generation = state.generation, sentAt = performance.now(), attempt = ++this.leaseAttempt;
    this.socket.timeout(4000).emit('pet:lease', { v: 1, action: 'acquire' }, (error: Error | null, ack: PetAck<PetLease>) => {
      if (connection !== this.connection || this.disposed || generation !== this.state()?.generation || attempt !== this.leaseAttempt) return;
      this.acquiring = false;
      if (!error && this.acceptLease(ack, sentAt)) return;
      if (transientAck(error, ack) || ack && !ack.ok && ack.error?.code === 'lease_unavailable') {
        const delay = retryDelay(ack); this.retryAcquisition(delay === null ? null : Math.max(5000, delay));
      }
    });
  }
  private retryAcquisition(delay: number | null): void {
    const state = this.state();
    if (this.disposed || !this.socket.connected || !this.audioReady || !this.readyAccepted || state?.playback.target !== 'browser') return;
    clearTimeout(this.acquireRetry);
    this.leaseRetryAt = delay === null ? Infinity : performance.now() + delay;
    if (delay !== null) this.acquireRetry = setTimeout(() => this.acquireLease(), delay);
  }
  private expireLease(): void {
    // Expiry always stops old audio. Re-election only makes later requests available.
    const delay = Number.isFinite(this.leaseRetryAt) ? Math.max(1000, this.leaseRetryAt - performance.now()) : null;
    this.releaseLease(); this.retryAcquisition(delay);
  }
  private acceptLease(ack: PetAck<PetLease>, sentAt: number, expected?: PetLease): boolean {
    if (!record(ack) || ack['ok'] !== true || !record(ack['data'])) return false;
    const lease = ack['data'];
    if (expected && (lease['leaseId'] !== expected.leaseId || lease['generation'] !== expected.generation) ||
      !identifier(lease['leaseId']) || lease['generation'] !== this.state()?.generation || !integer(lease['ttlMs']) || lease['ttlMs'] < 1000 || lease['ttlMs'] > 15_000 ||
      !integer(lease['expiresAt']) || !integer(lease['serverTime']) || lease['expiresAt'] <= lease['serverTime'] || this.state()?.playback.target !== 'browser') return false;
    const ttl = Math.min(lease['ttlMs'], lease['expiresAt'] - lease['serverTime']) - 500;
    const remaining = sentAt + ttl - performance.now();
    if (remaining <= 0) return false;
    this.lease = lease as unknown as PetLease; this.leaseRetryAt = 0;
    this.clock = { serverTime: lease['serverTime'], receivedAt: performance.now() };
    // Use a monotonic local deadline. Never let a late renewal revive an expired local lease.
    this.leaseDeadline = sentAt + ttl;
    clearTimeout(this.leaseExpiry); clearTimeout(this.renewal);
    this.leaseExpiry = setTimeout(() => this.expireLease(), remaining);
    this.renewal = setTimeout(() => this.renewLease(), Math.min(5000, Math.floor(remaining / 2)));
    return true;
  }
  private renewLease(): void {
    const lease = this.lease, connection = this.connection, sentAt = performance.now();
    if (!lease) return;
    if (performance.now() >= this.leaseDeadline) { this.expireLease(); return; }
    this.socket.timeout(4000).emit('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation }, (error: Error | null, ack: PetAck<PetLease>) => {
      if (this.disposed || connection !== this.connection || this.lease !== lease) return;
      if (performance.now() >= this.leaseDeadline) { this.expireLease(); return; }
      if (transientAck(error, ack)) {
        // ACK loss is not revocation. Keep the last confirmed deadline unchanged;
        // the independent expiry timer still stops speech if renewal never recovers.
        clearTimeout(this.renewal);
        const delay = retryDelay(ack); this.leaseRetryAt = delay === null ? Infinity : performance.now() + delay;
        if (delay !== null) this.renewal = setTimeout(() => this.renewLease(), delay);
      } else if (!this.acceptLease(ack, sentAt, lease)) this.releaseLease();
    });
  }
  private releaseLease(): void {
    clearTimeout(this.leaseExpiry); clearTimeout(this.renewal); clearTimeout(this.acquireRetry);
    this.acquiring = false; this.leaseAttempt++;
    this.stopPlayback(false);
    this.lease = null; this.leaseDeadline = 0; this.leaseRetryAt = 0;
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
    this.stopFollow();
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
    if (report.state === 'started') { this.startMood(report.id); this.status.set('rendererReady'); }
    if (report.state === 'error') this.status.set(report.error === 'autoplay_blocked' ? 'rendererAutoplay' : 'rendererAudioError');
    if (report.state === 'ended' || report.state === 'error') { this.moodDisplay.end(report.id); this.active = null; this.talking.set(false); }
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
      if (error || !record(ack) || ack['ok'] !== true) {
        // Dropped progress telemetry does not revoke a live playback lease.
        if (progress && this.owns(active) && transientAck(error, ack)) return;
        this.releaseLease(); this.status.set('rendererAudioError');
      }
    });
  }
  private stopPlayback(report: boolean): void {
    const active = this.active;
    if (active) this.moodDisplay.end(active.requestId);
    this.active = null; this.progressInFlight = false; this.player.reset(); if (!this.follow.live) this.talking.set(false);
    if (report && active && this.owns(active)) this.emitPlayback(active, { v: 1, requestId: active.requestId, leaseId: active.leaseId,
      generation: active.generation, seq: ++this.sequence, phase: 'stopped', positionMs: 0 });
  }
  async enableAudio(): Promise<void> {
    // A gesture unlocks this renderer's audio context; a failed speech is never replayed.
    try { await this.player.unlock(); if (this.disposed) return; this.audioReady = true; this.status.set('rendererReady'); this.ready(); }
    catch { this.status.set('rendererAutoplay'); }
  }
}
