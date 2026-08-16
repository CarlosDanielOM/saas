import { createHash } from 'node:crypto';

export function generateQdrantPointId(namespace: string, entityID: string, timestamp: number): number {
    const hash = createHash('md5')
        .update(`${namespace}:${entityID}:${timestamp}`)
        .digest('hex');
    return parseInt(hash.substring(0, 8), 16);
}
