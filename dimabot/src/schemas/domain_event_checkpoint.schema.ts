import { Schema, model, Types } from 'mongoose';

export interface IDomainEventCheckpoint {
    _id: Types.ObjectId;
    consumer: string;
    topic: string;
    lastEventID: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const domainEventCheckpointSchema = new Schema<IDomainEventCheckpoint>({
    consumer: { type: String, required: true },
    topic: { type: String, required: true },
    lastEventID: { type: Schema.Types.ObjectId, required: true }
}, {
    timestamps: true,
    versionKey: false
});

domainEventCheckpointSchema.index({ consumer: 1, topic: 1 }, { unique: true });

export const DomainEventCheckpointSchema = model<IDomainEventCheckpoint>(
    'domain_event_checkpoint',
    domainEventCheckpointSchema
);
