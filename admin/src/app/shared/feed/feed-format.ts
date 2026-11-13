import { FeedItem, FeedKind, FeedOutcome } from '../../services/feed-api.service';
import { formatCredits, formatDuration, formatNumber, formatUSD } from '../format';

/**
 * How one feed row reads to the operator: a plain sentence, a secondary line, an icon and a tone.
 * All wording for the activity feed lives here so every page says the same thing the same way.
 */
export type FeedTone = 'ok' | 'muted' | 'warn' | 'danger' | 'live' | 'accent' | 'gold';

export interface FeedLine {
  icon: string;
  tone: FeedTone;
  /** The sentence. May name the command, the event or the viewer. */
  title: string;
  /** What was said or written (shown as a quote); null when the row has no text. */
  quote: string | null;
  /** A few short facts under the title ("fish · 49 characters"); null when the title says it all. */
  detail: string | null;
  /** What it cost, e.g. "74 credits" or "$0.0002"; null when it cost nothing worth showing. */
  cost: string | null;
}

export const FEED_KIND_LABEL: Record<FeedKind, { one: string; many: string; icon: string }> = {
  command: { one: 'Command', many: 'Commands', icon: 'command' },
  bot_message: { one: 'Bot message', many: 'Bot messages', icon: 'message' },
  twitch_event: { one: 'Twitch event', many: 'Twitch events', icon: 'twitch' },
  alert: { one: 'Chat alert', many: 'Chat alerts', icon: 'bell' },
  protection: { one: 'Chat protection', many: 'Chat protection', icon: 'shield' },
  voice: { one: 'Voice', many: 'Voice', icon: 'mic' },
  ai: { one: 'AI', many: 'AI', icon: 'sparkles' },
  assistant: { one: 'Assistant', many: 'Assistant', icon: 'bot' },
  docs: { one: 'Docs AI', many: 'Docs AI', icon: 'book' },
  credits: { one: 'Credits', many: 'Credits', icon: 'credits' },
  system: { one: 'System', many: 'System', icon: 'settings' },
};

/** Plain names for Twitch event types: "a follow", used as "Follow alert sent", "New follower". */
const TWITCH_EVENT: Record<string, { happened: string; noun: string }> = {
  'channel.follow': { happened: 'New follower', noun: 'Follow' },
  'channel.subscribe': { happened: 'New sub', noun: 'Sub' },
  'channel.subscription.message': { happened: 'Resub message', noun: 'Resub' },
  'channel.subscription.gift': { happened: 'Gifted subs', noun: 'Gift sub' },
  'channel.subscription.end': { happened: 'Sub ended', noun: 'Sub end' },
  'channel.cheer': { happened: 'Cheered bits', noun: 'Bits' },
  'channel.bits.use': { happened: 'Used bits', noun: 'Bits' },
  'channel.bit.use': { happened: 'Used bits', noun: 'Bits' },
  'channel.raid': { happened: 'Raid', noun: 'Raid' },
  'channel.chat.notification': { happened: 'Chat announcement', noun: 'Chat announcement' },
  'stream.online': { happened: 'Stream started', noun: 'Stream start' },
  'stream.offline': { happened: 'Stream ended', noun: 'Stream end' },
  'channel.channel_points_custom_reward_redemption.add': { happened: 'Reward redeemed', noun: 'Reward' },
  'channel.update': { happened: 'Title or category changed', noun: 'Channel update' },
  'user.update': { happened: 'Twitch profile changed', noun: 'Profile update' },
  'channel.ban': { happened: 'Viewer banned by a mod', noun: 'Ban' },
  'channel.shoutout.receive': { happened: 'Shoutout received', noun: 'Shoutout' },
  'automod.message.hold': { happened: 'AutoMod held a message', noun: 'AutoMod hold' },
  'channel.chat.clear': { happened: 'Chat cleared', noun: 'Chat clear' },
  'channel.chat.clear_user_messages': { happened: "A viewer's messages were cleared", noun: 'Message clear' },
  'channel.chat.message_delete': { happened: 'Message deleted by a mod', noun: 'Message delete' },
  'channel.poll.begin': { happened: 'Poll started', noun: 'Poll' },
  'channel.poll.end': { happened: 'Poll ended', noun: 'Poll' },
  'channel.prediction.begin': { happened: 'Prediction started', noun: 'Prediction' },
  'channel.prediction.lock': { happened: 'Prediction locked', noun: 'Prediction' },
  'channel.prediction.end': { happened: 'Prediction ended', noun: 'Prediction' },
  'channel.hype_train.begin': { happened: 'Hype train started', noun: 'Hype train' },
  'channel.hype_train.end': { happened: 'Hype train ended', noun: 'Hype train' },
  'channel.ad_break.begin': { happened: 'Ad break started', noun: 'Ad break' },
  'channel.goal.begin': { happened: 'Goal started', noun: 'Goal' },
  'channel.goal.end': { happened: 'Goal ended', noun: 'Goal' },
};

/** "New follower" for a Twitch type; an unknown type is shown as it is rather than hidden. */
export function twitchEventLabel(type: string): string {
  return TWITCH_EVENT[type]?.happened ?? type;
}
export function twitchEventNoun(type: string): string {
  return TWITCH_EVENT[type]?.noun ?? type;
}

/** Why something did not happen, in the operator's words. Unknown codes are shown as written. */
const REASON: Record<string, string> = {
  cooldown: 'it is on cooldown',
  disabled: 'it is turned off',
  permission_denied: "this viewer isn't allowed to use it",
  permission_invalid: 'its permission rule is broken',
  error: 'something went wrong',
  held_for_moderation: 'Twitch held it for moderation',
  twitch_rejected: 'Twitch refused it',
  no_token: "the bot couldn't sign in to Twitch",
  exception: 'the bot hit an error',
  chat_disabled: 'chat is turned off for this channel',
  alert_disabled: 'this alert is turned off',
  follow_defense: 'follow protection was holding alerts',
  empty_message: 'the alert has no message',
  shared_chat: 'it came from a shared chat',
  stale: 'the event was too old',
  unsupported: "this kind isn't announced",
  legacy_bits: 'the newer bits event covers it',
  send_failed: "the message couldn't be sent",
  handler_error: 'the bot crashed while handling it',
  synthesis_failed: "the voice couldn't be generated",
  no_credits: 'the channel has no credits left',
  timeout: 'the review took too long',
  unavailable: 'the AI provider was down',
  rate_limited: 'the AI provider was rate limiting us',
  invalid_response: 'the AI answer could not be read',
  credits_unavailable: 'the channel has no credits left',
  quota_exhausted: 'the review limit was reached',
  plan_required: "the channel's plan doesn't include it",
  action_failed: 'Twitch refused the action',
  authorization_revoked: 'the streamer removed our access',
  user_removed: 'the Twitch account no longer exists',
  notification_failures_exceeded: 'Twitch could not reach us too many times',
  version_removed: 'Twitch retired this event version',
};
export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON[reason] ?? reason.replace(/_/g, ' ');
}

const ACTION_DONE: Record<string, string> = { ban: 'Banned', timeout: 'Timed out', delete: 'Deleted a message from', warn: 'Warned' };
const ACTION_NOUN: Record<string, string> = { ban: 'Ban', timeout: 'Timeout', delete: 'Delete', warn: 'Warning' };
const RULE_NAME: Record<string, string> = { caps: 'Caps rule', links: 'Links rule', emote_spam: 'Emote spam rule', blacklist: 'Blocked words rule', builtin: 'Chat protection' };
const AI_OPERATION: Record<string, string> = {
  message: 'AI reply', final_response: 'AI reply', tool_reasoning: 'AI reply (thinking step)',
  stream_summary: 'Stream memory summary', weekly_summary: 'Weekly memory summary', monthly_summary: 'Monthly memory summary',
  pet_ask: 'Pet answer', planner: 'AI agent plan', coding_agent: 'AI agent step', vod_clip_recommendation: 'Clip recommendations',
};
const VOICE_SOURCE: Record<string, string> = {
  ast: 'command', redemption: 'reward', pet: 'pet', voice_preview: 'voice preview', oauth_desktop: 'desktop app', dimafx: 'DimaFX', overlay_test: 'overlay test',
};
const BOT_ORIGIN: Record<string, string> = {
  command: 'command reply', timer: 'timer', alert: 'alert', ai: 'AI reply', moderation: 'moderation notice',
  follow_defense: 'follow protection', redemption: 'reward', system: 'system', bot: 'bot',
};
const ADJUSTMENT: Record<string, string> = {
  manual_grant: 'granted by an admin', native_grant: 'plan credits', monthly_reset: 'monthly reset', purchased_pack: 'credit pack',
  subscription_credits: 'subscription credits', gifted_credits: 'gifted', refund: 'refund', correction: 'correction', activation: 'welcome credits',
};

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const who = (item: FeedItem): string => item.actor?.name || item.actor?.login || 'a viewer';
const percent = (score: number | null): string | null => (score === null ? null : `${Math.round(score * 100)}%`);
const join = (...parts: Array<string | null | undefined | false>): string | null => parts.filter(Boolean).join(' · ') || null;
const because = (item: FeedItem): string => {
  const reason = reasonText(item.reason);
  return reason ? `: ${reason}` : '';
};

/** Tone for an outcome when the kind has nothing more specific to say. */
function toneFor(outcome: FeedOutcome): FeedTone {
  return outcome === 'failed' ? 'danger' : outcome === 'blocked' ? 'warn' : outcome === 'skipped' ? 'muted' : 'ok';
}

function cost(item: FeedItem): string | null {
  if (item.credits !== null && item.credits !== 0) return item.credits < 0 ? `+${formatCredits(-item.credits, true)}` : formatCredits(item.credits, true);
  if (item.providerUSD !== null && item.providerUSD > 0) return formatUSD(item.providerUSD);
  return null;
}

/** "tiny_anvil followed", "Mossy_Fern cheered 500 bits": a Twitch event as a sentence about the viewer. */
function eventSentence(item: FeedItem): string {
  const data = item.data || {};
  const amount = num(data['amount']);
  const viewers = num(data['viewers']);
  const months = num(data['months']);
  const reward = text(data['rewardTitle']);
  const name = item.actor ? who(item) : null;
  switch (item.name) {
    case 'channel.follow': return name ? `${name} followed` : 'New follower';
    case 'channel.subscribe': return name ? `${name} subscribed` : 'New sub';
    case 'channel.subscription.message': return name ? `${name} resubscribed${months && months > 1 ? ` (${months} months)` : ''}` : 'Resub message';
    case 'channel.subscription.gift': return name ? `${name} gifted ${amount ?? 'some'} ${amount === 1 ? 'sub' : 'subs'}` : 'Gifted subs';
    case 'channel.subscription.end': return name ? `${name}'s sub ended` : 'Sub ended';
    case 'channel.cheer':
    case 'channel.bits.use':
    case 'channel.bit.use': return name ? `${name} cheered ${amount !== null ? formatNumber(amount) : ''} bits`.replace('  ', ' ') : 'Bits used';
    case 'channel.raid': return name ? `${name} raided${viewers !== null ? ` with ${formatNumber(viewers)} viewers` : ''}` : 'Raid';
    case 'channel.channel_points_custom_reward_redemption.add': return `${name ?? 'A viewer'} redeemed ${reward ? `“${reward}”` : 'a reward'}`;
    case 'channel.ban': return name ? `${name} was banned by a mod` : 'Viewer banned by a mod';
    case 'channel.shoutout.receive': return name ? `Shoutout from ${name}` : 'Shoutout received';
    case 'automod.message.hold': return name ? `AutoMod held a message from ${name}` : 'AutoMod held a message';
    case 'channel.chat.clear_user_messages': return name ? `${name}'s messages were cleared` : "A viewer's messages were cleared";
    default: return twitchEventLabel(item.name);
  }
}

export function feedLine(item: FeedItem): FeedLine {
  const data = item.data || {};
  const base = { icon: FEED_KIND_LABEL[item.kind]?.icon ?? 'info', tone: toneFor(item.outcome), quote: item.text, detail: null as string | null, cost: cost(item) };

  switch (item.kind) {
    case 'command': {
      const trigger = text(data['trigger']);
      const name = item.name;
      if (trigger === 'timer') {
        return { ...base, icon: 'timer', title: item.outcome === 'ok' ? `Timer ${name} posted` : `Timer ${name} didn't post${because(item)}` };
      }
      if (item.outcome === 'ok') return { ...base, title: `${name} answered ${who(item)}`, detail: trigger === 'keyword' ? 'Started by a keyword' : null };
      if (item.outcome === 'failed') return { ...base, title: `${name} failed for ${who(item)}${because(item)}` };
      return { ...base, title: `${name} didn't answer ${who(item)}${because(item)}` };
    }
    case 'bot_message': {
      const origin = item.name === 'bot' ? null : (BOT_ORIGIN[item.name] ?? item.name);
      if (item.outcome === 'ok') return { ...base, tone: 'accent', title: origin ? `Bot said (${origin})` : 'Bot said' };
      return { ...base, title: `Bot message not sent${because(item)}`, detail: text(data['twitchMessage']) };
    }
    case 'twitch_event': {
      if (item.outcome === 'failed') return { ...base, title: `${twitchEventNoun(item.name)} event${because(item)}`, detail: text(data['error']) };
      return {
        ...base, tone: 'accent',
        title: `${eventSentence(item)}${data['test'] === true ? ' (test)' : ''}`,
        quote: item.text ?? text(data['message']),
        detail: data['managed'] === false ? 'Not a reward Dima manages' : null,
      };
    }
    case 'alert': {
      const noun = twitchEventNoun(item.name);
      if (item.outcome === 'ok') return { ...base, title: `${noun} alert sent` };
      if (item.outcome === 'failed') return { ...base, title: `${noun} alert failed${because(item)}` };
      return { ...base, tone: 'warn', title: `${noun} alert not sent${because(item)}` };
    }
    case 'protection': {
      const action = text(data['action']);
      const ruleType = text(data['ruleType']) ?? 'builtin';
      const rule = RULE_NAME[ruleType] ?? 'Rule';
      const topScore = num(data['topScore']);
      const category = text(data['topCategory'])?.replace(/_/g, ' ');
      const scored = category && topScore !== null ? `${category} ${percent(topScore)}` : null;
      const model = text(data['model'])?.split('/').pop() ?? null;
      const detail = join(ruleType === 'builtin' ? null : rule, scored, model);
      if (item.reason === 'action_failed') {
        return { ...base, tone: 'warn', title: `${ACTION_NOUN[action ?? ''] ?? 'Action'} on ${who(item)} refused by Twitch`, detail: join(text(data['actionError']), scored) };
      }
      if (item.outcome === 'failed') return { ...base, tone: 'warn', title: `${who(item)}'s message was not reviewed${because(item)}`, detail: model };
      if (action && data['actionSucceeded'] === true) {
        return { ...base, tone: action === 'ban' ? 'live' : 'warn', title: `${ACTION_DONE[action] ?? action} ${who(item)}`, detail };
      }
      return { ...base, tone: 'muted', title: `${who(item)}'s message was allowed`, detail };
    }
    case 'voice': {
      const chars = num(data['chars']);
      const source = VOICE_SOURCE[text(data['source']) ?? ''] ?? text(data['source']);
      const detail = join(item.name, text(data['voice']), chars !== null ? `${formatNumber(chars)} characters` : null, source ? `from a ${source}` : null);
      if (item.outcome === 'ok') return { ...base, title: `Voice for ${who(item)}`, detail };
      const fallback = text(data['fallback']);
      return {
        ...base,
        title: `Voice for ${who(item)} ${item.outcome === 'failed' ? 'failed' : 'skipped'}${because(item)}`,
        detail: join(detail, fallback ? `${fallback} spoke instead` : null),
      };
    }
    case 'ai': {
      const label = AI_OPERATION[item.name] ?? item.name.replace(/_/g, ' ');
      const tokens = num(data['tokens']);
      return {
        ...base,
        title: `${label}${item.actor ? ` for ${who(item)}` : ''}`,
        detail: join(text(data['model'])?.split('/').pop(), tokens !== null ? `${formatNumber(tokens)} tokens` : null),
      };
    }
    case 'assistant': {
      const steps = num(data['steps']);
      const detail = join(item.name === 'expert' ? 'Expert' : 'Standard', steps !== null ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : null,
        item.durationMs !== null ? formatDuration(item.durationMs) : null);
      if (item.outcome === 'failed') return { ...base, title: `Assistant failed for ${who(item)}${because(item)}`, detail };
      if (item.outcome === 'skipped') return { ...base, title: `${who(item)} stopped the assistant`, detail };
      return { ...base, tone: 'accent', title: `Assistant answered ${who(item)}`, detail };
    }
    case 'docs': {
      const feedback = text(data['feedback']);
      const detail = join(text(data['page']), feedback === 'helpful' ? 'Rated helpful' : feedback === 'unhelpful' ? 'Rated not helpful' : null);
      if (item.outcome === 'failed') return { ...base, title: `Docs AI could not answer${because(item)}`, detail };
      return { ...base, tone: 'accent', title: 'Docs AI answered a question', detail };
    }
    case 'credits': {
      const type = ADJUSTMENT[text(data['adjustmentType']) ?? ''] ?? text(data['adjustmentType'])?.replace(/_/g, ' ') ?? 'adjustment';
      const amount = item.credits ?? 0;
      return { ...base, tone: 'gold', title: amount <= 0 ? `Credits added (${type})` : `Credits removed (${type})` };
    }
    case 'system': {
      if (item.name === 'eventsub.revoked') {
        return { ...base, icon: 'twitch', title: `Twitch stopped sending “${twitchEventLabel(text(data['type']) ?? '')}”${because(item)}` };
      }
      return { ...base, title: `${item.name.replace(/[._]/g, ' ')}${item.outcome === 'ok' ? '' : because(item)}` };
    }
  }
}

/** Labels for the `data` keys shown in a row's details. Keys without a label are shown as they are. */
const DATA_LABEL: Record<string, string> = {
  func: 'Runs', trigger: 'Started by', live: 'Channel was live', origin: 'Came from', messageId: 'Twitch message', httpStatus: 'Twitch status',
  twitchMessage: 'Twitch said', amount: 'Amount', tier: 'Tier', months: 'Months', viewers: 'Viewers', rewardTitle: 'Reward', rewardCost: 'Reward cost',
  message: 'Message', test: 'Test event', failedDeliveries: 'Failed deliveries', event: 'Event', eventKey: 'Event', verdict: 'Verdict', status: 'Status',
  action: 'Action', actionSucceeded: 'Twitch accepted it', actionError: 'Twitch said', topCategory: 'Top category', topScore: 'Scored', model: 'Model',
  included: 'Included review', ruleType: 'Rule', source: 'Source', provider: 'Provider', chars: 'Characters', voice: 'Voice', category: 'Category',
  operation: 'Operation', tokens: 'Tokens', level: 'Level', steps: 'Steps', tools: 'Tool calls', errorCode: 'Error', units: 'Daily messages used',
  lang: 'Language', page: 'Page', feedback: 'Rating', rounds: 'Rounds', adjustmentType: 'Type', managed: 'Managed by Dima', fallback: 'Fallback',
  title: 'Title', moderator: 'Moderator', reason: 'Reason', permanent: 'Permanent', from: 'From', error: 'Error', type: 'Type', replyTo: 'Reply to',
  latencyMs: 'Time', subscriptionId: 'Subscription', rewardId: 'Reward id',
};

/** Internal values the operator should read in plain words. */
const VALUE: Record<string, Record<string, string>> = {
  trigger: { chat: 'A chat message', keyword: 'A keyword', timer: 'A timer', redemption: 'A reward', reference: 'Another command' },
  source: { ...VOICE_SOURCE, first_message: "The viewer's first messages", spam_continuous: 'Every message (opt-in)', rule: "A streamer's rule",
    chat: 'chat', moderation: 'chat protection', stream_summary: 'stream summary', admin_credit_grant: 'admin grant' },
  origin: BOT_ORIGIN,
  action: { ban: 'Ban', timeout: 'Timeout', delete: 'Delete the message', warn: 'Warning' },
  feedback: { helpful: 'Helpful', unhelpful: 'Not helpful' },
  level: { standard: 'Standard', expert: 'Expert' },
  adjustmentType: ADJUSTMENT,
};
/** Keys the row's sentence already covers, or that only mean something to the code. */
const HIDDEN = new Set(['message', 'verdict', 'ruleType', 'live', 'topCategory', 'category', 'event']);

/** The row's facts as label/value pairs for its details. */
export function feedFacts(item: FeedItem): Array<{ label: string; value: string; mono: boolean }> {
  const facts: Array<{ label: string; value: string; mono: boolean }> = [];
  const data = item.data || {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === '' || HIDDEN.has(key)) continue;
    // A finished review is the normal case; only an unusual status is worth a line.
    if (key === 'status' && (value === 'completed' || value === 'matched')) continue;
    if (key === 'actionSucceeded') continue;
    let shown: string;
    if (key === 'action') shown = `${VALUE['action'][String(value)] ?? value}${data['actionSucceeded'] === false ? ' (Twitch refused)' : ''}`;
    else if (key === 'topScore' && typeof value === 'number') shown = `${text(data['topCategory'])?.replace(/_/g, ' ') ?? 'Highest'} ${Math.round(value * 100)}%`;
    else if (key === 'latencyMs' && typeof value === 'number') shown = formatDuration(value);
    else if (typeof value === 'boolean') shown = value ? 'Yes' : 'No';
    else if (typeof value === 'number') shown = formatNumber(value);
    else shown = VALUE[key]?.[value] ?? reasonText(key === 'status' ? value : null) ?? String(value);
    facts.push({ label: DATA_LABEL[key] ?? key, value: shown, mono: /Id$|^eventKey$/.test(key) });
  }
  if (item.durationMs !== null) facts.push({ label: 'Took', value: formatDuration(item.durationMs), mono: false });
  if (item.credits !== null) facts.push({ label: 'Credits', value: item.credits === 0 ? 'None (free)' : `${item.credits < 0 ? '+' : ''}${formatCredits(Math.abs(item.credits))}`, mono: false });
  if (item.providerUSD !== null && item.providerUSD > 0) facts.push({ label: 'Provider cost', value: formatUSD(item.providerUSD), mono: false });
  return facts;
}
