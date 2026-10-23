/** Audio-free, monotonic image clock shared by all PNG follow packets. */
export interface PetFollow {
  v: 1;
  followId: string;
  generation: number;
  envelope?: { stepMs: number; values: number[] };
  positionMs: number;
  serverTime: number;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function valid(value: unknown): value is PetFollow {
  if (!record(value) || value['v'] !== 1 || !identity(value['followId']) || !integer(value['generation']) ||
    typeof value['serverTime'] !== 'number' || !Number.isFinite(value['serverTime']) || value['serverTime'] < 0 || value['serverTime'] > Number.MAX_SAFE_INTEGER ||
    typeof value['positionMs'] !== 'number' || !Number.isFinite(value['positionMs']) || value['positionMs'] < 0 || value['positionMs'] > 60_000) return false;
  const envelope = value['envelope'];
  return envelope === undefined || record(envelope) && integer(envelope['stepMs']) && envelope['stepMs'] >= 20 && envelope['stepMs'] <= 100 &&
    Array.isArray(envelope['values']) && envelope['values'].length > 0 && envelope['values'].length <= 1500 && envelope['values'].length * envelope['stepMs'] <= 60_000 &&
    envelope['values'].every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
}
export class PetFollowClock {
  private current: (PetFollow & { envelope: NonNullable<PetFollow['envelope']>; receivedAt: number }) | null = null;
  private generation = -1;
  private watermark = -1;
  private readonly retired = new Set<string>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(generation: number): void {
    this.retire();
    if (generation > this.generation) { this.generation = generation; this.watermark = -1; this.retired.clear(); }
  }
  retire(): void {
    if (this.current) this.remember(this.current.followId);
    this.current = null;
  }
  private remember(id: string): void {
    this.retired.add(id);
    while (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!);
  }
  accept(input: unknown, generation: number): boolean {
    if (!valid(input) || input.generation !== generation || generation < this.generation) return false;
    if (generation > this.generation) this.reset(generation);
    const previous = this.current;
    if (this.retired.has(input.followId) || input.serverTime < this.watermark) return false;
    if (previous?.followId === input.followId) {
      // Duplicate/non-advancing reports cannot refresh the stall deadline.
      if (input.serverTime < previous.serverTime || input.positionMs < previous.positionMs) return false;
      if (input.envelope && (input.envelope.stepMs !== previous.envelope.stepMs || input.envelope.values.length !== previous.envelope.values.length ||
        input.envelope.values.some((n, i) => n !== previous.envelope.values[i]))) return false;
      if (input.positionMs === previous.positionMs) {
        previous.serverTime = input.serverTime; this.watermark = input.serverTime; return false;
      }
    } else if (!input.envelope) return false;
    const envelope = input.envelope ?? previous!.envelope;
    if (previous && previous.followId !== input.followId) this.retire();
    this.watermark = input.serverTime;
    this.current = { ...input, envelope, receivedAt: this.now() };
    return true;
  }
  end(input: unknown): boolean {
    if (!record(input) || input['v'] !== 1 || !identity(input['followId']) || !integer(input['generation']) ||
      input['generation'] !== this.generation) return false;
    if (input['followId'] !== this.current?.followId) { this.remember(input['followId']); return false; }
    this.retire(); return true;
  }
  sample(): { talking: boolean; ticking: boolean } {
    const current = this.current;
    if (!current) return { talking: false, ticking: false };
    const elapsed = Math.max(0, this.now() - current.receivedAt), position = current.positionMs + elapsed;
    if (elapsed > 1000 || position >= current.envelope.values.length * current.envelope.stepMs) return { talking: false, ticking: false };
    return { talking: current.envelope.values[Math.floor(position / current.envelope.stepMs)] > .08, ticking: true };
  }
  get live(): boolean { return this.current !== null; }
}
