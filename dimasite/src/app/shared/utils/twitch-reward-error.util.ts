/**
 * Twitch channel points reward limits and errors, shared by every page that makes rewards
 * (Redemptions, Triggers). Twitch caps a channel at 50 custom rewards, counting turned-off
 * and paused ones and rewards made by other apps or in the Twitch dashboard.
 */
export const TWITCH_REWARD_LIMIT = 50;

/** A Twitch reward error stays up this long: it tells the streamer what to do next. */
export const TWITCH_REWARD_ERROR_TOAST_MS = 12_000;

export type TwitchRewardErrorKind = 'tooMany' | 'duplicate';

/** Recognises Twitch's reward error codes (e.g. CREATE_CUSTOM_REWARD_TOO_MANY_REWARDS) in an API message. */
export function twitchRewardErrorKind(message: string | null | undefined): TwitchRewardErrorKind | null {
  if (!message) return null;
  if (/TOO_MANY_REWARDS|maximum number of (custom )?rewards/i.test(message)) return 'tooMany';
  if (/DUPLICATE_REWARD/i.test(message)) return 'duplicate';
  return null;
}
