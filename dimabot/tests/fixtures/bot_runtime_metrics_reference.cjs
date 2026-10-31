// Source oracle: transpile the actual TS module with mocked clock, Redis and timer.
// Executed only by an explicitly requested isolated test, never at import by the app.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('../../node_modules/typescript');
const filename = path.resolve(__dirname, '../../src/utils/observability/bot_runtime_metrics.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const commands = [];
const cache = {
  async hIncrBy(key, field, value) { commands.push(['HINCRBY', key, field, value]); },
  async hSet(key, values) { for (const [field, value] of Object.entries(values)) commands.push(['HSET', key, field, value]); },
  async expire(key, seconds) { commands.push(['EXPIRE', key, seconds]); },
  async set(key, value, options) { commands.push(['SET',key,JSON.parse(value),options.EX]); },
  async lPush(key, value) { commands.push(['LPUSH',key,JSON.parse(value)]); },
  async lTrim(key, start, end) { commands.push(['LTRIM',key,start,end]); }
};
const fixed = 1767225600000;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
const exportsObject = {};
const context = { exports: exportsObject, process: { env: {}, pid: 7, version: "vtest", uptime: () => 2, memoryUsage: () => ({rss:1,heapTotal:2,heapUsed:3,external:4,arrayBuffers:5}) }, Date: Clock, console,
  require(name) {
    if (name === 'node:perf_hooks') return { monitorEventLoopDelay: () => ({min:0,max:0,mean:0,stddev:0,percentile:()=>0,reset(){},enable(){}}) };
    if (name.includes('dragonfly.database')) return { getDragonflyClient: async () => cache };
    throw new Error(`unexpected import ${name}`);
  }
};
vm.runInNewContext(code + '\nexports.__flush = flushRuntimeSnapshot;', context, { filename });
(async () => {
  if (process.argv[2] === 'runtime') {
    exportsObject.observeEventsubNotification('', 42);
    exportsObject.observeEventsubNotification('channel.raid', -5);
    exportsObject.startMessageHandlerMetric(); exportsObject.endMessageHandlerMetric({}, true);
    exportsObject.recordEmbeddingBatchResult(4, true);
    exportsObject.recordRedisOpsEstimate(2.5);
    await exportsObject.__flush();
    await exportsObject.__flush();
    process.stdout.write(JSON.stringify(commands)); return;
  }
  await exportsObject.recordSemanticMemoryMetric({ channelID: '42', requested: 3.5, retrieved: -2, latencyMs: 12.4, avgScore: 0.2345, failed: true, pass: 'first' });
  await exportsObject.recordStreamMemoryJobMetric({ channelID: '42', latencyMs: 5.5, failed: true, status: 'done', jobType: 'summary', source: 'manual' });
  await exportsObject.recordStreamMemoryActionMetric({ channelID: '42', action: 'save', source: 'manual', count: 2.5 });
  process.stdout.write(JSON.stringify(commands));
})().catch(error => { console.error(error); process.exitCode = 1; });
