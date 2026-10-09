// Mirrors dimabot/src/duel/model.ts. Live duels always use the server's battle;
// this copy only drives local previews, so keep the numbers in step.
export type DuelSide = 'left' | 'right';
export type DuelMove = 'normal' | 'heavy' | 'special';
export type DuelCharacter = 'knight' | 'ronin' | 'mage';
/** Offsets are milliseconds from the start of the duel. hitAt is when damage lands.
 * damage is what landed; raw is the roll before the defender's skill. */
export interface DuelTurn { at: number; hitAt: number; attacker: DuelSide; move: DuelMove; damage: number; raw?: number; defended?: boolean; bonus: boolean }
export interface DuelBattle { fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; winner: DuelSide; duration: number }

export const MAX_HP = 100;
export const FIGHT_START_MS = 3700;
export const KNOCKOUT_MS = 1900;
const EXTRA_TURN_PERCENT = 15;
const EXTRA_TURN_LEAD_MS = 250;
const DEFENSE_PERCENT = 15;
const HEAVY_DEFENDED_RATIO = 0.2;
const DEFENSE_TURN_LIMIT = 24;
export const MOVES: Record<DuelMove, { chance: number; min: number; max: number; windup: number; duration: number }> = {
  normal: { chance: 68, min: 10, max: 16, windup: 280, duration: 800 },
  heavy: { chance: 24, min: 18, max: 26, windup: 450, duration: 1050 },
  special: { chance: 8, min: 30, max: 40, windup: 850, duration: 1600 }
};
export const CHARACTERS: DuelCharacter[] = ['knight', 'ronin', 'mage'];
export const otherSide = (side: DuelSide): DuelSide => side === 'left' ? 'right' : 'left';

export function simulateBattle(random: () => number = Math.random): DuelBattle {
  const roll = (max: number) => Math.min(max - 1, Math.floor(random() * max));
  const left = CHARACTERS[roll(CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  const fighters = { left, right: rest[roll(rest.length)] };
  const hp: Record<DuelSide, number> = { left: MAX_HP, right: MAX_HP }, turns: DuelTurn[] = [];
  let attacker: DuelSide = roll(2) === 0 ? 'left' : 'right', at = FIGHT_START_MS, bonus = false;
  for (;;) {
    const chance = roll(100), move: DuelMove = chance < MOVES.special.chance ? 'special' : chance < MOVES.special.chance + MOVES.heavy.chance ? 'heavy' : 'normal';
    const spec = MOVES[move], raw = spec.min + roll(spec.max - spec.min + 1), defender = otherSide(attacker);
    const defended = move !== 'special' && turns.length < DEFENSE_TURN_LIMIT && roll(100) < DEFENSE_PERCENT;
    const damage = !defended ? raw : move === 'heavy' ? Math.round(raw * HEAVY_DEFENDED_RATIO) : 0;
    hp[defender] = Math.max(0, hp[defender] - damage);
    turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, defended, bonus });
    if (hp[defender] === 0) return { fighters, turns, winner: attacker, duration: at + spec.windup + KNOCKOUT_MS };
    at += spec.duration;
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
