import { Schema, model, type Types } from 'mongoose';

/** Assistant changes are kept this long, then Mongo's TTL monitor removes them. */
export const SITE_AGENT_CHANGE_TTL_DAYS = 90;

export interface ISiteAgentChange {
    _id: Types.ObjectId;
    channelId: string;
    actor: { id: string; login: string; displayName: string; role: 'owner' | 'admin' };
    sessionId: string | null;
    turnId: string | null;
    callId: string | null;
    /** The user's message that led to the change (≤2000 characters). */
    request: string;
    tool: string;
    title: string;
    area: string;
    target: { type: string; id: string | null; label: string };
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** Tool-private restore data. Never sent to the browser. */
    undo: Record<string, unknown> | null;
    /** The tool can undo it and left restore data (false for undo records). */
    undoable: boolean;
    effects: string[];
    summary: string;
    at: Date;
    undoneAt: Date | null;
    undoneBy: { id: string; login: string } | null;
    /** On the record of an undo: the change it undid. */
    undoOf: Types.ObjectId | null;
    /** Short claim while an undo runs, so two clicks can't undo twice. */
    undoLockUntil: Date | null;
    expiresAt: Date;
}

const siteAgentChangeSchema = new Schema<ISiteAgentChange>({
    channelId: { type: String, required: true },
    actor: {
        type: new Schema({
            id: { type: String, required: true },
            login: { type: String, default: '' },
            displayName: { type: String, default: '' },
            role: { type: String, enum: ['owner', 'admin'], required: true },
        }, { _id: false }),
        required: true,
    },
    sessionId: { type: String, default: null },
    turnId: { type: String, default: null },
    callId: { type: String, default: null },
    request: { type: String, default: '', maxlength: 2000 },
    tool: { type: String, required: true },
    title: { type: String, required: true },
    area: { type: String, required: true },
    target: {
        type: new Schema({
            type: { type: String, required: true },
            id: { type: String, default: null },
            label: { type: String, default: '' },
        }, { _id: false }),
        required: true,
    },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    undo: { type: Schema.Types.Mixed, default: null, select: false },
    undoable: { type: Boolean, default: false },
    effects: { type: [String], default: [] },
    summary: { type: String, default: '' },
    at: { type: Date, required: true },
    undoneAt: { type: Date, default: null },
    undoneBy: {
        type: new Schema({ id: { type: String, required: true }, login: { type: String, default: '' } }, { _id: false }),
        default: null,
    },
    undoOf: { type: Schema.Types.ObjectId, default: null },
    undoLockUntil: { type: Date, default: null, select: false },
    expiresAt: { type: Date, required: true },
}, { versionKey: false, minimize: false });

// Owner view (whole channel) and admin view (own changes), newest first.
siteAgentChangeSchema.index({ channelId: 1, _id: -1 });
siteAgentChangeSchema.index({ channelId: 1, 'actor.id': 1, _id: -1 });
siteAgentChangeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SiteAgentChangeSchema = model<ISiteAgentChange>('site_agent_changes', siteAgentChangeSchema, 'site_agent_changes');
