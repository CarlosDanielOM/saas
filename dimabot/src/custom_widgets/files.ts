import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET, s3Client } from '../utils/s3.js';
import type { PackageFile, PackageInput } from './format.js';

export interface FileRef { key: string; sha256: string; bytes: number }
export type PackageFiles = Record<PackageFile, FileRef> & { manifest?: FileRef };
export type StoredFile = PackageFile | 'manifest';

/**
 * Widget files are private S3 objects (no public ACL), addressed by content so unchanged files are
 * shared between revisions. The API reads them back; nothing links to the bucket directly.
 */
export const fileKey = (owner: string, widgetId: string, file: StoredFile, sha256: string) => `custom-widgets/${owner}/${widgetId}/${file}/${sha256}.txt`;

export function describeFiles(owner: string, widgetId: string, source: PackageInput): PackageFiles {
  const refs = {} as PackageFiles;
  for (const file of Object.keys(source).filter(key => source[key as StoredFile] !== undefined) as StoredFile[]) {
    const body = Buffer.from(source[file]!, 'utf8'), sha256 = createHash('sha256').update(body).digest('hex');
    refs[file] = { key: fileKey(owner, widgetId, file, sha256), sha256, bytes: body.length };
  }
  return refs;
}

export async function putFiles(refs: PackageFiles, source: PackageInput): Promise<void> {
  const unique = new Map(Object.entries(refs).map(([file, ref]) => [ref.key, source[file as StoredFile]!]));
  await Promise.all([...unique].map(([key, text]) => s3Client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: Buffer.from(text, 'utf8'), ContentType: 'text/plain; charset=utf-8', CacheControl: 'private, max-age=31536000, immutable'
  }))));
}

// Files never change once written (content-addressed), so a small in-memory cache is safe.
const cache = new Map<string, string>();
const CACHE_BYTES = 32_000_000;
let cachedBytes = 0;
export async function readFile(ref: FileRef): Promise<string> {
  const hit = cache.get(ref.key);
  if (hit !== undefined) { cache.delete(ref.key); cache.set(ref.key, hit); return hit; }
  const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: ref.key }));
  const text = await response.Body!.transformToString('utf-8');
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== ref.sha256) throw new Error('Custom widget file checksum mismatch');
  cache.set(ref.key, text); cachedBytes += ref.bytes;
  for (const [key, value] of cache) { if (cachedBytes <= CACHE_BYTES) break; cache.delete(key); cachedBytes -= Buffer.byteLength(value); }
  return text;
}

export async function deleteKeys(keys: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(keys)].map(async key => {
    const text = cache.get(key); if (text !== undefined) { cache.delete(key); cachedBytes -= Buffer.byteLength(text); }
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); }
    catch (error) { console.error('Custom widget file cleanup failed', key, error instanceof Error ? error.message : 'Unknown error'); }
  }));
}
