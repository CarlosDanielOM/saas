import { Schema, model } from 'mongoose';

/**
 * Owner-only debug trail: things the bot did that no other store keeps (a command that ran or was refused,
 * what the bot said in chat, a Twitch notification that is not journaled, a chat alert that was sent or
 * skipped, a voice request that failed). The admin site reads it together with the stores that already
 * exist (domain events, moderation decisions, AI usage receipts); see `server/services/admin_feed`.
 *
 * Bounded on purpose: short text previews, a flat `data` object, 30 days. Written through
 * `utils/activity_log.ts`, never directly.
 */
export const ACTIVITY_KINDS = ['command', 'bot_message', 'twitch_event', 'alert', 'voice', 'system'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
/**
 * ok: it happened. skipped: deliberately not done (cooldown, alert turned off). blocked: refused
 * (no permission, held by Twitch). failed: it should have happened and did not.
 */
export const ACTIVITY_OUTCOMES = ['ok', 'skipped', 'blocked', 'failed'] as const;
export type ActivityOutcome = typeof ACTIVITY_OUTCOMES[number];
export type ActivityService = 'bot' | 'api' | 'cron';
export type ActivityData = Record<string, string | number | boolean | null>;

export const ACTIVITY_RETENTION_DAYS = 30;
export const ACTIVITY_TEXT_MAX = 300;

export interface IActivityLog {
    /** Stable when the source has an id (a retry writes the same row once), random otherwise. */
    _id: string;
    at: Date;
    /** Twitch channel id; '' for something that belongs to no channel. */
    channelID: string;
    kind: ActivityKind;
    /** What it is within the kind: '!so', 'channel.follow', 'fish', 'eventsub.revoked'. */
    name: string;
    outcome: ActivityOutcome;
    /** Machine code for anything that is not plain ok ('cooldown', 'permission_denied', 'alert_disabled'); '' otherwise. */
    reason: string;
    /** The chatter or viewer who caused it; '' when nobody did (a timer, the system). */
    actorID: string;
    actorLogin: string;
    actorName: string;
    /** Short preview: the chat line that ran the command, what the bot said. */
    text: string;
    /** Id of the full record elsewhere (domain event key, speech id, Twitch message id); ''. */
    ref: string;
    durationMs: number | null;
    data: ActivityData;
    service: ActivityService;
    expiresAt: Date;
}

const schema = new Schema<IActivityLog>({
    _id: String,
    at: { type: Date, required: true },
    channelID: { type: String, default: '' },
    kind: { type: String, enum: ACTIVITY_KINDS, required: true },
    name: { type: String, default: '' },
    outcome: { type: String, enum: ACTIVITY_OUTCOMES, default: 'ok' },
    reason: { type: String, default: '' },
    actorID: { type: String, default: '' },
    actorLogin: { type: String, default: '' },
    actorName: { type: String, default: '' },
    text: { type: String, default: '' },
    ref: { type: String, default: '' },
    durationMs: { type: Number, default: null },
    data: { type: Schema.Types.Mixed, default: () => ({}) },
    service: { type: String, default: 'api' },
    expiresAt: { type: Date, required: true }
}, { versionKey: false, minimize: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Newest first, for everything and for one channel.
schema.index({ at: -1, _id: -1 });
schema.index({ channelID: 1, at: -1, _id: -1 });
schema.index({ kind: 1, at: -1, _id: -1 });
// "Only problems" across channels: most rows are ok, so the index only holds the rest.
schema.index({ at: -1, _id: -1 }, { name: 'problems_at', partialFilterExpression: { outcome: { $in: ['skipped', 'blocked', 'failed'] } } });
// One chatter across channels. Most rows from timers and the system have no actor.
schema.index({ actorID: 1, at: -1, _id: -1 }, { partialFilterExpression: { actorID: { $gt: '' } } });
schema.index({ actorLogin: 1, at: -1, _id: -1 }, { partialFilterExpression: { actorLogin: { $gt: '' } } });

export const ActivityLog = model<IActivityLog>('activity_log', schema);
