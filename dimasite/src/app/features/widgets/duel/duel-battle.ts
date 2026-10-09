// Mirrors dimabot/src/duel/model.ts. Live duels always use the server's battle;
// this copy only drives local previews, so keep the numbers in step.
export type DuelSide = 'left' | 'right';
export type DuelMove = 'normal' | 'heavy' | 'special';
export type DuelCharacter = 'knight' | 'ronin' | 'mage';
/**
 * Offsets are milliseconds from the start of the duel; hitAt is when damage (or healing)
 * lands. raw is the base roll, crit doubles it, a defense skill then reduces it; damage
 * is what landed. A 'heal' turn restores `heal` HP to the acting fighter instead.
 */
export interface DuelTurn { at: number; hitAt: number; attacker: DuelSide; move: DuelMove | 'heal'; damage: number; raw?: number; crit?: boolean; defended?: boolean; heal?: number; bonus: boolean }
export interface DuelBattle { fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; winner: DuelSide; duration: number }

export const MAX_HP = 100;
export const FIGHT_START_MS = 3700;
export const KNOCKOUT_MS = 1900;
const EXTRA_TURN_PERCENT = 15;
const EXTRA_TURN_LEAD_MS = 250;
const DEFENSE_PERCENT = 15;
const HEAVY_DEFENDED_RATIO = 0.2;
const CRIT_PERCENT = 10;
export const HEAL = { percent: 12, threshold: 60, min: 15, max: 25, perFighter: 3, windup: 900, duration: 1500 };
const SKILL_TURN_LIMIT = 24;
export const MOVES: Record<DuelMove, { chance: number; min: number; max: number; windup: number; duration: number }> = {
  normal: { chance: 68, min: 10, max: 16, windup: 280, duration: 800 },
  heavy: { chance: 24, min: 18, max: 26, windup: 450, duration: 1050 },
  special: { chance: 8, min: 30, max: 40, windup: 850, duration: 1600 }
};
export const CHARACTERS: DuelCharacter[] = ['knight', 'ronin', 'mage'];
/** Windup/duration for any turn, heals included. */
export const timing = (move: DuelMove | 'heal') => move === 'heal' ? HEAL : MOVES[move];
export const otherSide = (side: DuelSide): DuelSide => side === 'left' ? 'right' : 'left';

export function simulateBattle(random: () => number = Math.random): DuelBattle {
  const roll = (max: number) => Math.min(max - 1, Math.floor(random() * max));
  const left = CHARACTERS[roll(CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  const fighters = { left, right: rest[roll(rest.length)] };
  const hp: Record<DuelSide, number> = { left: MAX_HP, right: MAX_HP }, turns: DuelTurn[] = [];
  let attacker: DuelSide = roll(2) === 0 ? 'left' : 'right', at = FIGHT_START_MS, bonus = false;
  const heals: Record<DuelSide, number> = { left: 0, right: 0 };
  for (;;) {
    const skills = turns.length < SKILL_TURN_LIMIT, defender = otherSide(attacker);
    if (skills && hp[attacker] <= HEAL.threshold && heals[attacker] < HEAL.perFighter && roll(100) < HEAL.percent) {
      const heal = Math.min(MAX_HP - hp[attacker], HEAL.min + roll(HEAL.max - HEAL.min + 1));
      hp[attacker] += heal; heals[attacker]++;
      turns.push({ at, hitAt: at + HEAL.windup, attacker, move: 'heal', damage: 0, raw: 0, crit: false, defended: false, heal, bonus });
      at += HEAL.duration;
    } else {
      const chance = roll(100), move: DuelMove = chance < MOVES.special.chance ? 'special' : chance < MOVES.special.chance + MOVES.heavy.chance ? 'heavy' : 'normal';
      const spec = MOVES[move], raw = spec.min + roll(spec.max - spec.min + 1);
      const critical = roll(100) < CRIT_PERCENT, hit = critical ? raw * 2 : raw;
      const defended = move !== 'special' && skills && roll(100) < DEFENSE_PERCENT;
      const damage = !defended ? hit : move === 'heavy' ? Math.round(hit * HEAVY_DEFENDED_RATIO) : 0;
      hp[defender] = Math.max(0, hp[defender] - damage);
      turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, crit: critical && damage > 0, defended, heal: 0, bonus });
      if (hp[defender] === 0) return { fighters, turns, winner: attacker, duration: at + spec.windup + KNOCKOUT_MS };
      at += spec.duration;
    }
    bonus = roll(100) < EXTRA_TURN_PERCENT;
    if (bonus) at += EXTRA_TURN_LEAD_MS; else attacker = defender;
  }
}

/** Duels accepted before turn-based battles only stored a winner and lasted 11.4s. */
export function legacyBattle(winner: DuelSide): DuelBattle {
  const loser = otherSide(winner), plan: [DuelSide, DuelMove, number][] = [[winner, 'normal', 18], [loser, 'heavy', 22], [winner, 'normal', 24], [loser, 'normal', 19], [winner, 'heavy', 26], [winner, 'special', 32]];
  const turns = plan.map(([attacker, move, damage], index) => ({ at: 3600 + index * 1050, hitAt: 3600 + index * 1050 + MOVES[move].windup, attacker, move, damage, bonus: index > 0 && plan[index - 1][0] === attacker }));
  return { fighters: { left: 'knight', right: 'knight' }, turns, winner, duration: 11400 };
}
