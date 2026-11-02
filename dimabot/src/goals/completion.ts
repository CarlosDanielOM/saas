import { GoalSet, goalSnapshot, goalPlan, goalContributionTotal, monthlyOutcomeKey } from './service.js';
import { nextGoalOutcome, type GoalAction, type GoalOutcome } from './model.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { goalMonthAt, goalMonthForKey, nextGoalMonth } from './monthly.js';

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
  const state = await GoalSet.findById(channel).select('monthlyCursors outcomes').lean();
  for (const goal of snapshot.goals) {
    if (goal.mode === 'monthly') {
      const currentPeriod = goalMonthAt(now, goal.timeZone!);
      const cursor = state?.monthlyCursors?.[goal.id] ?? goalMonthAt(goal.createdAt, goal.timeZone!).key;
      const cursorPath = `monthlyCursors.${goal.id}`;
      const cursorCondition = state?.monthlyCursors?.[goal.id] ? cursor : { $exists: false };
      if (cursor < currentPeriod.key) {
        // At most one closed month per goal per pass. No older period is silently
        // skipped, but old actions are suppressed to avoid a restart burst.
        const period = goalMonthForKey(cursor, goal.timeZone!);
        const next = nextGoalMonth(cursor, goal.timeZone!);
        const path = `outcomes.${monthlyOutcomeKey(goal.id, cursor)}`;
        const previous = state?.outcomes?.[monthlyOutcomeKey(goal.id, cursor)];
        if (previous) {
          await GoalSet.updateOne({ _id: channel, revision: snapshot.revision, 'goals.id': goal.id,
            [cursorPath]: cursorCondition }, { $set: { [cursorPath]: next.key } }, { writeConcern: { w: 1, j: true } });
        } else {
          const total = await goalContributionTotal(channel, goal, now, period);
          const phase: GoalOutcome['phase'] = total >= goal.target ? 'completed' : 'failed';
          const selected = goal.actions?.[phase === 'completed' ? 'completion' : 'failure'];
          const suppressed = Boolean(selected && next.key < currentPeriod.key);
          const action = suppressed ? undefined : selected;
          const outcome: GoalOutcome = { phase, sequence: 1, at: now, actionStatus: action ? 'running' : 'none',
            ...(suppressed ? { actionSuppressed: 'historical_catchup' as const } : {}) };
          const claimed = await GoalSet.updateOne({ _id: channel, revision: snapshot.revision, 'goals.id': goal.id,
            [cursorPath]: cursorCondition, [`${path}.sequence`]: { $exists: false } }, {
            $set: { [path]: outcome, [cursorPath]: next.key }
          }, { writeConcern: { w: 1, j: true } });
          if (claimed.modifiedCount && action) await finishGoalAction(channel, goal.id, path, outcome, action);
        }
      }
      // A current-month completion is independent of the catch-up cursor.
      if (goal.outcome?.actionStatus === 'running' || goal.current < goal.target || goal.outcome) continue;
      const path = `outcomes.${monthlyOutcomeKey(goal.id, currentPeriod.key)}`;
      const action = goal.actions?.completion;
      const outcome: GoalOutcome = { phase: 'completed', sequence: 1, at: now, actionStatus: action ? 'running' : 'none' };
      const claimed = await GoalSet.updateOne({ _id: channel, revision: snapshot.revision, 'goals.id': goal.id,
        [`${path}.sequence`]: { $exists: false } }, { $set: { [path]: outcome } }, { writeConcern: { w: 1, j: true } });
      if (claimed.modifiedCount && action) await finishGoalAction(channel, goal.id, path, outcome, action);
      continue;
    }
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
    if (claimed.modifiedCount && action) await finishGoalAction(channel, goal.id, path, outcome, action);
  }
}

async function finishGoalAction(channel: string, goalID: string, path: string, outcome: GoalOutcome, action: GoalAction): Promise<void> {
  let actionStatus: GoalOutcome['actionStatus'] = 'finished';
  try { await runGoalAction(channel, action, goalID); }
  catch { actionStatus = 'error'; console.error('Goal action failed', { channel, goal: goalID, sequence: outcome.sequence }); }
  await GoalSet.updateOne({ _id: channel, [`${path}.sequence`]: outcome.sequence,
    [`${path}.actionStatus`]: 'running' }, { $set: { [`${path}.actionStatus`]: actionStatus } }, { writeConcern: { w: 1, j: true } });
}

export async function settleGoals(): Promise<void> {
  await getMongoDBConnection('goals-completion');
  // Stream channel IDs rather than loading every goal and receipt into memory.
  for await (const row of GoalSet.find({ 'goals.0': { $exists: true } }).select('_id').lean().cursor()) {
    try { await settleGoalChannel(row._id); }
    catch { console.error('Goal evaluation failed', { channel: row._id }); }
  }
}
