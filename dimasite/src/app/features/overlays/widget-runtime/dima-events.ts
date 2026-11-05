/** Dima SDK v1 event shapes (dimabot/CUSTOM_WIDGET_ENGINE.md, section 4). Data only; shared by the host, tests and fixtures. */
export type DimaPlatform = 'twitch';
export interface DimaUser { id: string; login: string; name: string }
export interface DimaImages { '1x': string; '2x': string; '4x': string }
export interface DimaBadge { set: string; version: string; info: string; title: string; images: DimaImages }
export interface DimaRoles {
  broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean; founder: boolean;
  artist: boolean; staff: boolean; partner: boolean; turbo: boolean; prime: boolean;
}
export type DimaPart =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; id: string; animated: boolean; images: DimaImages }
  | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number }
  | { type: 'mention'; text: string; user: DimaUser };
export interface DimaChat {
  id: string; platform: DimaPlatform; at: number;
  user: DimaUser & { color: string | null; badges: DimaBadge[]; roles: DimaRoles; subMonths: number | null };
  text: string; parts: DimaPart[]; kind: 'text' | 'highlighted' | 'intro' | 'power-up' | 'gigantified';
  action: boolean; firstMessage: boolean; bits: number; rewardId: string | null;
  reply: { id: string; user: DimaUser; text: string } | null;
  sharedChat: { channelId: string; messageId: string } | null;
}
export interface DimaChatDelete { messageId: string; userId: string | null }
export interface DimaChatClear { userId: string | null }
export type DimaAlertType = 'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid' | 'tip';
export interface DimaAlert {
  id: string; type: DimaAlertType; at: number; test: boolean;
  user: DimaUser | null; amount: number;
  tier: '1000' | '2000' | '3000' | 'prime' | null; months: number | null; streak: number | null;
  message: string | null; recipient: DimaUser | null; currency: string | null; rule: { id: string; name: string } | null;
}
export interface DimaButton { field: string; value: unknown }
/** `namespace` is `se` for StreamElements widgets and the widget id for Dima widgets; frames only see their own. */
export interface DimaStoreUpdate { key: string; value: unknown; namespace?: string }
/** StreamElements-style session snapshot: `data` keys like `follower-latest`, `cheer-session`, `subscriber-recent`. */
export interface DimaSession { data: Record<string, unknown>; recents: unknown[] }
export type DimaEvent =
  | { type: 'chat'; data: DimaChat }
  | { type: 'chat.delete'; data: DimaChatDelete }
  | { type: 'chat.clear'; data: DimaChatClear }
  | { type: 'alert'; data: DimaAlert }
  | { type: 'button'; data: DimaButton }
  | { type: 'store'; data: DimaStoreUpdate }
  | { type: 'session'; data: DimaSession };
export type DimaEventType = DimaEvent['type'];
/** Which manifest `uses` entry lets a widget receive each event. Buttons are editor-only and always allowed. */
export const EVENT_USES: Record<DimaEventType, string | null> = {
  chat: 'chat', 'chat.delete': 'chat', 'chat.clear': 'chat', alert: 'alerts', button: null, store: 'store', session: 'session'
};
