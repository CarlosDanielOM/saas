/**
 * Chat sound storage: one document per channel with its settings and its private OBS link token.
 * Reads never create a document (an open settings tab polling after account deletion must not bring data back);
 * only a save or a new link does, and the routes allow those only for a channel that still has an account.
 */
import { Schema, model } from 'mongoose';
import Users from '../schemas/users.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { manageOverlayToken, overlayTokenHash, readOverlayToken, rememberOverlayToken, storedOverlayToken, type OverlayTokenStore } from '../utils/overlay-token.js';
import { CHAT_SOUND_DEFAULTS, fail, normalizeSettings, parseSettings, type ChatSoundSettings } from './model.js';

export interface ChatSoundDocument {
  _id: string; revision: number; settings: ChatSoundSettings;
  tokenHash: string | null; overlayToken?: { iv: string; content: string } | null;
}
const schema = new Schema<ChatSoundDocument>({
  _id: String, revision: { type: Number, default: 0 }, settings: { type: Schema.Types.Mixed, required: true },
  tokenHash: { type: String, default: null }, overlayToken: { type: Schema.Types.Mixed, select: false }
}, { versionKey: false, collection: 'chat_sound_channels' });
export const ChatSoundChannel = model<ChatSoundDocument>('ChatSoundChannel', schema);
const duplicate = (error: unknown) => (error as { code?: number }).code === 11000;

export function channelId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9]{1,30}$/.test(id)) fail('invalid', 'Invalid channel ID');
  return id;
}
/** Lookup only: a channel that never saved anything reads as the defaults at revision 0. */
export async function findChatSound(id: string): Promise<Pick<ChatSoundDocument, '_id' | 'revision' | 'settings' | 'tokenHash'> | null> {
  channelId(id); await getMongoDBConnection('chat-sound');
  const doc = await ChatSoundChannel.findById(id, { revision: 1, settings: 1, tokenHash: 1 }).lean();
  return doc ? { ...doc, settings: normalizeSettings(doc.settings) } : null;
}
export async function readChatSound(id: string): Promise<{ revision: number; settings: ChatSoundSettings; linked: boolean }> {
  const doc = await findChatSound(id);
  return doc ? { revision: doc.revision, settings: doc.settings, linked: !!doc.tokenHash } : { revision: 0, settings: { ...CHAT_SOUND_DEFAULTS }, linked: false };
}
/** Writes need a channel that still has a DomDimaBot account. */
export async function requireRegisteredChannel(id: string): Promise<void> {
  channelId(id); await getMongoDBConnection('chat-sound');
  if (!await Users.exists({ accounts: { $elemMatch: { type: 'twitch', id } } })) fail('channel_not_found', 'This channel has no DomDimaBot account', 404);
}
export async function configureChatSound(id: string, input: unknown, revision: number): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid', 'If-Match must be the settings revision');
  const settings = parseSettings(input);
  channelId(id); await getMongoDBConnection('chat-sound');
  try {
    // Revision 0 may create the document; any other revision must match the stored one.
    const saved = await ChatSoundChannel.updateOne({ _id: id, revision }, { $set: { settings }, $inc: { revision: 1 } }, { upsert: revision === 0 });
    if (saved.modifiedCount || saved.upsertedCount) return;
  } catch (error) { if (!duplicate(error)) throw error; }
  fail('revision_conflict', 'Chat sound changed; reload before saving', 409);
}

function overlayTokenStore(id: string): OverlayTokenStore {
  return {
    read: async () => {
      await getMongoDBConnection('chat-sound');
      return (await ChatSoundChannel.findById(id).select('tokenHash +overlayToken').lean()) ?? { tokenHash: null, overlayToken: null };
    },
    // The first link may create the document. A new link does not bump the settings revision (an open settings form
    // stays saveable); OBS sources on the old link are dropped by the socket service, which compares token hashes.
    save: async (expectedHash, token) => {
      try {
        const result = await ChatSoundChannel.updateOne({ _id: id, tokenHash: expectedHash },
          { $set: storedOverlayToken(token), $setOnInsert: { revision: 0, settings: { ...CHAT_SOUND_DEFAULTS } } }, { upsert: expectedHash === null });
        return result.modifiedCount === 1 || result.upsertedCount === 1;
      } catch (error) { if (duplicate(error)) return false; throw error; }
    }
  };
}
export async function overlayTokenState(id: string) { return readOverlayToken(overlayTokenStore(channelId(id))); }
export async function updateOverlayToken(id: string, input: unknown) { return manageOverlayToken(overlayTokenStore(channelId(id)), input, fail); }
export async function authorizeChatSoundOverlay(id: string, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token) || !/^[0-9]{1,30}$/.test(id)) return false;
  await getMongoDBConnection('chat-sound');
  const allowed = !!await ChatSoundChannel.exists({ _id: id, tokenHash: overlayTokenHash(token) });
  // Lookup-only store: remembering a token only updates the existing document.
  if (allowed) await rememberOverlayToken(overlayTokenStore(id), token).catch(() => { /* Recovery must not interrupt an existing OBS source. */ });
  return allowed;
}
