import { randomInt } from 'node:crypto';
import { fail, integer, object } from '../roulette/model.js';

export const WINNER_HOLD_MS = 6000;
export const MAX_TIMEOUT_SECONDS = 1209600;
/**
 * leaderboard ranks viewers by K/D, rivalries shows each pair's head-to-head record.
 * Both only track overlay fights played under the default rules.
 */
/** Overlay look: low (original vector), medium (HD vector), high (cinematic vector), extreme (3D). Display only. */
export type DuelQuality = 'low' | 'medium' | 'high' | 'extreme';
export const DUEL_QUALITIES: DuelQuality[] = ['low', 'medium', 'high', 'extreme'];
export interface DuelSettings { enabled: boolean; timeoutEnabled: boolean; timeoutSeconds: number; language: 'en' | 'es'; leaderboard: boolean; rivalries: boolean; rules: DuelRules; quality: DuelQuality }
/**
 * Battle rules a streamer can tune (mirrored in dimasite/.../duel/duel-rules.ts). Chances
 * are out of 100, ultimates per mille per turn, damage and streamerBoost are percentages
 * of the base values.
 */
export interface DuelRules {
  hp: number; damage: number; extraTurnChance: number;
  heavyChance: number; specialChance: number; critChance: number;
  defenseChance: number; healChance: number; healCharges: number; healMin: number; healMax: number; comboHealChance: number;
  streamerBoost: number; streamerUltimate: number; ultimate: number;
}
/** Tuned by simulation: viewer duels are 50/50, the enraged streamer wins ~85%, fights last ~13–32 s. */
export const DEFAULT_RULES: Readonly<DuelRules> = Object.freeze({
  hp: 100, damage: 100, extraTurnChance: 15,
  heavyChance: 24, specialChance: 8, critChance: 10,
  defenseChance: 15, healChance: 20, healCharges: 5, healMin: 25, healMax: 40, comboHealChance: 35,
  streamerBoost: 200, streamerUltimate: 40, ultimate: 2
});
/** [min, max, step]. Damage never scales under 50%, so every fight still ends quickly after the skill limit. */
export const RULE_LIMITS: Record<keyof DuelRules, [number, number, number]> = {
  hp: [50, 300, 10], damage: [50, 200, 5], extraTurnChance: [0, 50, 1],
  heavyChance: [0, 60, 1], specialChance: [0, 40, 1], critChance: [0, 50, 1],
  defenseChance: [0, 50, 1], healChance: [0, 60, 1], healCharges: [0, 10, 1], healMin: [5, 100, 1], healMax: [5, 100, 1], comboHealChance: [0, 100, 1],
  streamerBoost: [100, 300, 10], streamerUltimate: [0, 200, 1], ultimate: [0, 50, 1]
};
const RULE_KEYS = Object.keys(DEFAULT_RULES) as (keyof DuelRules)[];
export const isDefaultRules = (rules: DuelRules) => RULE_KEYS.every(key => rules[key] === DEFAULT_RULES[key]);
/** Fights only count towards the leaderboard and rivalries under the default rules. */
export const tracksResults = (config: DuelSettings) => (config.leaderboard || config.rivalries) && isDefaultRules(config.rules);
/** 'paused' while custom rules are on: old rankings stay, new fights don't count. */
export const leaderboardStatus = (config: DuelSettings): 'live' | 'paused' | 'off' => !config.leaderboard ? 'off' : isDefaultRules(config.rules) ? 'live' : 'paused';
export function rules(input: unknown): DuelRules {
  const data = object(input);
  if (Object.keys(data).some(key => !(key in DEFAULT_RULES))) fail('invalid', 'Unknown duel rule');
  const result = { ...DEFAULT_RULES };
  for (const key of RULE_KEYS) {
    if (data[key] === undefined) continue;
    const [min, max, step] = RULE_LIMITS[key], value = integer(data[key], key, min, max);
    if ((value - min) % step) fail('invalid', `${key} must move in steps of ${step}`);
    result[key] = value;
  }
  if (result.healMin > result.healMax) fail('invalid', 'The smallest heal cannot be bigger than the largest heal');
  return result;
}
export type DuelSide = 'left' | 'right';
export type DuelMove = 'normal' | 'heavy' | 'special';
export type DuelCharacter = 'knight' | 'ronin' | 'mage';
/**
 * Offsets are milliseconds from run.startedAt; hitAt is when damage (or healing) lands.
 * raw is the base roll, crit doubles it, a defense skill then reduces it (specials break
 * through a defense); damage is what landed. A 'heal' turn restores `heal` HP to the acting
 * fighter instead. comboHeal is HP the defender regains right after blocking.
 */
export interface DuelTurn { at: number; hitAt: number; attacker: DuelSide; move: DuelMove | 'heal' | 'ultimate'; damage: number; raw: number; crit: boolean; defended: boolean; heal: number; comboHeal: number; bonus: boolean }
export interface DuelBattle { fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; winner: DuelSide; duration: number; enraged: DuelSide | null; maxHp: number; healCharges: number }
/** enraged marks the streamer's side: the channel owner fights with doubled odds. */
/** Head-to-head wins of each side before this fight (overlay duels only). */
export interface DuelRecord { left: number; right: number }
export interface DuelChallenge { id: string; challenger: string; opponent: string; expiresAt: number; enraged?: DuelSide | null }
export interface DuelRun {
  id: string; challenger: string; opponent: string; winner: DuelSide; mode: 'overlay' | 'chat';
  fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; enraged: DuelSide | null;
  startedAt: number; endsAt: number; timeoutEnabled: boolean; timeoutSeconds: number; language: 'en' | 'es';
  phrases: { at: number; text: string }[]; phraseIndex: number;
  announcementAttempted: boolean; timeoutAttempted: boolean; completedAt: number | null;
  announcementError?: string; timeoutError?: string; record?: DuelRecord | null;
  /** From the rules at accept time; runs before tunable rules have neither (100 HP, 5 heals). */
  maxHp?: number; healCharges?: number;
  /** Whether the result feeds the leaderboard/rivalries (unset on older runs: overlay runs counted). */
  tracked?: boolean;
}
export const defaultSettings = (): DuelSettings => ({ enabled: true, timeoutEnabled: true, timeoutSeconds: 60, language: 'en', leaderboard: true, rivalries: true, rules: { ...DEFAULT_RULES }, quality: 'low' });
/** Channels saved before tracking switches, rules and quality existed get the defaults. */
export const normalizeSettings = (stored: Partial<DuelSettings>): DuelSettings => ({ ...defaultSettings(), ...stored, rules: { ...DEFAULT_RULES, ...(stored.rules ?? {}) } });
/** Fields an older page doesn't send keep their current value instead of resetting. */
export function settings(input: unknown, current: DuelSettings = defaultSettings()): DuelSettings {
  const data = object(input);
  if (Object.keys(data).some(key => !['enabled', 'timeoutEnabled', 'timeoutSeconds', 'language', 'leaderboard', 'rivalries', 'rules', 'quality'].includes(key))) fail('invalid', 'Unknown duel setting');
  if (typeof data.enabled !== 'boolean' || typeof data.timeoutEnabled !== 'boolean') fail('invalid', 'Duel switches must be booleans');
  if ([data.leaderboard, data.rivalries].some(value => value !== undefined && typeof value !== 'boolean')) fail('invalid', 'Duel switches must be booleans');
  if (!['en', 'es'].includes(data.language as string)) fail('invalid', 'Choose English or Spanish');
  if (data.quality !== undefined && !DUEL_QUALITIES.includes(data.quality as DuelQuality)) fail('invalid', 'Choose low, medium, high or extreme quality');
  return { enabled: data.enabled as boolean, timeoutEnabled: data.timeoutEnabled as boolean, timeoutSeconds: integer(data.timeoutSeconds, 'timeoutSeconds', 1, MAX_TIMEOUT_SECONDS), language: data.language as DuelSettings['language'],
    leaderboard: (data.leaderboard as boolean | undefined) ?? current.leaderboard, rivalries: (data.rivalries as boolean | undefined) ?? current.rivalries,
    rules: data.rules === undefined ? { ...current.rules } : rules(data.rules), quality: (data.quality as DuelQuality | undefined) ?? current.quality };
}
const flavour = {
  en: ['The battle is intense, who will win?', 'The tension is rising in the arena!', 'A flurry of blows! Both duelists are holding their ground.', 'The crowd is going wild!', 'Is that a secret technique I see?', 'One mistake could end it all now...', 'The ground trembles under their feet!', 'Neither side is backing down!', 'An epic clash of titans!', 'Dust fills the air as they trade hits!'],
  es: ['¡La batalla está intensa! ¿Quién ganará?', '¡Sube la tensión en la arena!', '¡Una ráfaga de golpes! Ambos mantienen su posición.', '¡El público enloquece!', '¿Es una técnica secreta?', 'Un error podría acabar con todo...', '¡El suelo tiembla bajo sus pies!', '¡Ninguno se rinde!', '¡Un choque épico de titanes!', '¡El polvo llena el aire mientras intercambian golpes!']
};
// Overlay animation timings are mirrored in dimasite/src/app/features/widgets/duel/duel-battle.ts.
export const MAX_HP = DEFAULT_RULES.hp;
export const FIGHT_START_MS = 3700;
export const KNOCKOUT_MS = 1900;
// The odds below live in the rules (DEFAULT_RULES); these are the fixed mechanics and timings.
// When hit the defender may use its skill: normals are fully avoided, heavies
// lose 80% of their damage, and specials shatter the skill at full damage.
// Every attack may crit for double damage, specials included.
export const HEAVY_DEFENDED_RATIO = 0.2;
// A hurt fighter (at or under 60% HP) may heal instead of attacking, up to healCharges times.
export const HEAL = { threshold: 0.6, windup: 900, duration: 1500 };
// Blocking a normal or heavy attack may chain into a heal (it uses a heal charge).
// The heal lands `delay` ms after the block and the turn runs `extra` ms longer.
export const COMBO_HEAL = { delay: 350, extra: 700 };
// Defenses and heals stop after this many turns so every fight ends.
const SKILL_TURN_LIMIT = 24;
const EXTRA_TURN_LEAD_MS = 250;
// A character's ultimate: an unblockable one-shot with a long cinematic windup.
// Chances are per mille per turn: rare for the enraged streamer, super rare for
// everyone else, and never in the opening turns so every fight gets going first.
export const ULTIMATE = { minTurn: 3, windup: 2800, duration: 3600 };
// Base damage before the rules' damage percentage; windup is the time from the turn start to the hit.
export const MOVES: Record<DuelMove, { min: number; max: number; windup: number; duration: number }> = {
  normal: { min: 10, max: 16, windup: 280, duration: 800 },
  heavy: { min: 18, max: 26, windup: 450, duration: 1050 },
  special: { min: 30, max: 40, windup: 850, duration: 1600 }
};
export const CHARACTERS: DuelCharacter[] = ['knight', 'ronin', 'mage'];
const other = (side: DuelSide): DuelSide => side === 'left' ? 'right' : 'left';
/** Turn-based fight with no predetermined winner: whoever reaches 0 HP first loses. */
// The enraged streamer multiplies its heavy/special, crit and defense chances by streamerBoost.
export function simulateBattle(roll: (max: number) => number = randomInt, enraged: DuelSide | null = null, rules: DuelRules = DEFAULT_RULES): DuelBattle {
  const maxHp = rules.hp, healCharges = rules.healCharges, threshold = Math.round(maxHp * HEAL.threshold), rage = rules.streamerBoost / 100;
  const healRoll = () => rules.healMin + roll(rules.healMax - rules.healMin + 1);
  const left = CHARACTERS[roll(CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  const fighters = { left, right: rest[roll(rest.length)] }, end = { fighters, enraged, maxHp, healCharges };
  const hp: Record<DuelSide, number> = { left: maxHp, right: maxHp }, turns: DuelTurn[] = [];
  let attacker: DuelSide = roll(2) === 0 ? 'left' : 'right', at = FIGHT_START_MS, bonus = false;
  const heals: Record<DuelSide, number> = { left: 0, right: 0 };
  // After SKILL_TURN_LIMIT turns every hit removes at least 10 HP, so the fight always ends.
  for (;;) {
    const skills = turns.length < SKILL_TURN_LIMIT, defender = other(attacker);
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
      // Specials break the block, so they never trigger the combo.
      let comboHeal = 0;
      if (defended && move !== 'special' && hp[defender] < maxHp && heals[defender] < healCharges && roll(100) < rules.comboHealChance) {
        comboHeal = Math.min(maxHp - hp[defender], healRoll());
        hp[defender] += comboHeal; heals[defender]++;
      }
      // A fully blocked crit is just a block.
      turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, crit: critical && damage > 0, defended, heal: 0, comboHeal, bonus });
      at += spec.duration + (comboHeal ? COMBO_HEAL.extra : 0);
    }
    // After a turn the attacker may steal the opponent's turn and strike again.
    bonus = roll(100) < rules.extraTurnChance;
    if (bonus) at += EXTRA_TURN_LEAD_MS; else attacker = defender;
  }
}
export function remainingHp(turns: DuelTurn[], side: DuelSide, maxHp = MAX_HP): number {
  let hp = maxHp;
  for (const turn of turns) hp = turn.attacker === side ? Math.min(maxHp, hp + (turn.heal ?? 0)) : Math.min(maxHp, Math.max(0, hp - turn.damage) + (turn.comboHeal ?? 0));
  return hp;
}
const skills: Record<'en' | 'es', Record<DuelCharacter, string>> = {
  en: { knight: 'Shield Wall', ronin: 'Ghost Step', mage: 'Arcane Ward' },
  es: { knight: 'Muro de Escudo', ronin: 'Paso Fantasma', mage: 'Barrera Arcana' }
};
const healLines: Record<'en' | 'es', Record<DuelCharacter, (name: string, hp: number) => string>> = {
  en: { knight: (name, hp) => `An angel descends and heals ${name}! (+${hp} HP)`, ronin: (name, hp) => `${name} drinks a healing potion! (+${hp} HP)`, mage: (name, hp) => `${name} glows green with life glyphs! (+${hp} HP)` },
  es: { knight: (name, hp) => `¡Un ángel desciende y cura a ${name}! (+${hp} HP)`, ronin: (name, hp) => `¡${name} bebe una poción curativa! (+${hp} HP)`, mage: (name, hp) => `¡${name} brilla en verde con glifos de vida! (+${hp} HP)` }
};
const ultimates: Record<'en' | 'es', Record<DuelCharacter, (attacker: string, defender: string) => string>> = {
  en: { knight: (a, d) => `ULTIMATE! ${a} calls DIVINE JUDGMENT: an angel descends and evaporates ${d}!`, ronin: (a, d) => `ULTIMATE! ${a} unleashes BLOOD MOON: THOUSAND CUTS and ${d} is cut down!`, mage: (a, d) => `ULTIMATE! ${a} opens a BLACK HOLE and ${d} is swallowed whole!` },
  es: { knight: (a, d) => `¡DEFINITIVA! ${a} invoca el JUICIO DIVINO: ¡un ángel desciende y evapora a ${d}!`, ronin: (a, d) => `¡DEFINITIVA! ${a} desata LUNA SANGRIENTA: MIL CORTES y ${d} cae!`, mage: (a, d) => `¡DEFINITIVA! ${a} abre un AGUJERO NEGRO y ${d} es devorado!` }
};
const specials: Record<'en' | 'es', Record<DuelCharacter, string>> = {
  en: { knight: 'Holy Smite', ronin: 'Crescent Moon Slash', mage: 'Meteor Storm' },
  es: { knight: 'Castigo Sagrado', ronin: 'Tajo de Luna Creciente', mage: 'Tormenta de Meteoros' }
};
// Chat narration describes the real fight: specials, heals, crits, defenses, stolen turns, then heavy blows.
function highlight(turn: DuelTurn, names: Record<DuelSide, string>, fighters: DuelBattle['fighters'], language: 'en' | 'es'): string {
  const attacker = `@${names[turn.attacker]}`, defender = `@${names[other(turn.attacker)]}`;
  if (turn.move === 'ultimate') return ultimates[language][fighters[turn.attacker]](attacker, defender);
  if (turn.move === 'heal') return healLines[language][fighters[turn.attacker]](attacker, turn.heal);
  const crit = turn.crit ? (language === 'es' ? ' ¡CRÍTICO!' : ' CRITICAL!') : '';
  if (turn.move === 'special' && turn.defended) {
    const skill = skills[language][fighters[other(turn.attacker)]], special = specials[language][fighters[turn.attacker]];
    return language === 'es' ? `¡${defender} usa ${skill}, pero ${special} de ${attacker} lo destroza! (-${turn.damage} HP)${crit}` : `${defender} raises ${skill}, but ${attacker}'s ${special} shatters it! (-${turn.damage} HP)${crit}`;
  }
  if (turn.move === 'special') return language === 'es' ? `¡${attacker} desata ${specials.es[fighters[turn.attacker]]} contra ${defender}! (-${turn.damage} HP)${crit}` : `${attacker} unleashes ${specials.en[fighters[turn.attacker]]} on ${defender}! (-${turn.damage} HP)${crit}`;
  if (turn.crit && !turn.defended) return language === 'es' ? `¡GOLPE CRÍTICO! ${attacker} duplica el daño a ${defender} (-${turn.damage} HP)` : `CRITICAL HIT! ${attacker} deals double damage to ${defender} (-${turn.damage} HP)`;
  if (turn.comboHeal) {
    const skill = skills[language][fighters[other(turn.attacker)]];
    return language === 'es' ? `¡COMBO! ${defender} bloquea con ${skill} y se cura (+${turn.comboHeal} HP)` : `COMBO! ${defender} blocks with ${skill} and heals (+${turn.comboHeal} HP)`;
  }
  if (turn.defended) {
    const skill = skills[language][fighters[other(turn.attacker)]];
    if (turn.move === 'heavy') return language === 'es' ? `¡${defender} usa ${skill}: el golpe pesado de ${attacker} solo hace ${turn.damage} de daño!` : `${defender} uses ${skill}: ${attacker}'s heavy blow only deals ${turn.damage} damage!`;
    return language === 'es' ? `¡${defender} usa ${skill} y evita todo el daño de ${attacker}!` : `${defender} uses ${skill} and takes no damage from ${attacker}!`;
  }
  if (turn.bonus) return language === 'es' ? `¡${attacker} es demasiado rápido y roba el turno! (-${turn.damage} HP)` : `${attacker} is too fast and steals the turn! (-${turn.damage} HP)`;
  return language === 'es' ? `¡${attacker} conecta un golpe pesado a ${defender}! (-${turn.damage} HP)` : `${attacker} lands a heavy blow on ${defender}! (-${turn.damage} HP)`;
}
export function createRun(challenge: DuelChallenge, config: DuelSettings, overlay: boolean, now: number): DuelRun {
  const enraged = challenge.enraged ?? null, battle = simulateBattle(randomInt, enraged, config.rules), names = { left: challenge.challenger, right: challenge.opponent };
  const startedAt = now + 750; // Give connected sources one polling interval to receive the fight.
  const rank = (turn: DuelTurn) => turn.move === 'ultimate' ? 6 : turn.move === 'special' ? 5 : turn.move === 'heal' || turn.comboHeal ? 4 : turn.crit || turn.defended ? 3 : turn.bonus ? 2 : turn.move === 'heavy' ? 1 : 0;
  const notable = battle.turns.filter(turn => rank(turn) > 0).sort((a, b) => rank(b) - rank(a) || a.at - b.at).slice(0, 3);
  const phrases = notable.map(turn => ({ at: startedAt + turn.hitAt, text: highlight(turn, names, battle.fighters, config.language) }));
  // Quiet fights still get some flavour, spread across the battle.
  const available = [...flavour[config.language]];
  for (let index = phrases.length; index < 2; index++) phrases.push({ at: startedAt + Math.floor(battle.duration * (index + 1) / 3), text: available.splice(randomInt(available.length), 1)[0] });
  return { ...challenge, enraged, winner: battle.winner, fighters: battle.fighters, turns: battle.turns, mode: overlay ? 'overlay' : 'chat', startedAt, endsAt: startedAt + battle.duration,
    maxHp: battle.maxHp, healCharges: battle.healCharges, tracked: overlay && tracksResults(config),
    timeoutEnabled: config.timeoutEnabled, timeoutSeconds: config.timeoutSeconds, language: config.language,
    phrases: overlay ? [] : phrases.sort((a, b) => a.at - b.at),
    phraseIndex: 0, announcementAttempted: false, timeoutAttempted: false, completedAt: null };
}
export const winnerLogin = (run: DuelRun) => run.winner === 'left' ? run.challenger : run.opponent;
export const loserLogin = (run: DuelRun) => run.winner === 'left' ? run.opponent : run.challenger;
export function winnerMessage(run: DuelRun): string {
  // Runs accepted before turn-based battles have no turns to count HP from.
  const hp = run.turns?.length ? remainingHp(run.turns, run.winner, run.maxHp) : null;
  const upset = run.enraged && run.enraged !== run.winner, remaining = hp === null ? '' : run.language === 'es' ? ` con ${hp} HP restantes` : ` with ${hp} HP left`;
  if (upset) return run.language === 'es' ? `¡IMPOSIBLE! @${winnerLogin(run)} ha derrotado al streamer enfurecido @${loserLogin(run)}${remaining}!` : `UNBELIEVABLE! @${winnerLogin(run)} has defeated the enraged streamer @${loserLogin(run)}${remaining}!`;
  if (run.language === 'es') return `@${winnerLogin(run)} ha ganado el duelo contra @${loserLogin(run)}${hp === null ? '.' : ` con ${hp} HP restantes.`}`;
  return `@${winnerLogin(run)} has won the duel against @${loserLogin(run)}${hp === null ? '.' : ` with ${hp} HP left.`}`;
}
export const nextDeadline = (run: DuelRun) => run.phrases[run.phraseIndex]?.at ?? run.endsAt;
