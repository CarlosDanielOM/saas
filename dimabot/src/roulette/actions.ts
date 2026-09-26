import { RouletteChannel, actionDue, hasPro, snapshot } from './service.js';
import type { WinnerAction } from './action-model.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

/** Persist the claim BEFORE evaluating arbitrary external effects. Never replay a claimed action. */
export async function claimAction(channelId: string, now = Date.now()): Promise<WinnerAction | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const doc = await RouletteChannel.findById(channelId).lean();
    if (!doc) return null;
    const actions = doc.actions ?? [];
    const job = actions.find(a => a.status === 'pending' && a.dueAt <= now);
    if (!job) return null;
    job.status = 'running'; job.startedAt = now;
    const claimed = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { actions, actionDueAt: actionDue(actions) }, $inc: { revision: 1 },
    });
    if (claimed.modifiedCount) return job;
  }
  return null;
}

export async function executeWinnerAction(channelId: string, job: WinnerAction): Promise<void> {
  const { parseSpecialCommands } = await import('../handlers/special_parser.handler.js');
  const { deliverAstMessage } = await import('../utils/ast_command_delivery.js');
  const { default: TwitchStreamers } = await import('../classes/twitch_streamers.class.js');
  const owner = await TwitchStreamers.getTwitchAccountById(channelId);
  const actor = job.actor?.userId ? job.actor : { userId: channelId, userLogin: owner?.name ?? '', userDisplayName: owner?.name ?? '' };
  const rendered = await parseSpecialCommands(job.source, {
    channelID: channelId, scopeType: 'roulette', scopeName: job.rouletteId,
    userPlan: 'pro', userLevel: 10, literalArguments: true, argument: actor.argument ?? '',
    eventData: { chatter_user_id: actor.userId, chatter_user_login: actor.userLogin, chatter_user_name: actor.userDisplayName },
    variables: { roulette_id: job.rouletteId, roulette_draw_id: job.drawId, roulette_item_id: job.itemId, roulette_item: job.label },
  });
  const delivered = await deliverAstMessage(channelId, rendered);
  if (delivered.error) throw new Error('Winner action delivery failed');
}

export async function runDueActions(execute = executeWinnerAction): Promise<void> {
  await getMongoDBConnection('roulette-actions');
  const rows = await RouletteChannel.find({ actionDueAt: { $ne: null, $lte: Date.now() } }, { _id: 1 }).sort({ actionDueAt: 1 }).limit(4).lean();
  await Promise.all(rows.map(async row => {
    // Database outages before a claim leave the job pending for the next poll.
    const entitled = await hasPro(row._id);
    await snapshot(row._id); // Completion/removal must be durable before any side effect.
    const job = await claimAction(row._id);
    if (!job) return;
    let status: WinnerAction['status'] = entitled ? 'done' : 'skipped';
    if (entitled) {
      try { await execute(row._id, job); }
      catch { status = 'failed'; console.error('Roulette winner action failed', { channelId: row._id, drawId: job.drawId }); }
    }
    await RouletteChannel.updateOne({ _id: row._id, actions: { $elemMatch: { drawId: job.drawId, status: 'running' } } }, {
      $set: { 'actions.$.status': status, 'actions.$.finishedAt': Date.now() }, $inc: { revision: 1 },
    });
  }));
}
