import { simulateBattle, type DuelBattle } from '../widgets/duel/duel-battle';
import { seededRandom } from './demo-scene';

/** Time the winner stays on screen after the knockout. */
export const DUEL_TAIL_MS = 1800;
/** Promo duels stay short: re-roll (same seed sequence) until one fits. */
const MAX_DUEL_MS = 18000;
const cache = new Map<number, DuelBattle>();

/** The same seeded battle every time, so the scene length and every frame are repeatable. */
export function demoBattle(seed: number): DuelBattle {
  let battle = cache.get(seed);
  if (battle) return battle;
  const random = seededRandom(seed);
  battle = simulateBattle(random);
  for (let i = 0; i < 25 && battle.duration > MAX_DUEL_MS; i++) battle = simulateBattle(random);
  cache.set(seed, battle);
  return battle;
}

export const demoDuelDuration = ({ seed }: { seed: number }) => demoBattle(seed).duration + DUEL_TAIL_MS;
