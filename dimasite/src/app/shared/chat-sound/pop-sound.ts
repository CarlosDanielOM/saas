/**
 * The chat-message pop from the demo videos (marketing/video/lib/sfx.mjs `KIT.pop`), made in the browser from the
 * same formula, so OBS plays exactly what the videos play and there is no audio file to host or license:
 * 0.5 · sin(2π · (480 + 820·e^(−36t)) · t) · e^(−26t), 0.18 s.
 */
export const POP_SECONDS = 0.18;
export const popSample = (t: number): number => 0.5 * Math.sin(2 * Math.PI * (480 + 820 * Math.exp(-t * 36)) * t) * Math.exp(-t * 26);
export function popSamples(sampleRate: number): Float32Array {
  const samples = new Float32Array(Math.round(POP_SECONDS * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = popSample(i / sampleRate);
  return samples;
}

/** What the page can do with sound right now (reported to the server; the settings page explains it). */
export type PopAudioState = 'running' | 'suspended' | 'blocked' | 'unsupported';
type AudioContextCtor = typeof AudioContext;

/** One AudioContext per page; overlapping pops are fine (each is its own short source). */
export class PopPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private failed = false;
  private readonly Ctor: AudioContextCtor | undefined;
  constructor(win: { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor } | null = typeof window === 'undefined' ? null : window as never) {
    this.Ctor = win?.AudioContext ?? win?.webkitAudioContext;
  }
  private ensure(): AudioContext | null {
    if (this.context || this.failed || !this.Ctor) return this.context;
    try {
      this.context = new this.Ctor();
      const samples = popSamples(this.context.sampleRate);
      this.buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
      this.buffer.getChannelData(0).set(samples);
      this.context.onstatechange = () => this.changed?.(this.state());
    } catch { this.failed = true; this.context = null; }
    return this.context;
  }
  /** Called with the new state whenever the browser starts or stops our audio. */
  changed: ((state: PopAudioState) => void) | null = null;
  state(): PopAudioState {
    if (!this.Ctor || this.failed) return 'unsupported';
    const state = this.ensure()?.state;
    return state === 'running' ? 'running' : state === 'suspended' ? 'suspended' : state ? 'blocked' : 'unsupported';
  }
  /** Ask the browser to start audio (OBS allows it on its own; a normal tab needs a click first). */
  async unlock(): Promise<PopAudioState> {
    const context = this.ensure();
    if (context?.state === 'suspended') { try { await context.resume(); } catch { /* still suspended */ } }
    return this.state();
  }
  /**
   * Plays one pop at `volume` (0-100). Returns false when the browser has not started audio: the pop is dropped,
   * never queued, so a page that is allowed to play later does not burst out old pops.
   */
  play(volume: number): boolean {
    const context = this.ensure();
    if (!context || !this.buffer) return false;
    if (context.state !== 'running') { void context.resume().catch(() => {}); return false; }
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(100, volume)) / 100;
    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(gain).connect(context.destination);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start();
    return true;
  }
  close(): void { void this.context?.close().catch(() => {}); this.context = null; this.buffer = null; }
}
