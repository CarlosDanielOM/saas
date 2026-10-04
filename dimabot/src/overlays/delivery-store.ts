import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { mongo } from 'mongoose';
const { GridFSBucket, ObjectId } = mongo;
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import type { LiveEvent } from './live.js';
import type { QueueCommand } from './controls.js';

export const DELIVERY_TTL_MS = 30 * 60 * 1000;
export const LEASE_MS = 120000;
export const MAX_PENDING = 200;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_CHANNEL_BYTES = 512 * 1024 * 1024;
export interface SavedDelivery { _id: string; channel: string; event: LiveEvent; recipients: string[]; expiresAt: Date; raw?: Record<string, unknown>; mediaId?: string; mime?: string; bytes?: number }
export interface SavedPeer { _id: string; channel: string; publicId: string; since: number; expiresAt: Date; commands: QueueCommand[] }
async function db() { return (await getMongoDBConnection('overlay-delivery')).connection.db!; }
export async function deliveries() { return (await db()).collection<SavedDelivery>('overlay_deliveries'); }
export async function leases() { return (await db()).collection<SavedPeer>('overlay_source_leases'); }
async function bucket() { return new GridFSBucket(await db(), { bucketName: 'overlay_media' }); }
export async function retainFile(file: string): Promise<{ mediaId: string; bytes: number }> {
  const { size: bytes } = await stat(file);
  if (bytes <= 0 || bytes > MAX_MEDIA_BYTES) throw new Error('Overlay media exceeds the 100 MB playback limit');
  const target = (await bucket()).openUploadStream('overlay-playback', { metadata: { expiresAt: new Date(Date.now() + DELIVERY_TTL_MS) } });
  try { await pipeline(createReadStream(file), target); }
  catch (error) { await target.abort().catch(() => {}); throw error; }
  return { mediaId: target.id.toHexString(), bytes };
}
export async function readFileStream(id: string, start = 0, end?: number) { return (await bucket()).openDownloadStream(new ObjectId(id), { start, ...(end === undefined ? {} : { end }) }); }
export async function releaseFile(id: string) { await (await bucket()).delete(new ObjectId(id)).catch(error => { if (!String(error).includes('File not found')) throw error; }); }
/** Expired uploads are also swept when a process stopped between upload and delivery insertion. */
export async function sweepFiles() {
  const database = await db();
  const files = database.collection('overlay_media.files');
  const chunks = database.collection('overlay_media.chunks');
  // An interrupted upload can leave chunks without a files document.
  const orphanCandidates = await chunks.distinct('files_id', { files_id: { $lt: ObjectId.createFromTime(Math.floor((Date.now() - DELIVERY_TTL_MS) / 1000)) } });
  for (const id of orphanCandidates) if (!await files.findOne({ _id: id })) await chunks.deleteMany({ files_id: id });
  for await (const file of files.find({ 'metadata.expiresAt': { $lte: new Date() } }, { projection: { _id: 1 } })) await releaseFile(String(file._id));
}
