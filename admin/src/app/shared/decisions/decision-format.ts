import type { DecisionDetail, DecisionLabel, DecisionRow, DecisionShow, DecisionSort } from '../../services/decisions-api.service';
import { formatCreditValue, formatCredits, formatUSD } from '../format';

/**
 * How a chat protection decision reads to the operator. Every page that names a decision (the ledger, a
 * channel's Protection tab, the detail sheet) uses these, so a ban is always called the same thing.
 */
export type DecisionTone = 'danger' | 'warn' | 'accent' | 'ok' | 'gold' | 'muted';

/** Category names the model is asked about, in the owner's words. `short` fits a row's meta line. */
const CATEGORY: Record<string, { name: string; short: string }> = {
  spam: { name: 'Spam / scams', short: 'spam' },
  ads: { name: 'Ads / sales', short: 'ads' },
  self_promotion: { name: 'Self-promotion', short: 'self promotion' },
  profanity: { name: 'Profanity', short: 'profanity' },
  insults: { name: 'Insults', short: 'insults' },
};
export const categoryName = (key: string): string => CATEGORY[key]?.name ?? key.replace(/_/g, ' ');
export const categoryShort = (key: string): string => CATEGORY[key]?.short ?? key.replace(/_/g, ' ');

/** The model answered in time (sure or unsure); anything else never finished. */

const RULE_NAME: Record<string, string> = {
  caps: 'caps',
  links: 'links',
  emote_spam: 'emote spam',
  blacklist: 'blocked words',
  blocked_words: 'blocked words',
};
export const ruleName = (type: string): string => RULE_NAME[type] ?? type.replace(/_/g, ' ');

const ACTION_DONE: Record<string, string> = { ban: 'Banned', timeout: 'Timed out', delete: 'Deleted', warn: 'Warned' };
const ACTION_NOUN: Record<string, string> = { ban: 'ban', timeout: 'timeout', delete: 'delete', warn: 'warning' };

/** Floors, never rounds up: 84.96% must not read as an 85% bar. */
export const percent = (value: number | undefined | null): number => Math.floor((value ?? 0) * 1000 + 1e-6) / 10;

/** The categories the model scored, highest first (without the `safe` and `violation` summaries). */
export function scoredCategories(row: Pick<DecisionRow, 'scores'>, asked: string[] = []): Array<{ key: string; value: number }> {
  const scores = row.scores ?? {};
  const keys = new Set([...asked, ...Object.keys(scores)]);
  keys.delete('safe');
  keys.delete('violation');
  return [...keys].map((key) => ({ key, value: typeof scores[key] === 'number' ? scores[key] : 0 })).sort((a, b) => b.value - a.value);
}

export function topCategory(row: Pick<DecisionRow, 'scores'>): { key: string; value: number } | null {
  if (!row.scores) return null;
  return scoredCategories(row).find((item) => item.value > 0) ?? null;
}

export function isNearMiss(row: Pick<DecisionRow, 'nearMiss'>): boolean {
  return row.nearMiss === true;
}

/** What happened, as a short label and a tone: the row's lead chip. */
export function outcomeLabel(row: Pick<DecisionRow, 'kind' | 'verdict' | 'outcome' | 'status' | 'scores' | 'action'>): { label: string; tone: DecisionTone; icon: string } {
  const action = row.action ?? '';
  if (row.outcome === 'acted') {
    if (action === 'ban') return { label: 'Banned', tone: 'danger', icon: 'ban' };
    if (action === 'warn') return { label: 'Warned', tone: 'accent', icon: 'alert' };
    return { label: ACTION_DONE[action] ?? 'Acted', tone: 'warn', icon: action === 'timeout' ? 'timer' : 'x' };
  }
  if (row.outcome === 'action_failed') {
    return { label: action === 'ban' || !action ? 'Ban refused' : `${capital(ACTION_NOUN[action] ?? action)} refused`, tone: 'warn', icon: 'alert' };
  }
  if (row.outcome === 'not_reviewed') return { label: 'Not reviewed', tone: 'muted', icon: 'clock' };
  if (isNearMiss(row as DecisionRow)) return { label: 'Almost banned', tone: 'gold', icon: 'shield' };
  return { label: 'Allowed', tone: 'ok', icon: 'ok' };
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Why a review never finished, as the end of "Not reviewed: …". */
function notReviewedReason(status: string): string {
  switch (status) {
    case 'timeout':
      return 'the review took too long';
    case 'unavailable':
    case 'invalid_response':
      return 'the AI service did not give a usable answer';
    case 'rate_limited':
      return 'too many reviews were running at once';
    case 'credits_unavailable':
    case 'quota_exhausted':
      return 'the channel had no reviews or credits left for it';
    case 'plan_required':
      return "the channel's plan does not include it";
    case 'policy_changed':
    case 'invalid_configuration':
      return "the channel's settings changed or were incomplete";
    case 'invalid_context':
      return 'the message could not be read for review';
    case 'pending':
      return 'the review never came back';
    default:
      return "the review didn't finish";
  }
}

/** Twitch's refusal in plain words. Its raw text is kept when there is no plainer way to say it. */
export function twitchSaid(error: string | null): string {
  if (!error) return "Twitch refused it but didn't say why.";
  if (/already banned/i.test(error)) return 'The viewer was already banned, so Twitch refused a second ban.';
  if (/not (a )?(mod|moderator)|missing.*scope|unauthori[sz]ed|forbidden/i.test(error)) return 'The bot was not allowed to do it (it may have lost moderator rights in this channel).';
  if (/rate limit|too many/i.test(error)) return 'Twitch was busy and asked the bot to slow down.';
  if (/broadcaster|cannot (ban|timeout).*(mod|broadcaster)/i.test(error)) return 'Twitch does not let the bot act on the streamer or a moderator.';
  return `Twitch said: "${error}"`;
}

/** One plain sentence: what happened and why. */
export function whatHappened(row: DecisionRow): string {
  const action = row.action ?? '';
  if (row.kind === 'rule') {
    const rule = `The ${ruleName(row.ruleType)} rule`;
    if (row.outcome === 'acted') {
      const did = action === 'ban' ? 'banned this viewer' : action === 'timeout' ? 'timed this viewer out' : action === 'delete' ? "deleted this viewer's message" : 'warned this viewer';
      return `${rule} ${did}.`;
    }
    if (row.outcome === 'action_failed') return `${rule} tried to ${action === 'delete' ? 'delete the message' : action === 'timeout' ? 'time this viewer out' : action === 'warn' ? 'warn this viewer' : 'ban this viewer'}, but Twitch refused.`;
    return `${rule} matched, but nothing was done.`;
  }
  const top = topCategory(row);
  const why = top ? ` for ${categoryShort(top.key)} (${percent(top.value)}%)` : '';
  const bar = row.thresholdPercent;
  if (row.outcome === 'not_reviewed') return `Not reviewed: ${notReviewedReason(row.status)}, so the message was let through.`;
  if (row.outcome === 'acted') {
    if (action === 'ban') return `Banned${why}. Twitch accepted the ban.`;
    if (action === 'timeout') return `Timed out${why}. Twitch accepted the timeout.`;
    if (action === 'delete') return `Message deleted${why}.`;
    return `Warned${why}.`;
  }
  if (row.outcome === 'action_failed') return `The bot tried to ${action === 'timeout' ? 'time this viewer out' : action === 'delete' ? 'delete the message' : 'ban'}${why}, but Twitch refused.`;
  if (row.verdict === 'uncertain') return "Allowed: the model wasn't sure, so the message was let through.";
  if (!top) return 'Allowed. The model found nothing to flag.';
  const scored = `${categoryShort(top.key)} ${percent(top.value)}%`;
  if (bar !== null && top.value * 100 >= bar) return `Allowed. ${capital(scored)} was over this channel's bar of ${bar}%, but the model judged the message safe overall.`;
  return `Allowed. Highest score: ${scored}${bar !== null ? `, below this channel's bar of ${bar}%` : ''}.`;
}

/** "1st", "2nd", "3rd". */
export function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${tail}`;
}

export const SOURCE_LABEL: Record<DecisionRow['source'], string> = {
  first_message: "Viewer's first messages",
  spam_continuous: 'Every message (opt-in)',
  rule: "A streamer's rule",
};

/** The model without its provider prefix: "gpt-6-luna-decisions". */
export const modelName = (model: string | null): string => (model ? model.slice(model.lastIndexOf('/') + 1) : '—');

/** Did the owner's verdict match what the bot concluded? Same test as the API's `feedback=agree`. */
export const verdictAgrees = (label: DecisionLabel, verdict: DecisionRow['verdict']): boolean => (label === 'violation' ? verdict === 'violation' : verdict !== 'violation');

export const LABEL_TEXT: Record<DecisionLabel, string> = { violation: 'Should be a ban', allow: 'Should not be a ban' };

/** What a decision cost, the two kinds of money kept apart: provider cost, then what the channel was charged. */
export function rowCost(row: Pick<DecisionRow, 'kind' | 'outcome' | 'providerUSD' | 'credits' | 'included'>): string[] {
  if (row.kind === 'rule') return [];
  const parts: string[] = [];
  if (row.providerUSD > 0) parts.push(`cost ${formatUSD(row.providerUSD)}`);
  // A review that never finished was not a free review either: say nothing unless it was charged.
  if (row.included) {
    if (row.outcome !== 'not_reviewed') parts.push('free review');
  }
  else if (row.credits > 0) parts.push(`${formatCredits(row.credits)} ${formatCreditValue(row.credits)}`);
  return parts;
}

/** The chip filters, in the owner's words. `kind: 'rule'` is the rule-hits chip. */
export const SHOW_CHIPS: Array<{ key: string; label: string; show: DecisionShow | null; kind: 'rule' | null }> = [
  { key: 'all', label: 'All', show: null, kind: null },
  { key: 'bans', label: 'Bans', show: 'bans', kind: null },
  { key: 'near_miss', label: 'Almost banned', show: 'near_miss', kind: null },
  { key: 'allowed', label: 'Allowed', show: 'allowed', kind: null },
  { key: 'not_reviewed', label: "Couldn't be reviewed", show: 'not_reviewed', kind: null },
  { key: 'action_failed', label: 'Refused by Twitch', show: 'action_failed', kind: null },
  { key: 'rule', label: 'Rule hits', show: null, kind: 'rule' },
];
export const SHOW_LABEL: Record<DecisionShow, string> = {
  acted: 'Acted on',
  bans: 'Bans',
  near_miss: 'Almost banned',
  allowed: 'Allowed',
  not_reviewed: "Couldn't be reviewed",
  action_failed: 'Refused by Twitch',
};

export const SORTS: Array<{ key: DecisionSort; label: string }> = [
  { key: 'newest', label: 'Newest' },
  { key: 'cost', label: 'Most expensive' },
  { key: 'score', label: 'Highest score' },
  { key: 'slowest', label: 'Slowest' },
];

export type DetailHistory = DecisionDetail['history'][number];
