'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {root, usage, api, last} = require('./posthog_tracking_source.cjs');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length);
const dir = path.resolve(directory);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const files = ['src/utils/posthog_events.ts', 'src/utils/ai_usage_event.ts', 'package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'src/utils/posthog_tracking.rs', 'src/utils/ai_usage.rs', 'src/utils/lossless_json.rs', 'src/utils/js_string.rs', 'src/utils/js_compat.rs', 'src/utils/json_number.rs', 'tests/fixtures/posthog_tracking_source.cjs', 'tests/fixtures/posthog_tracking_benchmark.cjs', 'tests/posthog_tracking_benchmark.rs'];
const metadata = {format: 'posthog-prepared-v1', node: process.version, v8: process.versions.v8, typescript: require('typescript').version, hashes: Object.fromEntries(files.map(f => [f, sha(fs.readFileSync(path.join(root, f)))])), typescriptPackage: sha(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json')))};
const methods = {command:'trackCommand', tts:'trackTts', 'ai-usage':'trackAiUsageRecorded', 'ai-operation':'trackAiOperation', 'tts-unicode':'trackTts', 'tts-large':'trackTts'};
const names = Object.keys(methods);
const bytesum = b => { let s = 0; for (const byte of b) s = (s + byte) >>> 0; return s; };
function input(name, i) {
  const channelID = `channel-${i}`, channelName = `name-${i}`;
  if (name === 'command') return {channelID, channelName, command:`cmd-${i}`, status:i%2?'error':'success', userID:i%2?'':`user-${i}`, username:`nick-${i}`, arguments:`arg-${i}`, errorMessage:`error-${i}`};
  if (name === 'ai-operation') return {requestId:`request-${i}`, channelID, category:`category-${i}`, operation:`op-${i}`, source:`source-${i}`, lifecycle:i%2?'queued':'completed', requestedProvider:`p-${i}`, actualProvider:`actual-${i}`, fallbackReason:`fallback-${i}`, errorCode:`code-${i}`, resourceType:`type-${i}`, resourceId:`resource-${i}`, latencyMs:i*13};
  if (name === 'ai-usage') {
    const context = usage.createAiUsageContext('messages', {entryId:`entry-${i}`, requestId:`request-${i}`, parentRequestId:`parent-${i}`, channelID, model:`model-${i}`, resourceId:`resource-${i}`, resourceType:'llm_generation', quantity:i+0.25, unit:'tokens'});
    return {context, credits:i+0.5, reason:`reason-${i}`, polarCostAmount:i+0.125, inputTokens:i+1, outputTokens:i+2, totalTokens:i+3};
  }
  let message = `message-${i}`;
  if (name === 'tts-unicode') message += `-音😀-\ud800-${i}-\udc00`;
  if (name === 'tts-large') message += (`-long-${i}-😀`).repeat(512);
  return {channelID, channelName, source:i%2?'ast':'chat-command', ttsType:`voice-${i}`, characters:message.length, message, status:i%2?'error':'success', mode:`mode-${i}`, provider:`provider-${i}`, userID:`user-${i}`, username:`nick-${i}`, errorMessage:`error-${i}`};
}
function capture(name, p) { api[methods[name]](p); return last(); }
const pools = names.map(name => ({name, operations:name === 'tts-large' ? 32768 : 256000, warmups:32000, inputs:Array.from({length:32}, (_, i) => {
  const params = input(name, i), expectedWire = JSON.stringify(capture(name, params));
  return {params, contextText:name === 'ai-usage' ? JSON.stringify(params.context) : null, expectedWire, checksum:bytesum(Buffer.from(expectedWire, 'utf8'))};
})}));
const fixture = JSON.stringify({metadata, pools}) + '\n';
const inputHash = sha(fixture);
const expected = p => { let sum=0; for(let i=0;i<p.operations;i++) sum=(sum+p.inputs[i%32].checksum)>>>0; return sum; };
function validateReport(report, runtime) {
  assert.equal(report.format, metadata.format); assert.equal(report.inputSha256, inputHash); assert.equal(report.runtime, runtime);
  assert.deepEqual(report.metadata, metadata); assert.equal(report.pools.length, 6);
  report.pools.forEach((p, i) => { assert.equal(p.name, pools[i].name); assert.equal(p.operations, pools[i].operations); assert.equal(p.warmups, pools[i].warmups); assert.equal(p.trials.length, 7);
    for (const t of p.trials) { assert(Number.isFinite(t.nanoseconds) && t.nanoseconds > 0); assert.equal(t.checksum, expected(pools[i])); }
    const sorted=p.trials.map(t=>t.nanoseconds).sort((a,b)=>a-b); assert.deepEqual([p.min,p.median,p.max], [sorted[0],sorted[3],sorted[6]]);
  });
}
if (mode === '--write') {
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'input.json'), fixture, {flag:'wx'});
  const results = pools.map(p => {
    const run = n => {let sum=0; for(let i=0;i<n;i++) sum=(sum+bytesum(Buffer.from(JSON.stringify(capture(p.name,p.inputs[i%32].params)),'utf8')))>>>0; return sum;};
    run(p.warmups);
    const trials=[]; for(let i=0;i<7;i++) {const start=process.hrtime.bigint(); const checksum=run(p.operations); const nanoseconds=Number(process.hrtime.bigint()-start); assert.equal(checksum,expected(p)); trials.push({nanoseconds,checksum});}
    const sorted=trials.map(t=>t.nanoseconds).sort((a,b)=>a-b); return {name:p.name,operations:p.operations,warmups:p.warmups,trials,min:sorted[0],median:sorted[3],max:sorted[6]};
  });
  const report={format:metadata.format,inputSha256:inputHash,runtime:'node',metadata,pools:results}; validateReport(report,'node');
  fs.writeFileSync(path.join(dir,'node-report.json'), JSON.stringify(report)+'\n', {flag:'wx'});
} else {
  assert.deepEqual(fs.readdirSync(dir).sort(), ['input.json','native-report.json','node-report.json']);
  assert.equal(fs.readFileSync(path.join(dir,'input.json'),'utf8'),fixture);
  for(const runtime of ['node','native']) validateReport(JSON.parse(fs.readFileSync(path.join(dir,`${runtime}-report.json`),'utf8')),runtime);
}
