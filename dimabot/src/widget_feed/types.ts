type Platform = 'twitch';

export interface DimaUser { id: string; login: string; name: string }
export interface DimaChat {
  id: string; platform: Platform; at: number;
  user: DimaUser & { color: string | null; badges: DimaBadge[]; roles: DimaRoles; subMonths: number | null };
  text: string; parts: DimaPart[]; kind: 'text' | 'highlighted' | 'intro' | 'power-up' | 'gigantified';
  action: boolean; firstMessage: boolean; bits: number; rewardId: string | null;
  reply: { id: string; user: DimaUser; text: string } | null;
  sharedChat: { channelId: string; messageId: string } | null;
}
export interface DimaBadge { set: string; version: string; info: string; title: string; images: { '1x': string; '2x': string; '4x': string } }
export interface DimaRoles { broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean; founder: boolean;
  artist: boolean; staff: boolean; partner: boolean; turbo: boolean; prime: boolean }
export type DimaPart =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; id: string; animated: boolean; images: { '1x': string; '2x': string; '4x': string } }
  | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number }
  | { type: 'mention'; text: string; user: DimaUser };
export interface DimaChatDelete { messageId: string; userId: string | null }
export interface DimaChatClear { userId: string | null }

export type WidgetFeedMessage = {
  channel: string;
  type: 'chat' | 'chat.delete' | 'chat.clear';
  data: DimaChat | DimaChatDelete | DimaChatClear;
};
export const WIDGET_FEED_CHANNEL = 'widget-feed';
export const widgetFeedDemandKey = (channel: string): string => 'widget-feed:demand:' + channel;

/** A widget signal: a named message from a command (or Studio test) to the channel's custom widgets. */
export interface DimaSignal {
  id: string; name: string;
  /** Evaluated arguments joined with spaces (viewer text: show with textContent / Dima.escape). */
  value: string;
  /** `value` parsed as JSON when it is a number, boolean, array or object; otherwise null. */
  json: unknown;
  /** `value` split on whitespace. */
  args: string[];
  at: number;
  user: { id: string; login: string; name: string; roles: { broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean } } | null;
  source: { kind: 'command' | 'keyword' | 'event' | 'studio'; name: string };
  /** Layer name for `widget.signal.to`; null sends to every layer that uses signals. */
  target: string | null;
}
export interface WidgetSignalMessage { channel: string; type: 'signal'; data: DimaSignal }
export const SIGNAL_NAME = /^[a-z0-9_]{1,40}$/;
export const SIGNAL_LIMITS = { value: 500, target: 80, perChannel: 30, windowSeconds: 10 } as const;
export const widgetSignalRateKey = (channel: string) => 'widget-signal:rate:' + channel;
export const widgetSignalSkippedKey = (channel: string) => 'widget-signal:skipped:' + channel;
