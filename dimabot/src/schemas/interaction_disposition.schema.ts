import mongoose, { Schema } from 'mongoose';

/**
 * What already happened to a finished Twitch poll or prediction, so its "ended" chat event never
 * runs twice and never runs for one that was canceled: Twitch sends `channel.poll.end` again when
 * a finished poll is dismissed (archived), possibly days later.
 *
 * One document per poll or prediction (`_id` = `<channel>:<kind>:<id>`), kept longer than Twitch
 * keeps polls (90 days). Deliberately not on the chat event's own settings row: that row is read
 * and written by the Chat events page and the assistant.
 */
export interface IInteractionDisposition {
    _id: string;
    channelID: string;
    kind: 'poll' | 'prediction';
    /** `announced`: its chat event ran (or is running). `canceled`: stopped with `cancel.poll`, never announced. */
    disposition: 'announced' | 'canceled';
    at: Date;
}

const schema = new Schema<IInteractionDisposition>({
    _id: { type: String, required: true },
    channelID: { type: String, required: true },
    kind: { type: String, enum: ['poll', 'prediction'], required: true },
    disposition: { type: String, enum: ['announced', 'canceled'], required: true },
    at: { type: Date, required: true }
}, { collection: 'interaction_dispositions', versionKey: false });
schema.index({ at: 1 }, { expireAfterSeconds: 100 * 86_400 });
schema.index({ channelID: 1 });

export const InteractionDisposition = (mongoose.models.InteractionDisposition as mongoose.Model<IInteractionDisposition>)
    || mongoose.model<IInteractionDisposition>('InteractionDisposition', schema);
