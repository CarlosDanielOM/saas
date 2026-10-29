const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const root = '/source/dimabot', base = '/artifacts/pricing-emote-bootstrap';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pricing = JSON.parse(fs.readFileSync(`${base}/pricing/tts-usage-pricing.json`));
const emotes = JSON.parse(fs.readFileSync(`${base}/emotes/twitch_emotes_cases.json`));
const files = {source:`${root}/src/utils/tts_usage.ts`,oracle:`${root}/tests/fixtures/tts_usage_oracle.cjs`,package:`${root}/package.json`,lock:`${root}/package-lock.json`,typescript:require.resolve(`${root}/node_modules/typescript`),typescriptPackage:require.resolve(`${root}/node_modules/typescript/package.json`),node:process.execPath};
for (const [key,file] of Object.entries(files)) if (pricing.metadata.hashes[key] !== sha(file)) throw Error(`pricing source binding ${key}`);
const benchmark = JSON.parse(fs.readFileSync(`${base}/benchmark/tts-usage-benchmark-input.json`));
const {executionRealm:benchmarkRealm,...benchmarkMetadata} = benchmark.metadata;
const {executionRealm:oracleRealm,...oracleMetadata} = pricing.metadata;
if (benchmarkRealm !== 'node-commonjs-realm' || oracleRealm !== 'isolated-vm' || JSON.stringify(benchmarkMetadata) !== JSON.stringify(oracleMetadata)) throw Error('benchmark source/realm binding');
if (benchmark.benchmarkSha256 !== sha(`${root}/tests/fixtures/tts_usage_benchmark.cjs`)) throw Error('benchmark harness binding');
for (const [key,file] of Object.entries(emotes.provenance.paths)) {
 const resolved = key === 'node' ? process.execPath : path.resolve(root,file);
 if (emotes.provenance.hashes[key] !== sha(resolved)) throw Error(`emote source binding ${key}`);
}
const prior = JSON.parse(fs.readFileSync('/artifacts/emotes-normalizer-retirement/emotes/twitch_emotes_cases.json'));
const oldCases = emotes.cases.filter(c => c.id !== 'global-connect-fail');
if (JSON.stringify(oldCases) !== JSON.stringify(prior.cases)) throw Error('original 65 source cases changed');
if (pricing.cases.length !== 1738 || emotes.cases.length !== 66) throw Error('corpus count');
const report = {pricingCases:pricing.cases.length,emoteCases:emotes.cases.length,originalEmoteCasesUnchanged:oldCases.length,pricingBindings:7,emoteBindings:8,benchmarkInputSha256:sha(`${base}/benchmark/tts-usage-benchmark-input.json`)};
const roundFile = `${base}/rounding/js-round-reference.json`;
if (fs.existsSync(roundFile)) {
 const rounding = JSON.parse(fs.readFileSync(roundFile));
 if (rounding.metadata.node !== pricing.metadata.node || rounding.metadata.v8 !== pricing.metadata.v8 || rounding.metadata.hashes.script !== sha(`${root}/tests/fixtures/js_round_reference.cjs`) || rounding.metadata.hashes.nodeBinary !== sha(process.execPath) || rounding.cases.length !== rounding.metadata.count || rounding.cases.length < 2000) throw Error('Math.round source binding');
 report.roundingCases = rounding.cases.length;
 report.roundingBindings = 2;
}
fs.writeFileSync(`${base}/provenance-check.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
