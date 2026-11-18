/**
 * Chat sound: a short pop in an OBS browser source when someone chats (like Discord's message sound).
 * Settings validation and the per-channel decision "does this message pop?" live here, free of I/O,
 * so the socket service and the tests share one rule.
 */
import { TWITCH_BOT_ACCOUNT_ID } from '../utils/header.js';
import { isServiceBot } from '../utils/moderation/spam.js';

export class ChatSoundError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function fail(code: string, message: string, status = 400): never { throw new ChatSoundError(code, message, status); }

export interface ChatSoundSettings {
  /** Off keeps the OBS source connected but silent. */
  enabled: boolean;
  /** 0-100 % of the pop's own level. */
  volume: number;
  /** Our bot and the common service bots (Nightbot, StreamElements...). */
  ignoreBots: boolean;
  /** The streamer's own messages. */
  ignoreSelf: boolean;
  /** Messages that start with "!". */
  ignoreCommands: boolean;
  /** Messages from other channels during a Twitch shared chat. */
  ignoreSharedChat: boolean;
  /** Shortest gap between two pops, so a busy chat does not machine-gun. */
  cooldownSeconds: number;
  /** 0 = every message; otherwise only the first message after chat was quiet this many minutes. */
  quietMinutes: number;
}

export const CHAT_SOUND_DEFAULTS: Readonly<ChatSoundSettings> = Object.freeze({
  enabled: true, volume: 70, ignoreBots: true, ignoreSelf: true, ignoreCommands: false, ignoreSharedChat: false,
  cooldownSeconds: 1, quietMinutes: 0
});
export const COOLDOWN_LIMITS = { min: 0.25, max: 60 } as const;
export const QUIET_LIMITS = { min: 0, max: 120 } as const;
const KEYS = Object.keys(CHAT_SOUND_DEFAULTS) as (keyof ChatSoundSettings)[];
const BOOLEAN_KEYS = ['enabled', 'ignoreBots', 'ignoreSelf', 'ignoreCommands', 'ignoreSharedChat'] as const;

export function validVolume(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** Strict: a save must send every field with the right type and range (the page always sends the whole form). */
export function parseSettings(input: unknown): ChatSoundSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid', 'Expected chat sound settings');
  const body = input as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !KEYS.includes(key as keyof ChatSoundSettings));
  if (unknown.length) fail('invalid', `Unknown setting: ${unknown[0]}`);
  for (const key of BOOLEAN_KEYS) if (typeof body[key] !== 'boolean') fail('invalid', `${key} must be true or false`);
  if (!validVolume(body.volume)) fail('invalid', 'volume must be a whole number from 0 to 100');
  const cooldown = body.cooldownSeconds;
  if (typeof cooldown !== 'number' || !Number.isFinite(cooldown) || cooldown < COOLDOWN_LIMITS.min || cooldown > COOLDOWN_LIMITS.max || Math.round(cooldown * 100) !== cooldown * 100)
    fail('invalid', `cooldownSeconds must be from ${COOLDOWN_LIMITS.min} to ${COOLDOWN_LIMITS.max} seconds`);
  const quiet = body.quietMinutes;
  if (typeof quiet !== 'number' || !Number.isInteger(quiet) || quiet < QUIET_LIMITS.min || quiet > QUIET_LIMITS.max)
    fail('invalid', `quietMinutes must be a whole number from ${QUIET_LIMITS.min} to ${QUIET_LIMITS.max}`);
  return {
    enabled: body.enabled as boolean, volume: body.volume as number, ignoreBots: body.ignoreBots as boolean,
    ignoreSelf: body.ignoreSelf as boolean, ignoreCommands: body.ignoreCommands as boolean,
    ignoreSharedChat: body.ignoreSharedChat as boolean, cooldownSeconds: cooldown, quietMinutes: quiet
  };
}

/** Stored settings are read leniently: a missing or broken field falls back to its default. */
export function normalizeSettings(stored: unknown): ChatSoundSettings {
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const out = { ...CHAT_SOUND_DEFAULTS };
  for (const key of BOOLEAN_KEYS) if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  if (validVolume(raw.volume)) out.volume = raw.volume;
  const cooldown = raw.cooldownSeconds;
  if (typeof cooldown === 'number' && Number.isFinite(cooldown) && cooldown >= COOLDOWN_LIMITS.min && cooldown <= COOLDOWN_LIMITS.max) out.cooldownSeconds = cooldown;
  const quiet = raw.quietMinutes;
  if (typeof quiet === 'number' && Number.isInteger(quiet) && quiet >= QUIET_LIMITS.min && quiet <= QUIET_LIMITS.max) out.quietMinutes = quiet;
  return out;
}

/** The fields of a widget-feed chat message (src/widget_feed/types.ts DimaChat) the decision reads. */
export interface ChatLike {
  user?: { id?: unknown; login?: unknown } | null;
  text?: unknown;
  sharedChat?: { channelId?: unknown } | null;
}
export interface PopClock { lastPopAt: number; lastChatAt: number }
export type SkipReason = 'disabled' | 'bot' | 'self' | 'command' | 'shared' | 'quiet' | 'cooldown';

/**
 * Whether a chat message pops, updating the channel's clock. Ignored messages (bots, own, commands, other channels)
 * do not count as chat activity for quiet mode; a message held back by the cooldown or by quiet mode still does.
 */
export function popDecision(channel: string, chat: ChatLike, settings: ChatSoundSettings, clock: PopClock, now: number): { pop: true } | { pop: false; reason: SkipReason } {
  if (!settings.enabled) return { pop: false, reason: 'disabled' };
  const userId = typeof chat.user?.id === 'string' ? chat.user.id : '', login = typeof chat.user?.login === 'string' ? chat.user.login : '';
  if (settings.ignoreBots && (userId === TWITCH_BOT_ACCOUNT_ID || isServiceBot(login))) return { pop: false, reason: 'bot' };
  if (settings.ignoreSelf && userId === channel) return { pop: false, reason: 'self' };
  if (settings.ignoreCommands && typeof chat.text === 'string' && chat.text.trimStart().startsWith('!')) return { pop: false, reason: 'command' };
  const sharedFrom = chat.sharedChat?.channelId;
  if (settings.ignoreSharedChat && typeof sharedFrom === 'string' && sharedFrom && sharedFrom !== channel) return { pop: false, reason: 'shared' };
  const previousChat = clock.lastChatAt;
  clock.lastChatAt = now;
  if (settings.quietMinutes > 0 && previousChat > 0 && now - previousChat < settings.quietMinutes * 60_000) return { pop: false, reason: 'quiet' };
  if (now - clock.lastPopAt < settings.cooldownSeconds * 1000) return { pop: false, reason: 'cooldown' };
  clock.lastPopAt = now;
  return { pop: true };
}
