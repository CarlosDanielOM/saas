import { normalizePetMood, type PetMood } from '../../models/pet-moods.model';

/** Only actual playback starts an expression. There is no timer while idle or speaking. */
export class PetMoodDisplay {
  private requestId: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private holdMs = 0;
  private shown = false;
  constructor(private readonly changed: (mood: PetMood) => void) {}

  start(requestId: string, mood: unknown, holdMs: number): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.requestId = requestId;
    this.holdMs = Number.isSafeInteger(holdMs) && holdMs >= 0 && holdMs <= 10_000 ? holdMs : 2000;
    const normalized = normalizePetMood(mood);
    this.shown = normalized !== 'neutral';
    this.changed(normalized);
  }
  end(requestId: string): void {
    if (requestId !== this.requestId) return;
    this.requestId = null;
    if (!this.holdMs || !this.shown) { this.reset(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.changed('neutral'); }, this.holdMs);
  }
  reset(): void {
    clearTimeout(this.timer); this.timer = undefined; this.requestId = null;
    this.changed('neutral');
  }
}
