import { Schema, model, type Types } from 'mongoose';

export type CreditGiftStatus = 'awaiting_payment' | 'payment_received' | 'delivering' | 'delivered' | 'needs_support';

/** Permanent receipt: do not TTL gifts or their checkout creation reservations. */
export interface ICreditGift {
    _id: string;
    buyerId: Types.ObjectId;
    recipientId: Types.ObjectId;
    buyerLogin: string;
    recipientLogin: string;
    recipientName: string;
    recipientChannelId: string;
    productId: string;
    fulfillmentProductId: string;
    benefitId: string;
    credits: number;
    priceAmount: number;
    priceCurrency: string;
    status: CreditGiftStatus;
    noRefundsAcknowledgedAt: Date;
    purchaseCreateStartedAt?: Date;
    checkoutId?: string;
    checkoutUrl?: string;
    paidOrderId?: string;
    buyerCustomerId?: string;
    paidAt?: Date;
    fulfillmentCreateStartedAt?: Date;
    fulfillmentCheckoutId?: string;
    fulfillmentOrderId?: string;
    recipientCustomerId?: string;
    grantId?: string;
    deliveredAt?: Date;
    announcedAt?: Date;
    announcementMessageId?: string;
    announcementStoppedAt?: Date;
    announcementAttempts: number;
    attempts: number;
    nextAttemptAt: Date;
    lastError?: string;
    leaseToken?: string;
    leaseUntil?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const schema = new Schema<ICreditGift>({
    _id: { type: String, required: true },
    buyerId: { type: Schema.Types.ObjectId, required: true },
    recipientId: { type: Schema.Types.ObjectId, required: true },
    buyerLogin: { type: String, required: true },
    recipientLogin: { type: String, required: true },
    recipientName: { type: String, required: true },
    recipientChannelId: { type: String, required: true },
    productId: { type: String, required: true },
    fulfillmentProductId: { type: String, required: true },
    benefitId: { type: String, required: true },
    credits: { type: Number, required: true },
    priceAmount: { type: Number, required: true },
    priceCurrency: { type: String, required: true },
    status: { type: String, required: true, enum: ['awaiting_payment', 'payment_received', 'delivering', 'delivered', 'needs_support'] },
    noRefundsAcknowledgedAt: { type: Date, required: true },
    purchaseCreateStartedAt: Date,
    checkoutId: String,
    checkoutUrl: { type: String, select: false },
    paidOrderId: String,
    buyerCustomerId: String,
    paidAt: Date,
    fulfillmentCreateStartedAt: Date,
    fulfillmentCheckoutId: String,
    fulfillmentOrderId: String,
    recipientCustomerId: String,
    grantId: String,
    deliveredAt: Date,
    announcedAt: Date,
    announcementMessageId: String,
    announcementStoppedAt: Date,
    announcementAttempts: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lastError: String,
    leaseToken: String,
    leaseUntil: Date,
}, { timestamps: true });

// _id deterministically binds buyer + request ID; payment identity is pinned to that checkout.
schema.index({ nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ checkoutId: 1 });
export const CreditGiftSchema = model<ICreditGift>('CreditGift', schema);
