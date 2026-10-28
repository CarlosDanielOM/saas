// Frozen oracle and comparative workload for pure utility ports. Run only in a
// task-owned test container; no network, application bootstrap, or live imports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, '../../..');
const sources = {};
const compiledSources = {};
function load(name) {
    const relative = `src/utils/${name}.ts`;
    const candidates = [resolve(root, 'dimabot', relative), resolve(root, 'archives/dimabot-typescript/2026-10-28', relative)];
    const path = candidates.find(existsSync);
    assert.ok(path, `missing source and migration archive: ${relative}`);
    const source = readFileSync(path, 'utf8');
    sources[relative] = createHash('sha256').update(source).digest('hex');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    compiledSources[name] = code;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require(name) { throw new Error(`non-pure import: ${name}`); } }, { timeout: 1000 });
    return module.exports;
}
const reward = load('twitch_reward_body.util');
const bits = load('eventsub_bits_config');
const links = load('links');
const shared = load('shared_chat_origin');
const raid = load('raid_direction');
const condition = load('eventsub_condition');
const circuit = load('eventsub_reconciliation_policy');

function decode(value) {
    if (value && !Array.isArray(value) && typeof value === 'object' && '$number' in value) return Number(value.$number);
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, decode(v)]));
    return value;
}
function evaluate(operation, input) {
    switch (operation) {
        case 'reward_map': return reward.toTwitchRewardBody(input.body, input.mode);
        case 'reward_validate': return reward.validateRewardSettings(input.body);
        case 'reward_only': return reward.isTwitchOnlyRewardUpdate(input.body);
        case 'bits_config': return bits.buildBitsEventsubConfig(input.canonical, input.legacy);
        case 'helix_url': return links.getTwitchHelixUrl(input.endpoint, input.params);
        case 'oauth_url': return links.getTwitchOAuthUrl(input.endpoint, input.params);
        case 'foreign_chat': return Object.hasOwn(input, 'receiver')
            ? shared.isForeignSharedChatEvent(input.type, input.event, input.receiver)
            : shared.isForeignSharedChatEvent(input.type, input.event);
        case 'is_raid': return raid.isRaidEvent(input.type);
        case 'raid_direction': return raid.raidDirection(input.condition);
        case 'raid_config_type': return raid.raidConfigType(input.type, input.condition);
        case 'raid_condition': return raid.raidCondition(input.channel, input.direction);
        case 'expected_condition': return condition.buildExpectedEventsubCondition(input.subscription, input.channel);
        case 'circuit_breaker': return circuit.shouldTripEventsubCircuitBreaker(input.total, input.unhealthy, input.ratio, input.minimum);
        case 'number_coercion': { const n = Number(input.value); return Number.isNaN(n) ? 'NaN' : n === Infinity ? 'Infinity' : n === -Infinity ? '-Infinity' : n; }
        case 'number_string': return String(input.value);
        default: throw new Error(`unknown operation ${operation}`);
    }
}

const cases = [];
const add = (operation, input) => cases.push({ operation, input, expected: JSON.parse(JSON.stringify(evaluate(operation, decode(input)))) });
const values = [null, false, true, 0, -0.5, 0.49, 0.5, 1.5, 2, 604800, 604801, -1, 9007199254740991, 9007199254740992,
    '', ' ', '\ufeff2\u00a0', '\u00852', '0x20', '0o17', '0b11', '+0x11', 'Infinity', '-Infinity', '1e309', 'inf', '1_000', 'foo',
    [], [null], [false], [2], [[2]], [1, 2], {}, { amount: 2 }, '0x10000000000000001', '0x20000000000001', '0b' + '1'.repeat(1100)];
for (const value of values) {
    add('number_coercion', { value });
    for (const key of ['cooldown', 'maxPerStream', 'maxPerUserPerStream', 'isPaused', 'skipQueue', 'userInput', 'isEnabled']) {
        const body = { [key]: value, title: 'Reward', message: 'preserved', unknown: { nested: ['x'] } };
        add('reward_map', { body, mode: 'update' });
        add('reward_map', { body, mode: 'create' });
        add('reward_validate', { body });
    }
}
for (const body of [{}, {isPaused:true}, {maxPerStream:3,background_color:'#fff'}, {maxPerStream:3,title:'x'}, {backgroundColor:'x',skipQueue:false,userInput:null},
    {cooldown:null,global_cooldown_seconds:100,is_global_cooldown_enabled:true},
    {maxPerStream:0,max_per_stream:7,is_max_per_stream_enabled:true},
    {isPaused:'bad',is_paused:true}, {skipQueue:0,should_redemptions_skip_request_queue:true},
    {isEnabled:false,is_enabled:true,userInput:true,is_user_input_required:false}]) {
    add('reward_map', {body,mode:'update'}); add('reward_validate',{body}); add('reward_only',{body});
}
const defaultConfig = {enabled:true,message:'',endMessage:'',endEnabled:false,clipEnabled:false,minViewers:2,delay:0,cheerTiers:[]};
const customConfig = {enabled:false,message:'Custom',endMessage:'End',endEnabled:true,clipEnabled:true,minViewers:0,delay:8,cheerTiers:[{id:'large',name:'Large',message:'big',min_amount:100,max_amount:999}]};
for (const canonical of [null, {}, defaultConfig, customConfig, Object.fromEntries(Object.keys(defaultConfig).map(k=>[k,null]))]) {
    for (const legacy of [[],[{}],[defaultConfig],[customConfig],[defaultConfig,customConfig],[customConfig,defaultConfig],[{message:'\ufeff\u00a0',minViewers:2},{message:'\u0085',delay:10}],[{message:null,delay:null},{message:'',delay:0}]]) {
        add('bits_config',{canonical,legacy});
    }
}
for (const key of Object.keys(defaultConfig)) for (const value of [null,false,true,0,2,'','\ufeff','\u0085','custom',[],[1],{}]) {
    add('bits_config',{canonical:{[key]:value},legacy:[defaultConfig,customConfig]});
}
for (const endpoint of ['', 'users', 'chat/messages', '/leading', '../escape', 'a?b#c', 'snow/☃']) for (const params of [null,'','a=1','x=a%20b&x=two','?raw']) {
    add('helix_url',{endpoint,params}); add('oauth_url',{endpoint,params});
}
for (const params of [null,'','x=1']) add('oauth_url',{endpoint:null,params});
for (const type of ['channel.chat.message','channel.chat.notification','channel.raid','other']) for (const source of [undefined,null,'','a','b',0,false,[],{}]) {
    const event = {broadcaster_user_id:'a', ...(source === undefined ? {} : {source_broadcaster_user_id:source})};
    add('foreign_chat',{type,event});
    for (const receiver of [null,'a','b',0,false,[],{}]) add('foreign_chat',{type,event,receiver});
}
for (const type of ['channel.raid','channel.raid.outgoing','user.update','other','']) add('is_raid',{type});
for (const from of [undefined,null,'','from',0,1,false,true,[],{}]) for (const to of [undefined,null,'','to',0,false,[],{}]) {
    const fields = {...(from === undefined ? {} : {from_broadcaster_user_id:from}), ...(to === undefined ? {} : {to_broadcaster_user_id:to}), moderator_user_id:null, custom:{keep:true}};
    add('raid_direction',{condition:fields});
    for (const type of ['channel.raid','channel.raid.outgoing','user.update','unknown']) {
        add('raid_config_type',{type,condition:fields});
        add('expected_condition',{subscription:{type,condition:fields},channel:'new'});
    }
}
add('raid_direction',{}); add('raid_direction',{condition:null});
for (const direction of ['incoming','outgoing','','OUTGOING','unknown']) for (const channel of ['', '123', '雪']) add('raid_condition',{direction,channel});
for (const total of [-1,0,0.5,1,10,100,{$number:'Infinity'},{$number:'NaN'}]) for (const unhealthy of [-1,0,0.5,1,5,10,{$number:'Infinity'},{$number:'NaN'}]) {
    add('circuit_breaker',{total,unhealthy});
    for (const [ratio,minimum] of [[0.25,5],[0,1],[1,1],[-1,-5],[2,0],[0.25,0.5],[{$number:'NaN'},1],[0.25,{$number:'NaN'}]]) add('circuit_breaker',{total,unhealthy,ratio,minimum});
}
for (const value of [0,-0,1,-1,1e-7,1e-6,1e20,1e21,1e23,1.23e-10,1.2345678901234567,1000000000000000100,Number.MIN_VALUE,Number.MAX_VALUE,{$number:'NaN'},{$number:'Infinity'},{$number:'-Infinity'}]) add('number_string',{value});

const fixture = { schemaVersion: 1, sources, cases };
const output = resolve(fixtureDir, 'pure_utils_cases.json');
function benchmarkMain() {
    const selected = cases.filter(c => ['reward_map','bits_config','helix_url','oauth_url','foreign_chat','expected_condition','circuit_breaker'].includes(c.operation)
        && !JSON.stringify(c.input).includes('$number'));
    const iterations = Number(process.env.PURE_UTILS_ITERATIONS || 100);
    const samples = Number(process.env.PURE_UTILS_SAMPLES || 7);
    assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && Number.isSafeInteger(samples) && samples > 0);
    for (const c of selected) assert.equal(JSON.stringify(evaluate(c.operation, decode(c.input))), JSON.stringify(c.expected));
    function measure(workload, serialize = false) {
        let checksum = 0;
        let serializedBytes = 0;
        const run = () => { for (let i=0;i<iterations;i++) for(const c of workload) {
            const result = evaluate(c.operation, c.input);
            if (serialize) serializedBytes += Buffer.byteLength(JSON.stringify(result),'utf8');
            checksum += typeof result === 'boolean' ? Number(result) : typeof result === 'string' ? result.length : Object.keys(result).length;
        }};
        run();
        const results = [];
        for(let sample=0;sample<samples;sample++) {
            const cpu = process.cpuUsage(); const started=process.hrtime.bigint(); run(); const elapsed=process.hrtime.bigint()-started; const used=process.cpuUsage(cpu);
            results.push({elapsedNs:Number(elapsed),cpuUserUs:used.user,cpuSystemUs:used.system,rssBytes:process.memoryUsage().rss});
        }
        const median = results.map(v=>v.elapsedNs).sort((a,b)=>a-b)[Math.floor(results.length/2)];
        return {workloadCases:workload.length,iterations,samples:results,medianElapsedNs:median,checksum,serializedBytes};
    }
    const aggregate = measure(selected);
    const groups = [...new Set(selected.map(c=>c.operation))].map(operation => ({operation,...measure(selected.filter(c=>c.operation===operation))}));
    const serialized = {...measure(selected,true),groups:[...new Set(selected.map(c=>c.operation))].map(operation=>({operation,...measure(selected.filter(c=>c.operation===operation),true)}))};
    console.log(JSON.stringify({implementation:'typescript',measurementProcess:'compiled-js-only',node:process.version,sources,...aggregate,groups,serialized}));
}

if (process.argv.includes('--prepare-benchmark')) {
    const outputDir = process.argv[process.argv.indexOf('--prepare-benchmark')+1];
    assert.ok(outputDir && outputDir.startsWith('/'), 'explicit absolute task-owned artifact directory required');
    mkdirSync(outputDir,{recursive:true});
    for(const [name,code] of Object.entries(compiledSources)) writeFileSync(resolve(outputDir,`${name}.cjs`),code);
    writeFileSync(resolve(outputDir,'inputs.json'),JSON.stringify(cases));
    const aliases = {reward:'twitch_reward_body.util',bits:'eventsub_bits_config',links:'links',shared:'shared_chat_origin',raid:'raid_direction',condition:'eventsub_condition',circuit:'eventsub_reconciliation_policy'};
    const imports = Object.entries(aliases).map(([alias,name])=>`const ${alias}=require('./${name}.cjs');`).join('\n');
    const worker = `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\n${imports}\nconst sources=${JSON.stringify(sources)};\nconst cases=JSON.parse(readFileSync(new URL('./inputs.json',import.meta.url),'utf8'));\nconst decode=${decode.toString()};\nconst evaluate=${evaluate.toString()};\nconst benchmarkMain=${benchmarkMain.toString()};\nbenchmarkMain();\n`;
    writeFileSync(resolve(outputDir,'benchmark.mjs'),worker);
    console.log(`Prepared clean compiled-JS benchmark: ${resolve(outputDir,'benchmark.mjs')}`);
} else if (process.argv.includes('--benchmark')) {
    throw new Error('Prepare with --prepare-benchmark /absolute/task-owned/artifact-dir, then run that benchmark.mjs in a clean Node process. The oracle process loads TypeScript and must not supply deployed-runtime RSS comparisons.');
} else if (process.argv.includes('--check')) {
    assert.equal(readFileSync(output,'utf8'),JSON.stringify(fixture,null,2)+'\n');
    console.log(`Pure utility oracle: ${cases.length} source-backed cases match; closed VM, no network.`);
} else {
    writeFileSync(output,JSON.stringify(fixture,null,2)+'\n');
    console.log(`Pure utility oracle: wrote ${cases.length} source-backed cases; closed VM, no network.`);
}
