import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';
import type { BadgeLookup } from './badges.js';
import type { DimaChat, DimaChatClear, DimaChatDelete, DimaPart, DimaRoles } from './types.js';

const MAX_TEXT = 2000;
const MAX_PARTS = 200;
const kinds: Record<IChatMessage['message_type'], DimaChat['kind']> = {
  text: 'text', channel_points_highlighted: 'highlighted', channel_points_sub_only: 'text',
  user_intro: 'intro', power_ups_message_effect: 'power-up', power_ups_gigantify_emote: 'gigantified'
};

export function normalizeChatMessage(event: IChatMessage, badges: BadgeLookup, now = Date.now()): DimaChat {
  const rawText = event.message.text;
  const action = rawText.startsWith('\u0001ACTION ') && rawText.endsWith('\u0001');
  const text = (action ? rawText.slice(8, -1) : rawText).slice(0, MAX_TEXT);
  const fragments = event.message.fragments;
  const parts: DimaPart[] = [];
  let remaining = MAX_TEXT;
  for (const [index, fragment] of fragments.slice(0, MAX_PARTS).entries()) {
    let partText = fragment.text;
    if (action && index === 0 && fragment.type === 'text') partText = partText.replace(/^\u0001ACTION /, '');
    if (action && index === fragments.length - 1 && fragment.type === 'text') partText = partText.replace(/\u0001$/, '');
    if (!remaining) break;
    partText = partText.slice(0, remaining);
    remaining -= partText.length;
    if (fragment.type === 'emote' && fragment.emote) {
      const { id, format } = fragment.emote;
      const animated = format.includes('animated');
      const base = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/${animated ? 'animated' : 'static'}/dark/`;
      parts.push({ type: 'emote', text: partText, id, animated, images: { '1x': base + '1.0', '2x': base + '2.0', '4x': base + '3.0' } });
    } else if (fragment.type === 'cheermote' && fragment.cheermote) {
      parts.push({ type: 'cheer', text: partText, ...fragment.cheermote });
    } else if (fragment.type === 'mention' && fragment.mention) {
      // Helix sends flat mention fields; the legacy internal interface nests them under user.
      const mention = fragment.mention as { user?: { user_id: string; user_login: string; user_name: string }; user_id?: string; user_login?: string; user_name?: string };
      const user = mention.user ?? mention;
      parts.push({ type: 'mention', text: partText, user: { id: user.user_id ?? '', login: user.user_login ?? '', name: user.user_name ?? '' } });
    } else parts.push({ type: 'text', text: partText });
  }
  if (!parts.length && text) parts.push({ type: 'text', text });

  const sets = new Set(event.badges.map(badge => badge.set_id));
  const roles: DimaRoles = {
    broadcaster: sets.has('broadcaster'), moderator: sets.has('moderator'), vip: sets.has('vip'),
    subscriber: sets.has('subscriber') || sets.has('founder'), founder: sets.has('founder'),
    artist: sets.has('artist-badge'), staff: sets.has('staff'), partner: sets.has('partner'),
    turbo: sets.has('turbo'), prime: sets.has('premium')
  };
  const months = event.badges.find(badge => badge.set_id === 'subscriber')?.info
    ?? event.badges.find(badge => badge.set_id === 'founder')?.info;
  const subMonths = months && /^\d+$/.test(months) ? Number(months) : null;
  return {
    id: event.message_id, platform: 'twitch', at: now,
    user: {
      id: event.chatter_user_id ?? '', login: event.chatter_user_login ?? '', name: event.chatter_user_name ?? '',
      color: event.color || null, roles, subMonths: subMonths !== null && Number.isSafeInteger(subMonths) ? subMonths : null,
      badges: event.badges.map(badge => {
        const known = badges.get(`${badge.set_id}/${badge.id}`);
        return { set: badge.set_id, version: badge.id, info: badge.info,
          title: known?.title ?? badge.set_id, images: known ? { ...known.images } : { '1x': '', '2x': '', '4x': '' } };
      })
    },
    text, parts, kind: kinds[event.message_type] ?? 'text', action, firstMessage: event.message_type === 'user_intro',
    bits: event.cheer?.bits ?? 0, rewardId: event.channel_points_custom_reward_id || null,
    reply: event.reply ? {
      id: event.reply.parent_message_id,
      user: { id: event.reply.parent_user_id, login: event.reply.parent_user_login, name: event.reply.parent_user_name },
      text: event.reply.parent_message_body.slice(0, MAX_TEXT)
    } : null,
    sharedChat: event.source_broadcaster_user_id && event.source_broadcaster_user_id !== event.broadcaster_user_id
      ? { channelId: event.source_broadcaster_user_id, messageId: event.source_message_id ?? '' } : null
  };
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}
function userId(raw: Record<string, unknown>): string | null {
  return typeof raw.target_user_id === 'string' && raw.target_user_id ? raw.target_user_id : null;
}
export function normalizeChatDelete(raw: unknown): DimaChatDelete {
  const event = record(raw);
  return { messageId: typeof event.message_id === 'string' ? event.message_id : '', userId: userId(event) };
}
export function normalizeChatClear(type: string, raw: unknown): DimaChatClear {
  return { userId: type === 'channel.chat.clear_user_messages' ? userId(record(raw)) : null };
}
