/** Cosmetic randomness is seeded by the draw so every overlay/reconnect agrees. */
export function cardSequence(drawId: string, count: number, durationMs: number): number[] {
  if (count < 1) return [];
  let seed = 2166136261;
  for (const char of drawId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const random = () => {
    seed += 0x6d2b79f5;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const sequence = [Math.floor(random() * count)];
  for (let i = 1; i < Math.max(6, Math.ceil(durationMs / 125)); i++) {
    const previous = sequence[i - 1];
    const pick = Math.floor(random() * Math.max(1, count - 1));
    sequence.push(count === 1 ? 0 : pick >= previous ? pick + 1 : pick);
  }
  return sequence;
}
export function cardHighlight(sequence: number[], progress: number, winner: number): number {
  if (progress >= 1) return winner;
  // Quick scattered hops ease down to a few deliberate highlights at the end.
  const step = Math.floor((1 - Math.pow(1 - Math.max(0, progress), 1.8)) * sequence.length);
  return sequence[Math.min(step, sequence.length - 1)] ?? -1;
}
