import { createHash } from 'node:crypto';

export function generateQdrantPointId(namespace: string, entityID: string, timestamp: number): number {
    const hash = createHash('md5')
        .update(`${namespace}:${entityID}:${timestamp}`)
        .digest('hex');
    return parseInt(hash.substring(0, 8), 16);
}

export function qdrantPointBelongsToMemory(
    payload: Record<string, unknown> | null | undefined,
    memoryID: string,
    channelID: string
): boolean {
    return String(payload?.memory_id || '') === memoryID &&
        String(payload?.channel_id || '') === channelID;
}
