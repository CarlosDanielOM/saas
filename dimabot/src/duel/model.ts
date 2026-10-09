import { randomInt } from 'node:crypto';
import { fail, integer, object } from '../roulette/model.js';

export const WINNER_HOLD_MS = 6000;
export const MAX_TIMEOUT_SECONDS = 1209600;
export interface DuelSettings { enabled: boolean; timeoutEnabled: boolean; timeoutSeconds: number; language: 'en' | 'es' }
export type DuelSide = 'left' | 'right';
export type DuelMove = 'normal' | 'heavy' | 'special';
export type DuelCharacter = 'knight' | 'ronin' | 'mage';
/** Offsets are milliseconds from run.startedAt. hitAt is when damage lands. */
/** damage is what landed; raw is the roll before a defense skill. Specials cannot be defended. */
export interface DuelTurn { at: number; hitAt: number; attacker: DuelSide; move: DuelMove; damage: number; raw: number; defended: boolean; bonus: boolean }
export interface DuelBattle { fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[]; winner: DuelSide; duration: number }
export interface DuelChallenge { id: string; challenger: string; opponent: string; expiresAt: number }
export interface DuelRun {
  id: string; challenger: string; opponent: string; winner: DuelSide; mode: 'overlay' | 'chat';
  fighters: Record<DuelSide, DuelCharacter>; turns: DuelTurn[];
  startedAt: number; endsAt: number; timeoutEnabled: boolean; timeoutSeconds: number; language: 'en' | 'es';
  phrases: { at: number; text: string }[]; phraseIndex: number;
  announcementAttempted: boolean; timeoutAttempted: boolean; completedAt: number | null;
  announcementError?: string; timeoutError?: string;
}
export const defaultSettings = (): DuelSettings => ({ enabled: true, timeoutEnabled: true, timeoutSeconds: 60, language: 'en' });
export function settings(input: unknown): DuelSettings {
  const data = object(input);
  if (Object.keys(data).some(key => !['enabled', 'timeoutEnabled', 'timeoutSeconds', 'language'].includes(key))) fail('invalid', 'Unknown duel setting');
  if (typeof data.enabled !== 'boolean' || typeof data.timeoutEnabled !== 'boolean') fail('invalid', 'Duel switches must be booleans');
  if (!['en', 'es'].includes(data.language as string)) fail('invalid', 'Choose English or Spanish');
  return { enabled: data.enabled as boolean, timeoutEnabled: data.timeoutEnabled as boolean, timeoutSeconds: integer(data.timeoutSeconds, 'timeoutSeconds', 1, MAX_TIMEOUT_SECONDS), language: data.language as DuelSettings['language'] };
}
const flavour = {
  en: ['The battle is intense, who will win?', 'The tension is rising in the arena!', 'A flurry of blows! Both duelists are holding their ground.', 'The crowd is going wild!', 'Is that a secret technique I see?', 'One mistake could end it all now...', 'The ground trembles under their feet!', 'Neither side is backing down!', 'An epic clash of titans!', 'Dust fills the air as they trade hits!'],
  es: ['¡La batalla está intensa! ¿Quién ganará?', '¡Sube la tensión en la arena!', '¡Una ráfaga de golpes! Ambos mantienen su posición.', '¡El público enloquece!', '¿Es una técnica secreta?', 'Un error podría acabar con todo...', '¡El suelo tiembla bajo sus pies!', '¡Ninguno se rinde!', '¡Un choque épico de titanes!', '¡El polvo llena el aire mientras intercambian golpes!']
};
// Overlay animation timings are mirrored in dimasite/src/app/features/widgets/duel/duel-battle.ts.
export const MAX_HP = 100;
export const FIGHT_START_MS = 3700;
export const KNOCKOUT_MS = 1900;
export const EXTRA_TURN_PERCENT = 15;
// When hit by a normal or heavy attack the defender may use its skill:
// normals are fully avoided, heavies lose 80% of their damage.
export const DEFENSE_PERCENT = 15;
export const HEAVY_DEFENDED_RATIO = 0.2;
const DEFENSE_TURN_LIMIT = 24;
const EXTRA_TURN_LEAD_MS = 250;
// chance is out of 100; windup is the time from the turn start to the hit.
export const MOVES: Record<DuelMove, { chance: number; min: number; max: number; windup: number; duration: number }> = {
  normal: { chance: 68, min: 10, max: 16, windup: 280, duration: 800 },
  heavy: { chance: 24, min: 18, max: 26, windup: 450, duration: 1050 },
  special: { chance: 8, min: 30, max: 40, windup: 850, duration: 1600 }
};
export const CHARACTERS: DuelCharacter[] = ['knight', 'ronin', 'mage'];
const other = (side: DuelSide): DuelSide => side === 'left' ? 'right' : 'left';
/** Turn-based fight with no predetermined winner: whoever reaches 0 HP first loses. */
export function simulateBattle(roll: (max: number) => number = randomInt): DuelBattle {
  const left = CHARACTERS[roll(CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  const fighters = { left, right: rest[roll(rest.length)] };
  const hp: Record<DuelSide, number> = { left: MAX_HP, right: MAX_HP }, turns: DuelTurn[] = [];
  let attacker: DuelSide = roll(2) === 0 ? 'left' : 'right', at = FIGHT_START_MS, bonus = false;
  // Defenses stop after DEFENSE_TURN_LIMIT turns; from then on every hit removes
  // at least 10 HP, so the fight always ends.
  for (;;) {
    const chance = roll(100), move: DuelMove = chance < MOVES.special.chance ? 'special' : chance < MOVES.special.chance + MOVES.heavy.chance ? 'heavy' : 'normal';
    const spec = MOVES[move], raw = spec.min + roll(spec.max - spec.min + 1), defender = other(attacker);
    const defended = move !== 'special' && turns.length < DEFENSE_TURN_LIMIT && roll(100) < DEFENSE_PERCENT;
    const damage = !defended ? raw : move === 'heavy' ? Math.round(raw * HEAVY_DEFENDED_RATIO) : 0;
    hp[defender] = Math.max(0, hp[defender] - damage);
    turns.push({ at, hitAt: at + spec.windup, attacker, move, damage, raw, defended, bonus });
    if (hp[defender] === 0) return { fighters, turns, winner: attacker, duration: at + spec.windup + KNOCKOUT_MS };
    at += spec.duration;
    // After a turn the attacker may steal the opponent's turn and strike again.
    bonus = roll(100) < EXTRA_TURN_PERCENT;
    if (bonus) at += EXTRA_TURN_LEAD_MS; else attacker = defender;
  }
}
export const remainingHp = (turns: DuelTurn[], side: DuelSide) => Math.max(0, MAX_HP - turns.filter(turn => turn.attacker !== side).reduce((sum, turn) => sum + turn.damage, 0));
const skills: Record<'en' | 'es', Record<DuelCharacter, string>> = {
  en: { knight: 'Shield Wall', ronin: 'Ghost Step', mage: 'Arcane Ward' },
  es: { knight: 'Muro de Escudo', ronin: 'Paso Fantasma', mage: 'Barrera Arcana' }
};
const specials: Record<'en' | 'es', Record<DuelCharacter, string>> = {
  en: { knight: 'Holy Smite', ronin: 'Crescent Moon Slash', mage: 'Meteor Storm' },
  es: { knight: 'Castigo Sagrado', ronin: 'Tajo de Luna Creciente', mage: 'Tormenta de Meteoros' }
};
// Chat narration describes the real fight: specials, defenses, stolen turns, then heavy blows.
function highlight(turn: DuelTurn, names: Record<DuelSide, string>, fighters: DuelBattle['fighters'], language: 'en' | 'es'): string {
  const attacker = `@${names[turn.attacker]}`, defender = `@${names[other(turn.attacker)]}`;
  if (turn.move === 'special') return language === 'es' ? `¡${attacker} desata ${specials.es[fighters[turn.attacker]]} contra ${defender}! (-${turn.damage} HP)` : `${attacker} unleashes ${specials.en[fighters[turn.attacker]]} on ${defender}! (-${turn.damage} HP)`;
  if (turn.defended) {
    const skill = skills[language][fighters[other(turn.attacker)]];
    if (turn.move === 'heavy') return language === 'es' ? `¡${defender} usa ${skill}: el golpe pesado de ${attacker} solo hace ${turn.damage} de daño!` : `${defender} uses ${skill}: ${attacker}'s heavy blow only deals ${turn.damage} damage!`;
    return language === 'es' ? `¡${defender} usa ${skill} y evita todo el daño de ${attacker}!` : `${defender} uses ${skill} and takes no damage from ${attacker}!`;
  }
  if (turn.bonus) return language === 'es' ? `¡${attacker} es demasiado rápido y roba el turno! (-${turn.damage} HP)` : `${attacker} is too fast and steals the turn! (-${turn.damage} HP)`;
  return language === 'es' ? `¡${attacker} conecta un golpe pesado a ${defender}! (-${turn.damage} HP)` : `${attacker} lands a heavy blow on ${defender}! (-${turn.damage} HP)`;
}
export function createRun(challenge: DuelChallenge, config: DuelSettings, overlay: boolean, now: number): DuelRun {
  const battle = simulateBattle(), names = { left: challenge.challenger, right: challenge.opponent };
  const startedAt = now + 750; // Give connected sources one polling interval to receive the fight.
  const rank = (turn: DuelTurn) => turn.move === 'special' ? 4 : turn.defended ? 3 : turn.bonus ? 2 : turn.move === 'heavy' ? 1 : 0;
  const notable = battle.turns.filter(turn => rank(turn) > 0).sort((a, b) => rank(b) - rank(a) || a.at - b.at).slice(0, 3);
  const phrases = notable.map(turn => ({ at: startedAt + turn.hitAt, text: highlight(turn, names, battle.fighters, config.language) }));
  // Quiet fights still get some flavour, spread across the battle.
  const available = [...flavour[config.language]];
  for (let index = phrases.length; index < 2; index++) phrases.push({ at: startedAt + Math.floor(battle.duration * (index + 1) / 3), text: available.splice(randomInt(available.length), 1)[0] });
  return { ...challenge, winner: battle.winner, fighters: battle.fighters, turns: battle.turns, mode: overlay ? 'overlay' : 'chat', startedAt, endsAt: startedAt + battle.duration,
    timeoutEnabled: config.timeoutEnabled, timeoutSeconds: config.timeoutSeconds, language: config.language,
    phrases: overlay ? [] : phrases.sort((a, b) => a.at - b.at),
    phraseIndex: 0, announcementAttempted: false, timeoutAttempted: false, completedAt: null };
}
export const winnerLogin = (run: DuelRun) => run.winner === 'left' ? run.challenger : run.opponent;
export const loserLogin = (run: DuelRun) => run.winner === 'left' ? run.opponent : run.challenger;
export function winnerMessage(run: DuelRun): string {
  // Runs accepted before turn-based battles have no turns to count HP from.
  const hp = run.turns?.length ? remainingHp(run.turns, run.winner) : null;
  if (run.language === 'es') return `@${winnerLogin(run)} ha ganado el duelo contra @${loserLogin(run)}${hp === null ? '.' : ` con ${hp} HP restantes.`}`;
  return `@${winnerLogin(run)} has won the duel against @${loserLogin(run)}${hp === null ? '.' : ` with ${hp} HP left.`}`;
}
export const nextDeadline = (run: DuelRun) => run.phrases[run.phraseIndex]?.at ?? run.endsAt;
