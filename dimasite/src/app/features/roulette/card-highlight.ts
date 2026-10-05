/** Cosmetic randomness is seeded by the draw so every overlay/reconnect agrees. */
function seeded(drawId: string): () => number {
  let seed = 2166136261;
  for (const char of drawId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return () => {
    seed += 0x6d2b79f5;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function cardSequence(drawId: string, count: number, durationMs: number): number[] {
  if (count < 1) return [];
  const random = seeded(drawId);
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
/** Last one standing: every slot except the saved winner, in the order they get knocked out. */
export function eliminationOrder(drawId: string, count: number, winner: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i).filter((i) => i !== winner);
  const random = seeded(drawId);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
/**
 * How many slots are out at this point of the draw. Most fall fast, the final few
 * slowly; everyone but the winner is out shortly before the end so the reveal can breathe.
 */
export function eliminatedCount(losers: number, progress: number): number {
  if (losers < 1 || progress <= 0) return 0;
  if (progress >= 0.9) return losers;
  const eased = 1 - Math.pow(1 - progress / 0.9, 2.4);
  return Math.min(losers, Math.floor(eased * losers + 0.0001));
}
/** Where inside the winning wheel segment the pointer stops (−0.35…0.35 of a segment). */
export function landingOffset(drawId: string): number {
  return (seeded(`${drawId}:land`)() - 0.5) * 0.7;
}
