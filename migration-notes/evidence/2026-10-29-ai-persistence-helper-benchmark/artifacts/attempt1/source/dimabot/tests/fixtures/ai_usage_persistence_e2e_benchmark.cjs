'use strict';
// AUTHOR-ONLY DRAFT. --write/--check are offline. Only --serve connects, and
// only to the exact disposable aliases below. No application bootstrap/env load.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const ts = require('typescript');
const mongoosePackage = require('mongoose');
const {createClient} = require('redis');
const [mode, directory, ...rest] = process.argv.slice(2);
assert(['--write', '--check', '--serve'].includes(mode) && directory && !rest.length);
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const repo = fs.realpathSync(path.join(root, '..'));
const out = fs.realpathSync(directory);
assert(fs.statSync(out).isDirectory() && out !== repo && !out.startsWith(repo + path.sep), 'external directory required');
if (mode === '--write') assert.deepEqual(fs.readdirSync(out), [], 'existing empty directory required');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const nativeDate = Date;
const OWNER = 'dimabot-migration';
const MONGO = 'mongodb://ai-usage-persistence-bench-mongo-fixture:27017';
const REDIS = 'redis://ai-usage-persistence-bench-redis-fixture:6379/';
const POLICY = '/?directConnection=true&retryWrites=false&retryReads=false&maxPoolSize=10&minPoolSize=0&maxConnecting=2&connectTimeoutMS=5000&serverSelectionTimeoutMS=5000&w=1';
const token = process.env.DIMA_AI_PERSISTENCE_BENCH_TOKEN;
assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, OWNER);
assert.equal(process.env.DIMA_TEST_MONGO_URI, MONGO);
assert.equal(process.env.DIMA_TEST_REDIS_URI, REDIS);
assert(/^[a-z0-9]{8,32}$/.test(token ?? ''), 'unique ownership token required');
const database = `ai_usage_persistence_bench_${token}`;
assert.equal(process.env.DIMA_AI_PERSISTENCE_BENCH_DATABASE, database);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
assert.equal(mongoosePackage.version, '8.24.2');
const nodeExecutableSha256 = sha(fs.readFileSync(fs.realpathSync(process.execPath)));
assert.equal(nodeExecutableSha256, process.env.DIMA_AI_PERSISTENCE_BENCH_NODE_SHA256, 'independent Node digest required');
const mongoose = new mongoosePackage.Mongoose();
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
mongoose.set('bufferCommands', false);
const mr = createRequire(require.resolve('mongoose'));
const driverEntry = mr.resolve('mongodb');
const br = createRequire(driverEntry);
const BSON = mongoose.mongo.BSON;
const {resolveBSONOptions} = mr(path.join(path.dirname(driverEntry), 'bson.js'));
const driverBsonOptions = resolveBSONOptions({});
assert.equal(driverBsonOptions.ignoreUndefined, false, 'use driver policy, not BSON.serialize defaults');
const pins = {
 'src/utils/ai_usage_ledger.ts': '3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5',
 'src/utils/ai_usage_lock.ts': 'c66763fc7ddc9ab1ab51f3d895c4ab20ef8b37ae62e59d799e960da972eda510',
 'src/utils/ai_usage_classification.ts': '00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36',
 'src/utils/ai_usage_receipts.ts': 'd92832339b0306249c054816e2105c3fc601a7c27994b6dc7f1b8bec7e607a87',
 'src/utils/ai_usage_event.ts': '87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60',
 'src/schemas/ai_usage_dashboard.schema.ts': '0a284872d00400c766cb61995353dec43214d8564c31abb6e0c9e83e716f36c6',
 'src/schemas/ai_usage_ledger_state.schema.ts': 'ede6fc369c432d97bee0db835871c0773c1000023ac2c34ff044510c5c60121c',
 'src/schemas/ai_usage_receipt.schema.ts': '87f132f55c47cf082f37dabadc0d42f790e8324d1925f6990a3794f46d845b92',
 'src/schemas/ai_usage_daily.schema.ts': '80b5debff08e77578275a5267df1a1499138441d1bb5d55875f1eb2092318585',
};
for (const [file, digest] of Object.entries(pins)) assert.equal(sha(read(file)), digest, file);
const trees = new Map(), declarations = [], imports = [];
function tree(file) {
 if (!trees.has(file)) {
  const source = read(file), ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  assert.deepEqual(ast.parseDiagnostics, []);
  imports.push(...ast.statements.filter(ts.isImportDeclaration).map(node => ({file, text: node.getText(ast),
   module: node.moduleSpecifier.text, typeOnly: !!node.importClause?.isTypeOnly})));
  trees.set(file, {source, ast});
 }
 return trees.get(file);
}
function select(file, name, kind, exported) {
 const {source, ast} = tree(file);
 const nodes = ast.statements.filter(node => node.name?.text === name || ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name));
 assert.equal(nodes.length, 1, `${file}:${name}`);
 const node = nodes[0], text = node.getText(ast) + '\n';
 assert.equal(node.kind, ts.SyntaxKind[kind]);
 assert.equal(!!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword), exported);
 declarations.push({file, name, kind, exported, text, sha256: sha(text),
  startByte: Buffer.byteLength(source.slice(0, node.getStart(ast))), endByte: Buffer.byteLength(source.slice(0, node.end))});
 return text;
}
const ledgerFile = 'src/utils/ai_usage_ledger.ts';
const schemaFiles = Object.fromEntries(['dashboard', 'ledger_state', 'receipt', 'daily'].map(name => [name, `src/schemas/ai_usage_${name}.schema.ts`]));
const types = [
 ...['AiUsageEntryKind', 'AiUsageCategory', 'AiUsageUnit', 'AiUsageResourceType'].map(name => select('src/utils/ai_usage_event.ts', name, 'TypeAliasDeclaration', true)),
 select(schemaFiles.receipt, 'AiUsageRetentionTier', 'TypeAliasDeclaration', true),
 select('src/utils/ai_usage_receipts.ts', 'AiUsageReceiptCategory', 'TypeAliasDeclaration', true),
 select('src/utils/ai_usage_receipts.ts', 'AiUsageTransaction', 'InterfaceDeclaration', true),
 select(ledgerFile, 'QueuedAiUsageReceipt', 'InterfaceDeclaration', true),
];
const extracted = [...types,
 select('src/utils/ai_usage_classification.ts', 'ADJUSTMENT_TYPES', 'VariableStatement', true),
 select('src/utils/ai_usage_classification.ts', 'classifyAdjustment', 'FunctionDeclaration', true),
 select(ledgerFile, 'RETENTION_DAYS', 'VariableStatement', false),
 select(ledgerFile, 'VALID_CATEGORIES', 'VariableStatement', false),
 ...['validTier', 'expiryFor', 'safeCategory'].map(name => select(ledgerFile, name, 'FunctionDeclaration', false)),
 select(ledgerFile, 'getAiUsageRetentionDays', 'FunctionDeclaration', true),
 select(ledgerFile, 'receiptDocument', 'FunctionDeclaration', false),
 select(ledgerFile, 'persistAiUsageReceipt', 'FunctionDeclaration', true),
 select(ledgerFile, 'rebuildUtcDailyAggregates', 'FunctionDeclaration', false),
].join('\n');
const lockSource = select('src/utils/ai_usage_lock.ts', 'withAiUsageLock', 'FunctionDeclaration', true);
// Test-only injection is a real connected client. Do not import the process-wide
// application bootstrap, telemetry, logger, queues, or environment loader.
const adapterDeclaration = `declare const getDragonflyClient: (caller?: string) => Promise<import('redis').RedisClientType>;\n`;
const typecheck = `import {createHash, randomUUID} from 'node:crypto';\n${adapterDeclaration}
declare const Dashboards: typeof import('./src/schemas/ai_usage_dashboard.schema.js').default;
declare const AiUsageReceiptSchema: typeof import('./src/schemas/ai_usage_receipt.schema.js').default;
declare const AiUsageDailySchema: typeof import('./src/schemas/ai_usage_daily.schema.js').default;
${lockSource}\n${extracted}`;
const virtual = path.join(root, '__ai_usage_persistence_e2e_benchmark__.ts');
const options = {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, skipLibCheck: true, types: ['node'], lib: ['lib.es2022.d.ts']};
const host = ts.createCompilerHost(options), hostRead = host.readFile.bind(host), hostExists = host.fileExists.bind(host);
host.readFile = file => file === virtual ? typecheck : hostRead(file);
host.fileExists = file => file === virtual || hostExists(file);
const typeDiagnostics = ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
assert.deepEqual(typeDiagnostics, []);
const compilerOptions = {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS};
function compile(text) {
 const compiled = ts.transpileModule(text, {compilerOptions, reportDiagnostics: true});
 assert.deepEqual(compiled.diagnostics, []);
 return compiled.outputText;
}
const ledgerCompiled = compile(extracted + '\nexport {receiptDocument};\n');
const lockCompiled = compile(lockSource);
const models = {}, observedImports = [];
for (const [name, file] of Object.entries(schemaFiles)) {
 tree(file);
 const moduleObject = {exports: {}};
 vm.runInNewContext(compile(read(file)), {module: moduleObject, exports: moduleObject.exports,
  require: dependency => {
   observedImports.push({file, dependency}); assert.equal(dependency, 'mongoose');
   return {Schema: mongoose.Schema, model: mongoose.model.bind(mongoose)};
  }}, {filename: file});
 models[name] = moduleObject.exports.default;
}
const collections = Object.fromEntries(Object.entries(models).map(([name, model]) => [name, model.collection.name]));
assert.deepEqual(collections, {dashboard: 'ai_usage_dashboards', ledger_state: 'ai_usage_ledger_states', receipt: 'ai_usage_receipts', daily: 'ai_usage_dailies'});
const NOW = 1793275200000, DAY = 86400000, STAMP = NOW + 11;
// This VM clock is used only by ledger functions; lock Date is the real Date.
class LedgerFixtureDate extends nativeDate {
 constructor(...args) { if (args.length) super(...args); else super(NOW); }
 static now() { return NOW; }
 static [Symbol.hasInstance](value) { return value instanceof nativeDate; }
}
Object.defineProperty(LedgerFixtureDate, 'name', {value: 'Date'});
assert.equal(LedgerFixtureDate.name, 'Date', 'Mongoose clone checks constructor.name');
mongoose.now = () => new nativeDate(STAMP);
let cache, cachePromise;
const lockModule = {exports: {}};
vm.runInNewContext(lockCompiled, {module: lockModule, exports: lockModule.exports,
 Date: nativeDate, createHash: crypto.createHash, randomUUID: crypto.randomUUID,
 setTimeout, setInterval, clearInterval,
 getDragonflyClient: caller => { assert.equal(caller, 'AiUsageLedgerLock'); return cachePromise; }}, {filename: 'src/utils/ai_usage_lock.ts'});
const ledgerModule = {exports: {}};
vm.runInNewContext(ledgerCompiled, {module: ledgerModule, exports: ledgerModule.exports,
 Date: LedgerFixtureDate, Dashboards: models.dashboard, AiUsageReceiptSchema: models.receipt,
 AiUsageDailySchema: models.daily, withAiUsageLock: lockModule.exports.withAiUsageLock}, {filename: ledgerFile});
const source = ledgerModule.exports;
const channelID = `persistence_bench_${token}`, customerId = `customer_${token}`;
const leaseKey = `locks:ai-usage-write:${crypto.createHash('sha256').update(JSON.stringify([channelID, customerId])).digest('hex')}`;
// Verify the key expression against the actual source AST, not a permissive
// prefix allowlist. The SHA pin above freezes the rest of the lock contract.
const lockAst = tree('src/utils/ai_usage_lock.ts').ast;
const lockNode = lockAst.statements.find(node => node.name?.text === 'withAiUsageLock');
const keyNodes = lockNode.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(lockAst) === 'key');
assert.equal(keyNodes.length, 1);
const derivedKey = vm.runInNewContext(`(channelID, customerId) => ${keyNodes[0].initializer.getText(lockAst)}`, {createHash: crypto.createHash});
assert.equal(leaseKey, derivedKey(channelID, customerId));
const inputs = {format: 1, token, channelID, customerId, now: NOW, middlewareNow: STAMP, tier: 'premium',
 workloads: ['insert', 'duplicate-repair'], trials: 7, warmupBatches: 2,
 receipts: Array.from({length: 32}, (_, index) => ({
  channelID, customerId, id: `receipt_${token}_${index.toString().padStart(2, '0')}`, requestId: `request_${token}_${index}`,
  occurredAt: new nativeDate(NOW - (index % 8) * DAY + index * 1000).toISOString(),
  entryKind: 'usage', category: ['tts', 'ai_chat', 'ai_agent', 'memory'][Math.floor(index / 8)],
  operation: 'persistence_benchmark', source: 'test-only', adjustmentType: null, provider: 'fixture', model: null,
  quantity: index + 1, unit: 'tokens', credits: (index % 7) + 1, resourceType: 'llm_generation',
  resourceId: `resource_${token}_${index}`, itemized: true,
 }))};
const inputBody = JSON.stringify(inputs) + '\n', inputSha256 = sha(inputBody);
if (mode !== '--write') assert.equal(process.env.DIMA_AI_PERSISTENCE_BENCH_INPUT_SHA256, inputSha256, 'independent input digest required');
const prepared = inputs.receipts;
const preparedSha256 = sha(JSON.stringify(prepared));
function walk(directory, suffix) {
 return fs.readdirSync(path.join(root, directory), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
  const file = `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(file, suffix) : entry.isFile() && file.endsWith(suffix) ? [file] : [];
 });
}
function loadedDependencies() {
 return Object.fromEntries(Object.keys(require.cache).filter(file => file.includes(`${path.sep}node_modules${path.sep}`)).sort().map(file => {
  assert(file.startsWith(root + path.sep), 'dependency outside read-only package mount');
  return [path.relative(root, file).split(path.sep).join('/'), sha(fs.readFileSync(file))];
 }));
}
function packageEvidence(name, resolver) {
 const entry = resolver.resolve(name); let directory = path.dirname(entry);
 while (!fs.existsSync(path.join(directory, 'package.json'))) { const parent = path.dirname(directory); assert.notEqual(parent, directory); directory = parent; }
 const packageFile = path.join(directory, 'package.json'), data = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
 const relative = path.relative(root, directory).split(path.sep).join('/');
 const lock = JSON.parse(read('package-lock.json')).packages[relative];
 assert.equal(data.name, name); assert.equal(lock?.version, data.version, `lockfile package ${name}`);
 return {version: data.version, entry: path.relative(root, entry), entrySha256: sha(fs.readFileSync(entry)),
  package: path.relative(root, packageFile), packageSha256: sha(fs.readFileSync(packageFile)), integrity: lock.integrity ?? null};
}
const packages = Object.fromEntries([['typescript', require], ['mongoose', require], ['mongodb', mr], ['bson', br], ['redis', require], ['@redis/client', require]].map(([name, resolver]) => [name, packageEvidence(name, resolver)]));
assert.equal(packages.mongodb.version, '6.20.0'); assert.equal(packages.bson.version, '6.10.4');
assert.equal(packages.redis.version, '5.12.1'); assert.equal(packages['@redis/client'].version, '5.12.1');
const nativeFiles = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', ...walk('src', '.rs'), 'tests/ai_usage_persistence_e2e_benchmark.rs'];
const nativeHashes = Object.fromEntries(nativeFiles.sort().map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
const sourceHashes = Object.fromEntries([...new Set([...Object.keys(pins), 'package.json', 'package-lock.json', 'tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs'])].sort().map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
const metadata = {format: 1, scope: 'prebuilt receipt DTO -> real account lease -> dirty dashboard -> receipt upsert -> real aggregate -> daily replacement; inserts and duplicate repair',
 excluded: ['producer/classification invocation before supplied DTO', 'queue/worker/app bootstrap', 'client/model/index initialization', 'reset/seed', 'IPC', 'readback/checksum', 'contention/error/provider paths', 'application connection telemetry wrappers'],
 node: process.version, v8: process.versions.v8, typescript: ts.version, platform: process.platform, arch: process.arch,
 nodeExecutableSha256, sourceHashes, nativeHashes, nativeSourceManifestSha256: sha(JSON.stringify(nativeHashes)),
 packages, dependencies: loadedDependencies(), imports, declarations, observedImports, typeDiagnostics,
 driverBsonOptions, driverUndefinedProbeHex: BSON.serialize({value: undefined}, driverBsonOptions).toString('hex'),
 collections, mongoBase: MONGO, redisBase: REDIS, mongoPolicy: POLICY,
 redisPolicy: {database: 0, protocol: 'RESP2', commandResponseTimeout: null, serial: true},
 clocks: {ledger: NOW, mongoose: STAMP, lock: 'real wall clock, real timers; no global Date mutation'},
 indexPolicy: 'all four actual schemas createCollection/createIndexes before any warmup; preserve between resets',
 leaseKey, inputSha256, preparedSha256};
const artifactBodies = {'inputs.json': inputBody, 'source.json': JSON.stringify(metadata, null, 2) + '\n',
 'extracted.ts': extracted, 'typecheck.ts': typecheck, 'ledger.cjs': ledgerCompiled, 'lock.cjs': lockCompiled};
for (const [name, body] of Object.entries(artifactBodies)) {
 const file = path.join(out, name);
 if (mode === '--write') fs.writeFileSync(file, body, {flag: 'wx'});
 else assert.equal(fs.readFileSync(file, 'utf8'), body, name);
}
if (mode !== '--write') assert.equal(process.env.DIMA_AI_PERSISTENCE_BENCH_SOURCE_SHA256, sha(artifactBodies['source.json']), 'independent source evidence digest required');
function safeRelative(file) {
 assert(file && !path.isAbsolute(file) && file.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'));
}
function verifyReport(report) {
 assert.equal(report.format, 1); assert.equal(report.status, 'complete');
 assert.equal(report.inputSha256, inputSha256); assert.equal(report.sourceSha256, sha(artifactBodies['source.json']));
 assert.equal(report.nodeExecutableSha256, nodeExecutableSha256);
 assert.equal(report.nodeFinish.preparedSha256, preparedSha256);
 assert.equal(report.nodeFinish.nodeExecutableSha256, nodeExecutableSha256);
 assert.equal(report.nativeSourceManifestSha256, metadata.nativeSourceManifestSha256);
 assert.equal(report.nativeExecutableSha256, process.env.DIMA_AI_PERSISTENCE_BENCH_NATIVE_SHA256);
 assert.deepEqual(report.sourceMetadata, metadata);
 assert.equal(report.samples.length, 28, 'seven matched trials, two actors, two workloads');
 const logBytes = fs.readFileSync(path.join(out, 'samples.ndjson'));
 assert.equal(report.sampleLogSha256, sha(logBytes));
 const logged = logBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
 assert.deepEqual(logged, report.samples);
 for (const workload of inputs.workloads) for (let trial = 0; trial < 7; trial++) {
  const pair = report.samples.filter(sample => sample.workload === workload && sample.trial === trial);
  assert.equal(pair.length, 2); assert.equal(pair[0].actor, trial % 2 === 0 ? 'node' : 'rust');
  assert.equal(pair[1].actor, trial % 2 === 0 ? 'rust' : 'node');
  assert.deepEqual(pair[0].snapshot, pair[1].snapshot);
  for (const sample of pair) {
   assert.equal(sample.operations, 32); assert.equal(sample.inserted, workload === 'insert' ? 32 : 0);
   assert.equal(sample.duplicate, workload === 'duplicate-repair' ? 32 : 0); assert.equal(sample.expired, 0);
   assert(BigInt(sample.elapsedNs) > 0n); assert.equal(sample.snapshotSha256, sha(JSON.stringify(sample.snapshot)));
   assert.equal(sample.validation.receipts, 32); assert.equal(sample.validation.dailyDays, 8);
   assert.equal(sample.validation.dirty, true); assert.equal(sample.validation.leaseAbsent, true);
   validateStoredSnapshot(sample.snapshot);
  }
 }
 for (const [file, digest] of Object.entries(report.nodeFinish.loadedDependencies)) {
  safeRelative(file); assert(file.startsWith('node_modules/')); assert.equal(sha(fs.readFileSync(path.join(root, file))), digest, file);
 }
 assert.equal(report.cleanup.databaseDropped, true); assert.equal(report.cleanup.redisMarkerDeleted, true);
}
if (mode === '--check') {
 const allowed = new Set([...Object.keys(artifactBodies), 'samples.ndjson', 'report.json']);
 assert(fs.readdirSync(out).every(file => allowed.has(file)), 'unexpected fixture artifacts');
 if (fs.existsSync(path.join(out, 'report.json'))) verifyReport(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')));
 else assert(!fs.existsSync(path.join(out, 'samples.ndjson')), 'partial run: retained samples are not completed evidence');
}

// BSON type-preserving comparison: sort object keys and top-level documents,
// preserve arrays and all BSON values, remove only generated document _ids.
function sorted(value) {
 if (Array.isArray(value)) return value.map(sorted);
 if (!value || typeof value !== 'object' || value instanceof nativeDate || value._bsontype || Buffer.isBuffer(value)) return value;
 return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}
function assertDates(document, fields) {
 for (const field of fields) assert(document[field] instanceof nativeDate && Number.isFinite(document[field].getTime()), `actual Date field ${field}`);
}
const redisMarker = `marker:ai-usage-persistence-bench:${token}`, redisMarkerValue = `${OWNER}:${token}`;
const markerCollection = '_persistence_bench_owner';
let mongoClaimed = false, redisClaimed = false, connected = false, generation = 0;
async function owned() {
 assert(connected && database === mongoose.connection.name);
 const marker = await mongoose.connection.db.collection(markerCollection).findOne({_id: 'owner'});
 assert.equal(marker?.owner, OWNER); assert.equal(marker?.token, token);
 assert.equal(await cache.get(redisMarker), redisMarkerValue);
}
async function leaseAbsent() { assert.equal(await cache.get(leaseKey), null, 'account lease must be absent between actors'); }
async function initialize() {
 // TTL uses the real server clock. Refuse an obsolete fixture window instead
 // of silently timing deletions by the server's independent TTL monitor.
 assert(NOW - 7 * DAY + 60 * DAY > nativeDate.now() + 600000, 'fixed fixture retention window is no longer future-due');
 await mongoose.connect(MONGO + POLICY, {dbName: database, autoCreate: false, autoIndex: false});
 connected = true;
 assert.deepEqual(await mongoose.connection.db.listCollections({}, {nameOnly: true}).toArray(), [], 'fresh owned database only');
 cache = createClient({url: REDIS, socket: {reconnectStrategy: false}});
 cache.on('error', error => process.stderr.write(`benchmark Redis error: ${error.message}\n`));
 await cache.connect(); cachePromise = Promise.resolve(cache);
 assert.equal(await cache.dbSize(), 0, 'fresh private Redis server required before ownership marker');
 assert.equal(await cache.set(redisMarker, redisMarkerValue, {NX: true}), 'OK'); redisClaimed = true;
 await mongoose.connection.db.collection(markerCollection).insertOne({_id: 'owner', owner: OWNER, token, generation: 0}); mongoClaimed = true;
 await owned(); await leaseAbsent();
 // The same physical indexes apply to both clients, installed once outside all timers.
 for (const model of Object.values(models)) { await model.createCollection(); await model.createIndexes(); }
 const indexEvidence = {};
 for (const [name, model] of Object.entries(models)) indexEvidence[name] = await model.collection.listIndexes().toArray();
 await mongoose.connection.db.command({ping: 1}); await cache.ping();
 return {database, leaseKey, collections, indexes: indexEvidence,
  mongoBuildInfo: await mongoose.connection.db.admin().command({buildInfo: 1}), redisServerInfo: await cache.info('server')};
}
function validateStoredSnapshot(snapshot) {
 assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(collections).sort());
 const rows = Object.fromEntries(Object.entries(snapshot).map(([name, values]) => [name, values.map(hex => {
  const document = BSON.deserialize(Buffer.from(hex, 'hex'), {promoteValues: false, promoteLongs: false});
  assert(!Object.hasOwn(document, '_id')); assert.equal(document.channelID, channelID); assert.equal(document.customerId, customerId);
  return document;
 })]));
 assert.equal(rows.receipt.length, 32); assert.equal(rows.daily.length, 8);
 assert.equal(rows.dashboard.length, 1); assert.equal(rows.ledger_state.length, 1);
 assert.equal(rows.dashboard[0].dirty, true);
 for (const receipt of rows.receipt) {
  assertDates(receipt, ['occurredAt', 'expiresAt', 'created_at', 'updated_at']);
  const input = prepared.find(input => input.id === receipt.entryId); assert(input);
  assert.equal(Number(receipt.credits), input.credits);
  assert.equal(receipt.created_at.getTime(), STAMP); assert.equal(receipt.updated_at.getTime(), STAMP);
  assert.equal(receipt.retentionTier, inputs.tier);
 }
 assert.equal(new Set(rows.receipt.map(receipt => receipt.entryId)).size, 32);
 for (const row of rows.daily) {
  assertDates(row, ['dayStart', 'expiresAt', 'created_at', 'updated_at']);
  const matching = prepared.filter(receipt => receipt.occurredAt.startsWith(row.date)); assert.equal(matching.length, 4);
  const spent = matching.reduce((sum, receipt) => sum + receipt.credits, 0);
  assert.equal(Number(row.spentCredits), spent); assert.equal(Number(row.grantedCredits), 0);
  assert.equal(Number(row.netConsumedCredits), spent); assert.equal(Number(row.transactionCount), 4);
  assert.equal(row.created_at.getTime(), STAMP); assert.equal(row.updated_at.getTime(), STAMP);
  assert.equal(Object.keys(row.categories).length, 4);
  for (const receipt of matching) {
   assert.equal(Number(row.categories[receipt.category].credits), receipt.credits);
   assert.equal(Number(row.categories[receipt.category].transactionCount), 1);
  }
 }
 assert.equal(new Set(rows.daily.map(row => row.date)).size, 8);
}
async function reset(workload, actor) {
 assert(inputs.workloads.includes(workload) && ['node', 'rust'].includes(actor));
 await owned(); await leaseAbsent();
 for (const model of Object.values(models)) await model.collection.deleteMany({channelID, customerId});
 // Account-scoped deletes cannot conceal unrelated data in the owned DB.
 for (const model of Object.values(models)) assert.equal(await model.collection.countDocuments({}), 0);
 await models.dashboard.create({key: `dashboard_${token}`, channelID, customerId, planTier: inputs.tier,
  request: {benchmark: true}, data: {benchmark: true}, dirty: false,
  refreshedAt: new nativeDate(NOW), expiresAt: new nativeDate(NOW + 60 * DAY)});
 await models.ledger_state.create({channelID, customerId, coverageStart: new nativeDate(NOW - 8 * DAY),
  backfilledAt: new nativeDate(NOW), reportVersion: 3});
 if (workload === 'duplicate-repair') {
  // Preseed valid receipts through the actual model outside timing. This is a
  // prior-crash state: all receipts present, no daily rows, dashboard clean.
  const receipts = prepared.map(receipt => ({...source.receiptDocument(receipt, inputs.tier),
   created_at: new nativeDate(STAMP), updated_at: new nativeDate(STAMP)}));
  await models.receipt.insertMany(receipts, {ordered: false});
  assert.equal(await models.receipt.countDocuments({channelID, customerId}), 32);
 }
 assert.equal(await models.daily.countDocuments({channelID, customerId}), 0);
 generation++;
 await mongoose.connection.db.collection(markerCollection).updateOne({_id: 'owner', owner: OWNER, token}, {$set: {generation, actor, workload}});
 await leaseAbsent();
 return {generation, actor, workload};
}
async function trial() {
 const results = new Array(prepared.length);
 const start = process.hrtime.bigint();
 for (let index = 0; index < prepared.length; index++) results[index] = await source.persistAiUsageReceipt(prepared[index], inputs.tier);
 const elapsedNs = (process.hrtime.bigint() - start).toString();
 const counts = {inserted: 0, duplicate: 0, expired: 0};
 for (const result of results) { assert(Object.hasOwn(counts, result)); counts[result]++; }
 return {elapsedNs, operations: results.length, ...counts};
}
async function readback() {
 await owned(); await leaseAbsent();
 const snapshot = {};
 for (const [name, model] of Object.entries(models)) {
  const raw = await mongoose.connection.db.collection(model.collection.name).find({}, {raw: true}).toArray();
  snapshot[name] = raw.map(bytes => {
   assert(Buffer.isBuffer(bytes), 'raw BSON readback required');
   const document = BSON.deserialize(bytes, {promoteValues: false, promoteLongs: false});
   assert.equal(document.channelID, channelID); assert.equal(document.customerId, customerId);
   if (name === 'receipt') assertDates(document, ['occurredAt', 'expiresAt', 'created_at', 'updated_at']);
   if (name === 'daily') assertDates(document, ['dayStart', 'expiresAt', 'created_at', 'updated_at']);
   if (name === 'dashboard') assertDates(document, ['refreshedAt', 'expiresAt']);
   if (name === 'ledger_state') assertDates(document, ['coverageStart', 'backfilledAt', 'created_at', 'updated_at']);
   delete document._id;
   return BSON.serialize(sorted(document), driverBsonOptions).toString('hex');
  }).sort();
 }
 validateStoredSnapshot(snapshot);
 return snapshot;
}
async function cleanup() {
 let databaseDropped = false, redisMarkerDeleted = false;
 if (mongoClaimed) {
  const marker = await mongoose.connection.db.collection(markerCollection).findOne({_id: 'owner'});
  assert.equal(marker?.owner, OWNER); assert.equal(marker?.token, token);
  // No future is replayed. Parent kills/waits a failed IPC child before native
  // fallback cleanup. This actor has no in-flight helper when cleanup runs.
  await mongoose.connection.db.dropDatabase(); mongoClaimed = false; databaseDropped = true;
 }
 if (redisClaimed) {
  assert.equal(await cache.get(redisMarker), redisMarkerValue);
  await leaseAbsent();
  assert.equal(await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", {keys: [redisMarker], arguments: [redisMarkerValue]}), 1);
  redisClaimed = false; redisMarkerDeleted = true;
  assert.equal(await cache.dbSize(), 0, 'cleanup leaves fresh server empty; never FLUSH');
 }
 if (cache?.isOpen) await cache.quit();
 if (connected) { await mongoose.disconnect(); connected = false; }
 return {databaseDropped, redisMarkerDeleted};
}
async function serve() {
 let completed = false;
 const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
 const reply = value => process.stdout.write(JSON.stringify({ok: true, ...value}) + '\n');
 try {
  reply({op: 'ready', ...(await initialize()), inputSha256, preparedSha256, nodeExecutableSha256});
  for await (const line of rl) {
   const request = JSON.parse(line);
   assert(request && typeof request.op === 'string');
   if (request.op === 'reset') reply({op: 'reset', ...(await reset(request.workload, request.actor))});
   else if (request.op === 'trial') { await owned(); await leaseAbsent(); reply({op: 'trial', ...(await trial())}); }
   else if (request.op === 'readback') reply({op: 'readback', snapshot: await readback()});
   else if (request.op === 'finish') {
    assert.equal(sha(JSON.stringify(prepared)), preparedSha256, 'prepared inputs mutated');
    assert.equal(sha(fs.readFileSync(path.join(out, 'inputs.json'))), inputSha256);
    const dependencies = loadedDependencies();
    const result = await cleanup(); completed = true;
    reply({op: 'finish', cleanup: result, inputSha256, preparedSha256, nodeExecutableSha256, loadedDependencies: dependencies});
    break;
   } else assert.fail('unsupported IPC operation');
  }
  assert(completed, 'EOF before completed benchmark');
 } finally { rl.close(); process.stdin.destroy(); if (!completed) await cleanup(); }
}
if (mode === '--serve') serve().catch(error => {
 process.stderr.write(`${error.stack ?? error}\n`);
 process.stdout.write(JSON.stringify({ok: false, error: error.message}) + '\n');
 process.exitCode = 1;
});
