// Mirrors dimabot/src/duel/model.ts. Live duels always use the server's battle;
// this copy only drives local previews, so keep the numbers in step.
import { DEFAULT_DUEL_RULES, DuelRules } from './duel-rules';
export type DuelSide = 'left' | 'right';
export type DuelMove = 'normal' | 'heavy' | 'special';
export type DuelCharacter = 'knight' | 'ronin' | 'mage';
/**
 * Offsets are milliseconds from the start of the duel; hitAt is when damage (or healing)
 * lands. raw is the base roll, crit doubles it, a defense skill then reduces it (specials
 * break through a defense); damage is what landed. A 'heal' turn restores `heal` HP to the
 * acting fighter instead. comboHeal is HP the defender regains right after blocking.
 */
export interface DuelTurn { at: number; hitAt: number; attacker: DuelSide; move: DuelMove | 'heal' | 'ultimate'; damage: number; raw?: number; crit?: boolean; defended?: boolean; heal?: number; comboHeal?: number; bonus: boolean }
/**
 * enraged is the streamer's side, which fights with boosted odds. maxHp and healCharges
 * come from the channel's battle rules (100 and 5 when missing).
 */
export interface DuelBattle { fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; winner: DuelSide; duration: number; enraged?: DuelSide | null; maxHp?: number; healCharges?: number }

export const MAX_HP = 100;
export const FIGHT_START_MS = 3700;
export const KNOCKOUT_MS = 1900;
const EXTRA_TURN_LEAD_MS = 250;
const HEAVY_DEFENDED_RATIO = 0.2;
// Chances, heal amounts and HP live in the battle rules (duel-rules.ts); these are animation timings.
/** A hurt fighter (at or under 60% HP) may heal instead of attacking. */
export const HEAL = { threshold: 0.6, windup: 900, duration: 1500 };
export const COMBO_HEAL = { delay: 350, extra: 700 };
/** An unblockable one-shot with a long cinematic windup, never in the opening turns. */
export const ULTIMATE = { minTurn: 3, windup: 2800, duration: 3600 };
const SKILL_TURN_LIMIT = 24;
/** Base damage before the rules' damage percentage. */
export const MOVES: Record<DuelMove, { min: number; max: number; windup: number; duration: number }> = {
  normal: { min: 10, max: 16, windup: 280, duration: 800 },
  heavy: { min: 18, max: 26, windup: 450, duration: 1050 },
  special: { min: 30, max: 40, windup: 850, duration: 1600 }
};
export const CHARACTERS: DuelCharacter[] = ['knight', 'ronin', 'mage'];
/** Windup/duration for any turn, heals included. */
export const timing = (move: DuelMove | 'heal' | 'ultimate') => move === 'heal' ? HEAL : move === 'ultimate' ? ULTIMATE : MOVES[move];
/** How long a turn stays on screen, including a combo heal after a block. */
export const turnLength = (turn: DuelTurn) => timing(turn.move).duration + (turn.comboHeal ? COMBO_HEAL.extra : 0);
export const otherSide = (side: DuelSide): DuelSide => side === 'left' ? 'right' : 'left';

export function simulateBattle(random: () => number = Math.random, enraged: DuelSide | null = null, rules: DuelRules = DEFAULT_DUEL_RULES): DuelBattle {
  const roll = (max: number) => Math.min(max - 1, Math.floor(random() * max));
  const maxHp = rules.hp, healCharges = rules.healCharges, threshold = Math.round(maxHp * HEAL.threshold), rage = rules.streamerBoost / 100;
  const healRoll = () => rules.healMin + roll(rules.healMax - rules.healMin + 1);
  const left = CHARACTERS[roll(CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  const fighters = { left, right: rest[roll(rest.length)] }, end = { fighters, enraged, maxHp, healCharges };
  const hp: Record<DuelSide, number> = { left: maxHp, right: maxHp }, turns: DuelTurn[] = [];
  let attacker: DuelSide = roll(2) === 0 ? 'left' : 'right', at = FIGHT_START_MS, bonus = false;
  const heals: Record<DuelSide, number> = { left: 0, right: 0 };
  for (;;) {
    const skills = turns.length < SKILL_TURN_LIMIT, defender = otherSide(attacker);
    if (turns.length >= ULTIMATE.minTurn && roll(1000) < (attacker === enraged ? rules.streamerUltimate : rules.ultimate)) {
      const damage = hp[defender];
      turns.push({ at, hitAt: at + ULTIMATE.windup, attacker, move: 'ultimate', damage, raw: damage, crit: false, defended: false, heal: 0, comboHeal: 0, bonus });
      return { ...end, turns, winner: attacker, duration: at + ULTIMATE.windup + KNOCKOUT_MS };
    }
    if (skills && hp[attacker] <= threshold && heals[attacker] < healCharges && roll(100) < rules.healChance) {
      const heal = Math.min(maxHp - hp[attacker], healRoll());
      hp[attacker] += heal; heals[attacker]++;
      turns.push({ at, hitAt: at + HEAL.windup, attacker, move: 'heal', damage: 0, raw: 0, crit: false, defended: false, heal, comboHeal: 0, bonus });
      at += HEAL.duration;
    } else {
      const boost = attacker === enraged ? rage : 1, special = rules.specialChance * boost, heavy = rules.heavyChance * boost;
      const chance = roll(100), move: DuelMove = chance < special ? 'special' : chance < special + heavy ? 'heavy' : 'normal';
      // Scaled damage never drops under 1, so every fight still ends after the skill limit.
      const spec = MOVES[move], raw = Math.max(1, Math.round((spec.min + roll(spec.max - spec.min + 1)) * rules.damage / 100));
      const critical = roll(100) < rules.critChance * boost, hit = critical ? raw * 2 : raw;
      // Specials still roll the skill, but break through it at full damage.
      const defended = skills && roll(100) < rules.defenseChance * (defender === enraged ? rage : 1);
      const damage = !defended || move === 'special' ? hit : move === 'heavy' ? Math.round(hit * HEAVY_DEFENDED_RATIO) : 0;
      hp[defender] = Math.max(0, hp[defender] - damage);
      if (hp[defender] === 0) {
        turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, crit: critical, defended, heal: 0, comboHeal: 0, bonus });
        return { ...end, turns, winner: attacker, duration: at + spec.windup + KNOCKOUT_MS };
      }
      let comboHeal = 0;
      if (defended && move !== 'special' && hp[defender] < maxHp && heals[defender] < healCharges && roll(100) < rules.comboHealChance) {
        comboHeal = Math.min(maxHp - hp[defender], healRoll());
        hp[defender] += comboHeal; heals[defender]++;
      }
      turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, crit: critical && damage > 0, defended, heal: 0, comboHeal, bonus });
      at += spec.duration + (comboHeal ? COMBO_HEAL.extra : 0);
    }
    bonus = roll(100) < rules.extraTurnChance;
    if (bonus) at += EXTRA_TURN_LEAD_MS; else attacker = defender;
  }
}

/** Duels accepted before turn-based battles only stored a winner and lasted 11.4s. */
export function legacyBattle(winner: DuelSide): DuelBattle {
  const loser = otherSide(winner), plan: [DuelSide, DuelMove, number][] = [[winner, 'normal', 18], [loser, 'heavy', 22], [winner, 'normal', 24], [loser, 'normal', 19], [winner, 'heavy', 26], [winner, 'special', 32]];
  const turns = plan.map(([attacker, move, damage], index) => ({ at: 3600 + index * 1050, hitAt: 3600 + index * 1050 + MOVES[move].windup, attacker, move, damage, bonus: index > 0 && plan[index - 1][0] === attacker }));
  return { fighters: { left: 'knight', right: 'knight' }, turns, winner, duration: 11400 };
}

/** A preview battle that ends in an ultimate (by the streamer when one fights). */
export function ultimateBattle(enraged: DuelSide | null = null, rules: DuelRules = DEFAULT_DUEL_RULES): DuelBattle {
  // Ultimates are a fixed showcase: with ultimates turned off the rules still preview one.
  const odds = { ...rules, streamerUltimate: Math.max(rules.streamerUltimate, 40), ultimate: Math.max(rules.ultimate, 2) };
  for (let attempt = 0; attempt < 5000; attempt++) {
    const battle = simulateBattle(Math.random, enraged, odds), last = battle.turns.at(-1)!;
    if (last.move === 'ultimate' && (!enraged || last.attacker === enraged)) return battle;
  }
  return simulateBattle(Math.random, enraged, rules);
}

/** What a set of rules plays like, from a fixed-seed batch of simulated fights. */
export interface DuelBalance { viewerWin: number; streamerWin: number; typical: [number, number]; longest: number; oneShot: number }
export function duelBalance(rules: DuelRules = DEFAULT_DUEL_RULES, fights = 1500): DuelBalance {
  // A fixed seed keeps the numbers steady while a slider sits still.
  let seed = 0x9e3779b9;
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let left = 0, streamer = 0, ultimates = 0;
  const durations: number[] = [];
  for (let index = 0; index < fights; index++) {
    const viewers = simulateBattle(random, null, rules), enraged = simulateBattle(random, 'right', rules);
    if (viewers.winner === 'left') left++;
    if (enraged.winner === 'right') streamer++;
    if (viewers.turns.at(-1)?.move === 'ultimate') ultimates++;
    durations.push(viewers.duration);
  }
  durations.sort((a, b) => a - b);
  const at = (share: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * share))];
  return { viewerWin: left / fights, streamerWin: streamer / fights, typical: [at(.1), at(.9)], longest: durations[durations.length - 1], oneShot: ultimates / fights };
}
