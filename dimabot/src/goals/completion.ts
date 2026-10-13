import { GoalSet, goalSnapshot, goalPlan } from './service.js';
import { nextGoalOutcome, type GoalAction, type GoalOutcome } from './model.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

export async function runGoalAction(channel: string, action: GoalAction, goalID: string): Promise<void> {
  const { deliverAstMessage } = await import('../utils/ast_command_delivery.js');
  // Plain messages never enter the parser. AST uses the broadcaster's current plan.
  const message = action.type === 'message' ? { parsedText: action.text } : await (await import('../handlers/special_parser.handler.js')).parseSpecialCommands(action.text, {
    channelID: channel, scopeType: 'goal', scopeName: goalID, userPlan: await goalPlan(channel), userLevel: 10, literalArguments: true
  });
  const result = await deliverAstMessage(channel, message);
  if (result.error) throw new Error('Goal action delivery failed');
}

export async function settleGoalChannel(channel: string, now = Date.now()): Promise<void> {
  const snapshot = await goalSnapshot(channel, now);
  for (const goal of snapshot.goals) {
    // Wait for the previous attempt before another rolling transition. A stale
    // attempt has an unknown result and is never retried: effects may already exist.
    if (goal.outcome?.actionStatus === 'running') continue;
    const phase = nextGoalOutcome(goal, goal.current, goal.outcome, now);
    if (!phase) continue;
    const action = goal.actions?.[phase === 'completed' ? 'completion' : 'failure'];
    const outcome: GoalOutcome = { phase, sequence: (goal.outcome?.sequence ?? 0) + 1, at: now, actionStatus: action ? 'running' : 'none' };
    const path = `outcomes.${goal.id}`;
    // Configuration revision and prior transition are compared in the same durable
    // write. Concurrent workers, replays and dashboard reads cannot claim it twice.
    const claimed = await GoalSet.updateOne({
      _id: channel, revision: snapshot.revision, 'goals.id': goal.id,
      [`${path}.sequence`]: goal.outcome ? goal.outcome.sequence : { $exists: false }
    }, { $set: { [path]: outcome } }, { writeConcern: { w: 1, j: true } });
    if (!claimed.modifiedCount || !action) continue;
    let actionStatus: GoalOutcome['actionStatus'] = 'finished';
    try { await runGoalAction(channel, action, goal.id); }
    catch { actionStatus = 'error'; console.error('Goal action failed', { channel, goal: goal.id, sequence: outcome.sequence }); }
    await GoalSet.updateOne({ _id: channel, [`${path}.sequence`]: outcome.sequence }, { $set: { [`${path}.actionStatus`]: actionStatus } }, { writeConcern: { w: 1, j: true } });
  }
}

export async function settleGoals(): Promise<void> {
  await getMongoDBConnection('goals-completion');
  // Stream channel IDs rather than loading every goal and receipt into memory.
  for await (const row of GoalSet.find({ 'goals.0': { $exists: true } }).select('_id').lean().cursor()) {
    try { await settleGoalChannel(row._id); }
    catch { console.error('Goal evaluation failed', { channel: row._id }); }
  }
}
