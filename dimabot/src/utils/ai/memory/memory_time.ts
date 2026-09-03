import { Types } from 'mongoose';

export function memoryUnixSeconds(date: Date | undefined, objectId: Types.ObjectId): number {
    const source = date instanceof Date ? date : objectId.getTimestamp();
    return Math.floor(source.getTime() / 1000);
}
