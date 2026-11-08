import { MAX_HP, simulateBattle, type DuelBattle } from '../widgets/duel/duel-battle';
import { DUEL_TAIL_MS, seededRandom } from './demo-scene';
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

/** Who won and with how much HP, replaying the turns exactly like the duel overlay does. */
export function duelOutcome(battle: DuelBattle, names: { left: string; right: string }) {
  const max = battle.maxHp ?? MAX_HP, health = { left: max, right: max };
  for (const turn of battle.turns) {
    if (turn.move === 'heal') { health[turn.attacker] = Math.min(max, health[turn.attacker] + (turn.heal ?? 0)); continue; }
    const defender = turn.attacker === 'left' ? 'right' : 'left';
    health[defender] = Math.max(0, health[defender] - turn.damage);
    if (turn.comboHeal) health[defender] = Math.min(max, health[defender] + turn.comboHeal);
  }
  const loser = battle.winner === 'left' ? 'right' : 'left';
  return { winner: names[battle.winner], loser: names[loser], hp: health[battle.winner] };
}
