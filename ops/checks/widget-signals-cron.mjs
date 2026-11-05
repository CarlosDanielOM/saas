// saas-ops only (cron target), with the cron-supervisors fixtures (see ops/README.md).
// Timers run in dima-cron. A timer body with $(widget.signal) must answer `Error: widget_signal_context_required`
// (timers have no live Twitch authority) and never publish anything on the Dragonfly `widget-feed` channel.
import assert from 'node:assert/strict';

globalThis.fetch = async () => { throw new Error('Outbound request blocked in widget-signals-cron check'); };
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
const { renderTimerMessage } = await import('/app/dist/utils/timer_runtime.js');
const { getFunctionMetadata } = await import('/app/dist/utils/ast_parser/evaluator.js');

await getMongoDBConnection('widget-signals-cron-check');
const redis = await getDragonflyClient('widget-signals-cron-check');
const feed = [];
const subscriber = redis.duplicate(); await subscriber.connect();
await subscriber.subscribe('widget-feed', message => feed.push(message));
try {
  const result = await renderTimerMessage({ channelID: '990779', streamerName: 'TimerFixture', timerName: 'hydrate', planTier: 'free',
    message: 'Stay hydrated! $(widget.signal hype) $(widget.signal.to "Pet corner" feed 1)', parse: parseSpecialCommands });
  assert.equal(getFunctionMetadata('widget.signal')?.category, 'overlay', 'the cron image registers the widget functions');
  assert.equal(result.parsedText, 'Stay hydrated! Error: widget_signal_context_required Error: widget_signal_context_required');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(feed, [], 'timers never publish signals');
  console.log('PASS timers: $(widget.signal) and $(widget.signal.to) explain that they need a live chat command or event, and publish nothing.');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await subscriber.quit().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
