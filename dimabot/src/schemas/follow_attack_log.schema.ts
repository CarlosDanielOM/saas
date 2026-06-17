import { Schema, model } from 'mongoose';

export type FollowDefenseMode = 'silent' | 'protection' | 'attack';
export type FollowDefenseTriggerSource = 'threshold' | 'manual';

export interface IFollowAttackTrackedFollow {
    followerID: string;
    followerLogin: string;
    followerName: string;
    followedAt: Date;
    eventID: string;
    banned: boolean;
    banStatus?: number;
    banMessage?: string;
}

export interface IFollowAttackRaidInfo {
    raiderChannelID: string;
    raiderChannelLogin: string;
    raiderChannelName: string;
    raidViewers: number;
}

export interface IFollowAttackLog {
    targetChannelID: string;
    targetChannelLogin: string;
    targetChannelName: string;
    modeTriggered: FollowDefenseMode;
    triggeredBy: FollowDefenseTriggerSource;
    totalFollows: number;
    velocity: number;
    durationSeconds: number;
    isRaid: boolean;
    raidInfo?: IFollowAttackRaidInfo;
    trackedFollows: IFollowAttackTrackedFollow[];
    isHateRaid: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const trackedFollowSchema = new Schema<IFollowAttackTrackedFollow>({
    followerID: { type: String, required: true },
    followerLogin: { type: String, default: '' },
    followerName: { type: String, default: '' },
    followedAt: { type: Date, required: true },
    eventID: { type: String, required: true },
    banned: { type: Boolean, default: false },
    banStatus: { type: Number, default: undefined },
    banMessage: { type: String, default: undefined }
}, { _id: false });

const raidInfoSchema = new Schema<IFollowAttackRaidInfo>({
    raiderChannelID: { type: String, required: true },
    raiderChannelLogin: { type: String, default: '' },
    raiderChannelName: { type: String, default: '' },
    raidViewers: { type: Number, default: 0 }
}, { _id: false });

const followAttackLogSchema = new Schema<IFollowAttackLog>({
    targetChannelID: { type: String, required: true, index: true },
    targetChannelLogin: { type: String, default: '' },
    targetChannelName: { type: String, default: '' },
    modeTriggered: { type: String, enum: ['silent', 'protection', 'attack'], required: true, index: true },
    triggeredBy: { type: String, enum: ['threshold', 'manual'], required: true },
    totalFollows: { type: Number, default: 0 },
    velocity: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    isRaid: { type: Boolean, default: false, index: true },
    raidInfo: { type: raidInfoSchema, default: undefined },
    trackedFollows: { type: [trackedFollowSchema], default: [] },
    isHateRaid: { type: Boolean, default: false, index: true }
}, {
    timestamps: true
});

followAttackLogSchema.index({ targetChannelID: 1, createdAt: -1 });
followAttackLogSchema.index({ 'raidInfo.raiderChannelID': 1, isHateRaid: 1 });

export const FollowAttackLogSchema = model<IFollowAttackLog>('follow_attack_log', followAttackLogSchema);
