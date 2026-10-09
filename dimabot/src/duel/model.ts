import { randomInt } from 'node:crypto';
import { fail, integer, object } from '../roulette/model.js';

export const DUEL_MS = 11400;
export const WINNER_HOLD_MS = 6000;
export const MAX_TIMEOUT_SECONDS = 1209600;
export interface DuelSettings { enabled: boolean; timeoutEnabled: boolean; timeoutSeconds: number; language: 'en' | 'es' }
export interface DuelChallenge { id: string; challenger: string; opponent: string; expiresAt: number }
export interface DuelRun {
  id: string; challenger: string; opponent: string; winner: 'left' | 'right'; mode: 'overlay' | 'chat';
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
const phrases = {
  en: ['The battle is intense, who will win?', 'The tension is rising in the arena!', 'A flurry of blows! Both duelists are holding their ground.', 'The crowd is going wild!', 'Is that a secret technique I see?', 'One mistake could end it all now...', 'The ground trembles under their feet!', 'Neither side is backing down!', 'An epic clash of titans!', 'Dust fills the air as they trade hits!'],
  es: ['¡La batalla está intensa! ¿Quién ganará?', '¡Sube la tensión en la arena!', '¡Una ráfaga de golpes! Ambos mantienen su posición.', '¡El público enloquece!', '¿Es una técnica secreta?', 'Un error podría acabar con todo...', '¡El suelo tiembla bajo sus pies!', '¡Ninguno se rinde!', '¡Un choque épico de titanes!', '¡El polvo llena el aire mientras intercambian golpes!']
};
export function createRun(challenge: DuelChallenge, config: DuelSettings, overlay: boolean, now: number): DuelRun {
  const available = [...phrases[config.language]], count = randomInt(2, 5);
  const selected = Array.from({ length: count }, () => available.splice(randomInt(available.length), 1)[0]);
  const startedAt = now + 750; // Give connected sources one polling interval to receive the fight.
  return { ...challenge, winner: randomInt(2) === 0 ? 'left' : 'right', mode: overlay ? 'overlay' : 'chat', startedAt, endsAt: startedAt + DUEL_MS,
    timeoutEnabled: config.timeoutEnabled, timeoutSeconds: config.timeoutSeconds, language: config.language,
    phrases: overlay ? [] : selected.map((text, index) => ({ text, at: startedAt + Math.floor(DUEL_MS * (index + 1) / (count + 1)) })),
    phraseIndex: 0, announcementAttempted: false, timeoutAttempted: false, completedAt: null };
}
export const winnerLogin = (run: DuelRun) => run.winner === 'left' ? run.challenger : run.opponent;
export const loserLogin = (run: DuelRun) => run.winner === 'left' ? run.opponent : run.challenger;
export const winnerMessage = (run: DuelRun) => run.language === 'es' ? `@${winnerLogin(run)} ha ganado el duelo contra @${loserLogin(run)}.` : `@${winnerLogin(run)} has won the duel against @${loserLogin(run)}.`;
export const nextDeadline = (run: DuelRun) => run.phrases[run.phraseIndex]?.at ?? run.endsAt;
