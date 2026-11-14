import type { GiftFilter, GiftRow } from '../../services/gifts-api.service';
import { dateTime, formatNumber, formatUSD } from '../../shared/format';

/**
 * How the Gifted credits page and its sheet put a gift into words. One place, so the list row, the sheet and
 * the answer line never disagree about what a gift's state means.
 */

/** What happened to a gift, from the owner's point of view (not the stored status). */
export type GiftState =
  /** Paid, delivery failed 5+ times: money we owe. */
  | 'stuck'
  /** Paid, the bot is delivering it. */
  | 'moving'
  /** Checkout open, not paid (yet). */
  | 'awaiting'
  /**
   * Not paid as far as we know, but the bot couldn't confirm it with Polar (5+ failed checks, or an old
   * `needs_support` flag from before 2026-11-13). Not proven unpaid: the bot keeps checking.
   */
  | 'unpaid_flag'
  /** The checkout expired without a payment. Nothing is owed. */
  | 'expired'
  | 'announced'
  /** Delivered; the chat announcement is still on its way. */
  | 'announcing'
  /** Delivered; the bot stopped trying to announce it. */
  | 'unannounced';

export type Tone = 'ok' | 'accent' | 'danger' | 'muted' | 'warn';

export const FILTERS: ReadonlyArray<{ key: GiftFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_support', label: 'Needs you' },
  { key: 'in_progress', label: 'On the way' },
  { key: 'awaiting_payment', label: 'Waiting for payment' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'expired', label: 'Never paid' },
];
export const isFilter = (value: unknown): value is GiftFilter => FILTERS.some((item) => item.key === value);

export function giftState(row: GiftRow): GiftState {
  if (row.status === 'expired') return 'expired';
  if (row.status === 'delivered' || row.deliveredAt) {
    if (row.announcedAt) return 'announced';
    return row.announcementStoppedAt ? 'unannounced' : 'announcing';
  }
  if (!row.paid) return row.status === 'needs_support' || row.attempts >= 5 ? 'unpaid_flag' : 'awaiting';
  return row.status === 'needs_support' ? 'stuck' : 'moving';
}

/** The status chip on a row, plus a second one when the announcement is the news. */
export function giftChips(state: GiftState): Array<{ label: string; tone: Tone }> {
  switch (state) {
    case 'stuck':
      return [{ label: 'Needs you', tone: 'danger' }];
    case 'moving':
      return [{ label: 'On the way', tone: 'accent' }];
    case 'awaiting':
      return [{ label: 'Waiting for payment', tone: 'muted' }];
    case 'unpaid_flag':
      return [{ label: 'Payment not confirmed', tone: 'warn' }];
    case 'expired':
      return [{ label: 'Never paid', tone: 'muted' }];
    case 'announced':
      return [{ label: 'Delivered', tone: 'ok' }];
    case 'announcing':
      return [{ label: 'Delivered', tone: 'ok' }, { label: 'Announcing', tone: 'muted' }];
    case 'unannounced':
      return [{ label: 'Delivered', tone: 'ok' }, { label: 'Not announced', tone: 'warn' }];
  }
}

/** "Oct 20" (with the year when it is not this year). */
export function day(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "in 12 min", "in 3 h", then a date: when the bot looks at a gift next. */
export function untilTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  if (seconds < 45) return 'any moment now';
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return dateTime(value, now);
}

/** What the buyer was charged before tax: "$5.00". Amounts are in the currency's minor unit. */
export function giftPrice(row: GiftRow): string {
  const code = (row.priceCurrency || 'usd').toUpperCase();
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(row.priceAmount / 10 ** digits);
  } catch {
    return `${(row.priceAmount / 100).toFixed(2)} ${code}`;
  }
}

/** "250,000 credits · $2.50 value": credits always travel with their dollar value. */
export function giftPack(row: GiftRow): string {
  return `${formatNumber(row.credits)} ${row.credits === 1 ? 'credit' : 'credits'} · ${formatUSD(row.creditsUSD)} value`;
}

/** The row's second line. */
export function giftMeta(row: GiftRow, state: GiftState = giftState(row)): string {
  switch (state) {
    case 'expired':
      return `Checkout expired ${day(row.expiredAt ?? row.createdAt)} · never paid`;
    case 'unpaid_flag':
      return `${giftPack(row)} · checkout opened ${day(row.createdAt)} · payment not confirmed`;
    case 'awaiting':
      return `${giftPack(row)} · checkout opened ${day(row.createdAt)} · not paid yet`;
    default:
      return `${giftPack(row)} · paid ${giftPrice(row)} · ${day(row.paidAt ?? row.createdAt)}`;
  }
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');

/** The sheet's plain answer: a bold first sentence and the rest. */
export function giftAnswer(row: GiftRow, now: number = Date.now()): { tone: Tone; lead: string; rest: string } {
  const state = giftState(row);
  switch (state) {
    case 'expired':
      return { tone: 'muted', lead: 'Never paid.', rest: `The checkout expired on ${day(row.expiredAt ?? row.createdAt, now)} without a payment, so nothing is owed.` };
    case 'unpaid_flag':
      return {
        tone: 'warn',
        lead: 'Payment not confirmed yet.',
        rest: `The checkout opened on ${day(row.createdAt, now)}, and the bot couldn't check it with Polar${row.lastError ? ` (${sentence(row.lastError)})` : ''}. It keeps checking: if the buyer paid, delivery starts on its own; if the checkout expired unpaid, it becomes Never paid.`,
      };
    case 'awaiting':
      return {
        tone: 'muted',
        lead: 'Waiting for the buyer to pay.',
        rest: `The checkout opened on ${day(row.createdAt, now)}. Nothing is owed unless they pay; Polar closes the checkout after 24 hours.${row.lastError ? ` The last check with Polar failed (${sentence(row.lastError)}); the bot keeps checking.` : ''}`,
      };
    case 'moving': {
      const rest = row.processing
        ? "It's working on it right now."
        : row.lastError && row.nextAttemptAt
          ? `The last try failed; it tries again ${untilTime(row.nextAttemptAt, now)}.`
          : row.nextAttemptAt
            ? `Next step ${untilTime(row.nextAttemptAt, now)}.`
            : '';
      return { tone: 'accent', lead: 'Paid; the bot is delivering it.', rest };
    }
    case 'stuck': {
      const why = row.lastError ? sentence(row.lastError) : `${row.attempts} tries failed`;
      return {
        tone: 'danger',
        lead: `Paid on ${day(row.paidAt, now)}, but delivery stopped: ${why}.`,
        rest: row.processing ? 'The bot is trying again right now.' : 'The bot keeps retrying, at most 30 minutes apart.',
      };
    }
    case 'announced':
      return { tone: 'ok', lead: `Delivered on ${day(row.deliveredAt, now)} and announced in chat.`, rest: '' };
    case 'announcing':
      return { tone: 'ok', lead: `Delivered on ${day(row.deliveredAt, now)}.`, rest: 'The chat announcement is on its way.' };
    case 'unannounced':
      return {
        tone: 'warn',
        lead: 'Delivered, but the chat announcement was stopped (held by chat moderation or failed 5 times).',
        rest: "The credits are in the streamer's balance.",
      };
  }
}

export type StepState = 'done' | 'now' | 'stuck' | 'stopped' | 'todo';
export interface GiftStep {
  key: string;
  label: string;
  at: string | null;
  state: StepState;
  /** Shown instead of a time when there is none. */
  note: string;
}

/** The stages a gift went through, oldest first. Unpaid gifts stop after the checkout. */
export function giftSteps(row: GiftRow): GiftStep[] {
  const state = giftState(row);
  const opened: GiftStep = { key: 'opened', label: 'Checkout opened', at: row.createdAt, state: 'done', note: '' };
  if (state === 'expired') {
    return [opened, { key: 'expired', label: 'Checkout expired, no payment', at: row.expiredAt, state: 'stopped', note: 'Never paid' }];
  }
  if (state === 'unpaid_flag') {
    return [opened, { key: 'unpaid', label: 'Payment', at: null, state: 'now', note: 'Not confirmed yet' }];
  }
  const stuck = state === 'stuck';
  const delivered = Boolean(row.deliveredAt);
  const started = Boolean(row.deliveryStartedAt) || delivered;
  // The first stage that isn't done is where the gift is now (or where it stopped).
  const open = (done: boolean, reached: boolean, waiting: string): Pick<GiftStep, 'state' | 'note'> =>
    done ? { state: 'done', note: 'Time not recorded' } : reached ? { state: stuck ? 'stuck' : 'now', note: stuck ? 'Stopped here' : waiting } : { state: 'todo', note: 'Not yet' };
  const announce: Pick<GiftStep, 'state' | 'note'> = row.announcedAt
    ? { state: 'done', note: '' }
    : row.announcementStoppedAt
      ? { state: 'stopped', note: 'Stopped' }
      : delivered
        ? { state: 'now', note: 'On its way' }
        : { state: 'todo', note: 'Not yet' };
  return [
    opened,
    { key: 'paid', label: 'Paid', at: row.paidAt, ...(row.paid ? { state: 'done' as const, note: 'Time not recorded' } : { state: 'now' as const, note: 'Waiting for the buyer' }) },
    { key: 'started', label: 'Delivery started', at: row.deliveryStartedAt, ...open(started, row.paid, 'Starting') },
    { key: 'delivered', label: 'Credits delivered', at: row.deliveredAt, ...open(delivered, started, 'In progress') },
    { key: 'announced', label: row.announcementStoppedAt && !row.announcedAt ? 'Chat announcement stopped' : 'Announced in chat', at: row.announcedAt ?? row.announcementStoppedAt, ...announce },
  ];
}
