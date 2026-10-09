import { Schema, model } from 'mongoose';
import { DuelChannel, loadDuel } from './service.js';
import { loserLogin, winnerMessage, nextDeadline, type DuelRun } from './model.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { isEditorLoginCached } from '../utils/permissions/roles.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../utils/header.js';
import { getTwitchUserByLogin } from '../functions/users/get_user_by_login.users.js';
import { getChannelModerators } from '../functions/moderation/get_moderators.moderation.js';
import { ban } from '../functions/moderation/ban.moderation.js';
import { removeChannelModerator } from '../functions/channels/remove_moderator.channel.js';
import { addModerator } from '../functions/channels/add_moderator.channel.js';
import { sendTwitchChatMessage } from '../functions/chats/send_message.chat.js';
import { error as logError } from '../utils/logger.js';

interface Restore { _id: string; channel: string; userId: string; dueAt: number; leaseUntil: number }
const restoreSchema = new Schema<Restore>({ _id: String, channel: String, userId: String, dueAt: Number, leaseUntil: { type: Number, default: 0 } }, { versionKey: false, collection: 'duel_moderator_restores' });
restoreSchema.index({ dueAt: 1 });
export const DuelModeratorRestore = model<Restore>('DuelModeratorRestore', restoreSchema);

async function timeoutLoser(channel: string, run: DuelRun): Promise<void> {
  // Turning timeouts off takes effect immediately, including an accepted battle.
  if (!(await loadDuel(channel)).settings.timeoutEnabled || !run.timeoutEnabled) return;
  const login = loserLogin(run), cache = await getDragonflyClient('duel-timeout');
  if (await isEditorLoginCached(cache, channel, login)) return;
  const user = await getTwitchUserByLogin(login);
  if (user.error || !user.data) throw new Error(user.message);
  if (user.data.id === channel || user.data.id === TWITCH_BOT_ACCOUNT_ID) return;
  const moderators = await getChannelModerators(channel, [user.data.id]);
  if (moderators.error) throw new Error(moderators.message);
  const isModerator = moderators.data?.some(mod => mod.user_id === user.data!.id) ?? false;
  if (isModerator) {
    // Persist restoration BEFORE removing the role, so a worker restart cannot
    // permanently demote a losing moderator. Restore after the chosen timeout.
    await DuelModeratorRestore.create({ _id: run.id, channel, userId: user.data.id, dueAt: Date.now() + run.timeoutSeconds * 1000 + 30000 });
    const removed = await removeChannelModerator(channel, user.data.id, AbortSignal.timeout(10000));
    if (removed.error) { await DuelModeratorRestore.updateOne({ _id: run.id }, { $set: { dueAt: Date.now() } }); throw new Error(removed.message); }
  }
  // Recheck the switch after provider lookups/demotion, before the actual timeout.
  if (!(await loadDuel(channel)).settings.timeoutEnabled) {
    if (isModerator) await DuelModeratorRestore.updateOne({ _id: run.id }, { $set: { dueAt: Date.now() } });
    return;
  }
  const result = await ban(channel, user.data.id, TWITCH_BOT_ACCOUNT_ID, run.timeoutSeconds, 'Duel', AbortSignal.timeout(10000));
  if (result.error) {
    if (isModerator) await DuelModeratorRestore.updateOne({ _id: run.id }, { $set: { dueAt: Date.now() } });
    throw new Error(result.message);
  }
  if (isModerator) await DuelModeratorRestore.updateOne({ _id: run.id }, { $set: { dueAt: Date.now() + run.timeoutSeconds * 1000 + 10000 } });
}
async function report(channel: string, run: DuelRun, field: 'announcementError' | 'timeoutError', error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await DuelChannel.updateOne({ _id: channel, 'run.id': run.id }, { $set: { [`run.${field}`]: message.slice(0, 300) }, $inc: { revision: 1 } });
  await logError({ function: 'duel-completion', runId: run.id, field, error: message }, { channelId: channel, destination: 'both' });
}
export async function settleDuels(): Promise<void> {
  await getMongoDBConnection('duel-completion');
  const now = Date.now();
  const rows = await DuelChannel.find({ dueAt: { $ne: null, $lte: now }, leaseUntil: { $lte: now } }, { _id: 1 }).sort({ dueAt: 1 }).limit(10).lean();
  for (const row of rows) {
    const doc = await DuelChannel.findOneAndUpdate({ _id: row._id, dueAt: { $ne: null, $lte: now }, leaseUntil: { $lte: now } }, { $set: { leaseUntil: now + 30000 } }, { new: true }).lean();
    if (!doc) continue;
    try {
      if (doc.challenge && doc.challenge.expiresAt <= now) {
        await DuelChannel.updateOne({ _id: doc._id, 'challenge.id': doc.challenge.id }, { $set: { challenge: null, dueAt: null }, $inc: { revision: 1 } }); continue;
      }
      const run = doc.run;
      if (!run || run.completedAt !== null) { await DuelChannel.updateOne({ _id: doc._id }, { $set: { dueAt: null } }); continue; }
      if (now < run.endsAt) {
        const phrase = run.phrases[run.phraseIndex];
        if (phrase && phrase.at <= now) {
          // Claim before the external call; a response loss must not replay chatter.
          run.phraseIndex++;
          await DuelChannel.updateOne({ _id: doc._id, 'run.id': run.id }, { $set: { 'run.phraseIndex': run.phraseIndex, dueAt: nextDeadline(run) }, $inc: { revision: 1 } });
          const response = await sendTwitchChatMessage(doc._id, phrase.text);
          if (response.error) await report(doc._id, run, 'announcementError', response.message);
        }
        continue;
      }
      if (!run.announcementAttempted) {
        const claimed = await DuelChannel.updateOne({ _id: doc._id, 'run.id': run.id, 'run.announcementAttempted': false }, { $set: { 'run.announcementAttempted': true }, $inc: { revision: 1 } });
        if (claimed.modifiedCount) {
          const response = await sendTwitchChatMessage(doc._id, winnerMessage(run));
          if (response.error) await report(doc._id, run, 'announcementError', response.message);
        }
      }
      if (!run.timeoutAttempted) {
        const claimed = await DuelChannel.updateOne({ _id: doc._id, 'run.id': run.id, 'run.timeoutAttempted': false }, { $set: { 'run.timeoutAttempted': true }, $inc: { revision: 1 } });
        if (claimed.modifiedCount) try { await timeoutLoser(doc._id, run); } catch (error) { await report(doc._id, run, 'timeoutError', error); }
      }
      // Accepted effects survive lost OBS/bot connections. Attempts are receipted
      // before sending: no automatic duplicate timeout/announcement after a crash.
      await DuelChannel.updateOne({ _id: doc._id, 'run.id': run.id }, { $set: { 'run.completedAt': Date.now(), dueAt: null }, $inc: { revision: 1 } });
    } finally { await DuelChannel.updateOne({ _id: doc._id }, { $set: { leaseUntil: 0 } }); }
  }
  const restores = await DuelModeratorRestore.find({ dueAt: { $lte: Date.now() }, leaseUntil: { $lte: Date.now() } }).limit(10).lean();
  for (const row of restores) {
    const claimed = await DuelModeratorRestore.updateOne({ _id: row._id, leaseUntil: { $lte: Date.now() } }, { $set: { leaseUntil: Date.now() + 30000 } });
    if (!claimed.modifiedCount) continue;
    try {
      const mods = await getChannelModerators(row.channel, [row.userId]);
      if (mods.error) throw new Error(mods.message);
      if (mods.data?.some(mod => mod.user_id === row.userId)) { await DuelModeratorRestore.deleteOne({ _id: row._id }); continue; }
      const result = await addModerator(row.channel, row.userId);
      if (result.error) throw new Error(result.message);
      await DuelModeratorRestore.deleteOne({ _id: row._id });
    } catch (error) {
      await DuelModeratorRestore.updateOne({ _id: row._id }, { $set: { dueAt: Date.now() + 30000, leaseUntil: 0 } });
      await logError({ function: 'duel-restore-moderator', userId: row.userId, error: String(error) }, { channelId: row.channel, destination: 'both' });
    }
  }
}
