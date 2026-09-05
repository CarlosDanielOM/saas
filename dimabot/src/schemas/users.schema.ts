import { Schema, model, type HydratedDocument, Types } from "mongoose";

interface IToken {
    iv: string;
    content: string;
}

export interface IAccounts {
    _id: Types.ObjectId;
    type: 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'spotify';
    id: string;
    name: string;
    email: string;
    refresh_token: IToken;
    access_token: IToken;
    access_token_expires_at: number | null;
    actived: boolean;
    chat_enabled: boolean;
    has_permissions: boolean;
    up_to_date_permissions: boolean;
}

export interface IUsers {
    _id: Types.ObjectId;
    name: string;
    email: string;
    accounts: IAccounts[];
    language?: 'en' | 'es' | null;
    polar_sh_customer_id: string;
    polar_plan_event_at?: Date;
    polar_plan_event_key?: string;
    polar_credit_snapshot?: {
        occurredAt: Date;
        eventKey: string;
        meters: Array<{ meter_id: string; consumed_units?: number; credited_units?: number; balance?: number }>;
    };
    plan_tier: 'free' | 'premium' | 'pro';
    plan_tier_until: Date | null;
    last_app_activity_at: Date | null;
    refreshed_at: Date;
    created_at: Date;
    updated_at: Date;
    referrerId?: Types.ObjectId;
    referralCodeUsed?: string;
    token_balance?: number;
    applied_credit_transaction_ids?: Types.ObjectId[];
    reminder_sent_at?: Date | null;
}

const accountsSchema = new Schema<IAccounts>({
    type: { type: String, default: 'twitch', enum: ['twitch', 'youtube', 'kick', 'tiktok', 'spotify'] },
    id: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    refresh_token: { 
        iv: { type: String, default: null },
        content: { type: String, default: null },
    },
    access_token: { 
        iv: { type: String, default: null },
        content: { type: String, default: null },
    },
    access_token_expires_at: { type: Number, default: null },
    actived: { type: Boolean, default: true },
    chat_enabled: { type: Boolean, default: true },
    has_permissions: { type: Boolean, default: true },
    up_to_date_permissions: { type: Boolean, default: true },
});

const usersSchema = new Schema<IUsers>({
    name: String,
    email: String,
    accounts: [accountsSchema],
    language: { type: String, enum: ['en', 'es'], default: null },
    polar_sh_customer_id: { type: String, default: null },
    polar_plan_event_at: { type: Date },
    polar_plan_event_key: { type: String },
    polar_credit_snapshot: {
        type: new Schema({
            occurredAt: { type: Date, required: true },
            eventKey: { type: String, required: true },
            meters: { type: [Schema.Types.Mixed], required: true }
        }, { _id: false }),
        select: false
    },
    plan_tier: { type: String, default: 'free', enum: ['free', 'premium', 'pro'] },
    plan_tier_until: { type: Date, default: null },
    last_app_activity_at: { type: Date, default: null },
    refreshed_at: { type: Date, default: Date.now },
    referrerId: { type: Schema.Types.ObjectId, ref: 'users', default: null },
    referralCodeUsed: { type: String, default: null },
    token_balance: { type: Number, default: 0 },
    applied_credit_transaction_ids: { type: [Schema.Types.ObjectId], default: undefined, select: false },
    reminder_sent_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }})

export type UserDocument = HydratedDocument<IUsers>;

const UsersSchema = model<IUsers>('users', usersSchema);

export default UsersSchema;
