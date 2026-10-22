/** Browser media lifecycle. Transport and server-owned queue/assignment stay outside this class. */
export interface BrowserPetSpeech {
  id: string;
  url: string;
  startBefore: number;
  maxDurationMs: number;
}
export type BrowserPetPlaybackState = 'ready' | 'started' | 'ended' | 'error';
export interface BrowserPetPlaybackReport {
  id: string;
  state: BrowserPetPlaybackState;
  positionMs: number;
  error?: 'media_error' | 'autoplay_blocked' | 'expired' | 'timeout';
}
interface ActiveSpeech {
  speech: BrowserPetSpeech;
  ready: boolean;
  starting: boolean;
  started: boolean;
  cleanup: () => void;
}
const MAX_DURATION_MS = 60_000;

export class PetBrowserPlayer {
  private readonly audio: HTMLAudioElement;
  private active: ActiveSpeech | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private mouthTimer?: ReturnType<typeof setInterval>;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private readonly seen = new Set<string>();
  private disposed = false;
  private contextTransition: Promise<void> = Promise.resolve();

  constructor(private readonly report: (event: BrowserPetPlaybackReport) => void,
    private readonly mouth: (id: string, positionMs: number, value: number) => void,
    private readonly speaking: (value: boolean) => void) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
  }

  /** A repeated or competing delivery is never queued or replayed locally. */
  prepare(speech: BrowserPetSpeech): boolean {
    if (this.disposed || this.active || this.seen.has(speech.id) || !speech.id || speech.id.length > 128 ||
      !Number.isFinite(speech.startBefore) || speech.startBefore <= Date.now() ||
      !Number.isFinite(speech.maxDurationMs) || speech.maxDurationMs <= 0 || speech.maxDurationMs > MAX_DURATION_MS) return false;
    this.seen.add(speech.id);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    const onReady = () => {
      const active = this.active;
      if (!active || active.speech !== speech || active.ready) return;
      if (speech.startBefore <= Date.now()) { this.fail('expired'); return; }
      if (Number.isFinite(this.audio.duration) && this.audio.duration * 1000 > MAX_DURATION_MS + 1000) { this.fail('media_error'); return; }
      active.ready = true;
      this.armStartDeadline();
      this.report({ id: speech.id, state: 'ready', positionMs: 0 });
    };
    const onError = () => this.fail('media_error');
    const onEnded = () => this.finish();
    const onWaiting = () => this.speaking(false);
    const onPlaying = () => { if (this.active?.started) this.speaking(true); };
    this.audio.addEventListener('canplay', onReady);
    this.audio.addEventListener('error', onError);
    this.audio.addEventListener('ended', onEnded);
    this.audio.addEventListener('waiting', onWaiting);
    this.audio.addEventListener('playing', onPlaying);
    this.active = { speech, ready: false, starting: false, started: false, cleanup: () => {
      this.audio.removeEventListener('canplay', onReady);
      this.audio.removeEventListener('error', onError);
      this.audio.removeEventListener('ended', onEnded);
      this.audio.removeEventListener('waiting', onWaiting);
      this.audio.removeEventListener('playing', onPlaying);
    } };
    this.audio.src = speech.url;
    this.audio.load();
    this.timer = setTimeout(() => this.fail(speech.startBefore <= Date.now() ? 'expired' : 'timeout'), Math.min(10_000, speech.startBefore - Date.now()));
    return true;
  }

  /** Only an explicit server play command can start a prepared, unexpired item. */
  async start(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.speech.id !== id || !active.ready || active.starting || active.started) return;
    if (active.speech.startBefore <= Date.now()) { this.fail('expired'); return; }
    active.starting = true;
    try {
      this.prepareAnalysis();
      await this.contextTransition;
      if (this.active !== active) return;
      if (active.speech.startBefore <= Date.now()) { this.fail('expired'); return; }
      await Promise.all([this.resumeContext(), this.audio.play()]);
      if (this.active !== active) return;
      if (active.speech.startBefore <= Date.now()) { this.fail('expired'); return; }
      active.started = true;
      this.speaking(true);
      this.report({ id, state: 'started', positionMs: this.position() });
      this.mouthTimer = setInterval(() => this.sampleMouth(), 100);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail('timeout'), active.speech.maxDurationMs + 2000);
    } catch (error) {
      if (this.active === active) this.fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'autoplay_blocked' : 'media_error');
    }
  }

  async unlock(): Promise<void> {
    this.prepareAnalysis();
    await this.contextTransition;
    await this.resumeContext();
  }

  private async resumeContext(): Promise<void> {
    if (this.context?.state !== 'suspended') return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.context.resume(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new DOMException('Audio requires a gesture', 'NotAllowedError')), 1000);
      })]);
    } finally { clearTimeout(timeout); }
  }

  private prepareAnalysis(): void {
    if (this.context) return;
    // One reusable media source per element; close it only when the renderer is destroyed.
    this.context = new AudioContext();
    const source = this.context.createMediaElementSource(this.audio);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.samples = new Uint8Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
  }

  private sampleMouth(): void {
    const active = this.active;
    if (!active?.started || this.audio.paused || this.audio.ended || !this.analyser || !this.samples) return;
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += ((sample - 128) / 128) ** 2;
    const value = Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
    this.mouth(active.speech.id, this.position(), Math.round(value * 1000) / 1000);
  }

  private position(): number { return Math.min(MAX_DURATION_MS, Math.max(0, Math.round((this.audio.currentTime || 0) * 1000))); }
  private armStartDeadline(): void {
    clearTimeout(this.timer);
    if (this.active) this.timer = setTimeout(() => this.fail('expired'), Math.max(0, this.active.speech.startBefore - Date.now()));
  }
  private finish(): void {
    const active = this.active;
    if (!active) return;
    const positionMs = this.position();
    this.reset();
    this.report({ id: active.speech.id, state: 'ended', positionMs });
  }
  private fail(error: BrowserPetPlaybackReport['error']): void {
    const active = this.active;
    if (!active) return;
    const positionMs = this.position();
    this.reset();
    this.report({ id: active.speech.id, state: 'error', positionMs, error });
  }
  reset(): void {
    const previous = this.active;
    this.active = null;
    clearTimeout(this.timer); clearInterval(this.mouthTimer);
    previous?.cleanup();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.speaking(false);
    const context = this.context;
    if (context) this.contextTransition = this.contextTransition.then(() => context.state === 'running' ? context.suspend() : undefined).catch(() => {});
  }
  destroy(): void {
    this.disposed = true;
    this.reset();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null; this.analyser = null; this.samples = null;
  }
}
