import { Schema, model } from 'mongoose';

export interface IFollowHateRaidSource {
    targetChannelID: string;
    targetChannelLogin: string;
    targetChannelName: string;
    raiderChannelID: string;
    raiderChannelLogin: string;
    raiderChannelName: string;
    count: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const followHateRaidSourceSchema = new Schema<IFollowHateRaidSource>({
    targetChannelID: { type: String, required: true, index: true },
    targetChannelLogin: { type: String, default: '' },
    targetChannelName: { type: String, default: '' },
    raiderChannelID: { type: String, required: true, index: true },
    raiderChannelLogin: { type: String, default: '' },
    raiderChannelName: { type: String, default: '' },
    count: { type: Number, default: 1 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true }
}, {
    timestamps: true
});

followHateRaidSourceSchema.index({ targetChannelID: 1, raiderChannelID: 1 }, { unique: true });
followHateRaidSourceSchema.index({ targetChannelID: 1, count: -1 });

export const FollowHateRaidSourceSchema = model<IFollowHateRaidSource>('follow_hate_raid_source', followHateRaidSourceSchema);
