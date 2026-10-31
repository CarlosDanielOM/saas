// Execute the real keyword ingress with isolated dependencies; see --write/--check.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const files = ['src/handlers/keywords.handler.ts', 'src/handlers/commands.handler.ts', 'src/utils/keywords.ts'];
const sources = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const compiled = sources.map(source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
function load(code, requireMock, filename) {
    const exports = {};
    vm.runInNewContext(`(function(exports,require){${code}\n})`, {}, { filename })(exports, requireMock);
    return exports;
}
async function scenario(chatter, error, variant) {
    const calls = { bodies: [], executions: [], delivered: [] };
    const identity = { level: 1, tags: [] };
    const bodies = { disabled: { enabled: false, cmd: 'hello' }, stale: { enabled: true, cmd: 'other' }, good: { _id: 'good', enabled: true, cmd: 'hello', activation: 'keyword', message: 'by-id' } };
    let index = ['missing', 'disabled', 'stale', 'good'].map(id => ({ id, text: 'hello', matchMode: 'start' }));
    let text = 'hello world';
    if (variant === 'non_boolean_enabled') bodies.good.enabled = 'yes';
    if (variant === 'missing_cmd') delete bodies.good.cmd;
    if (variant === 'missing_message') delete bodies.good.message;
    if (variant === 'non_string_message') bodies.good.message = 42;
    if (variant === 'unknown_mode') bodies.good.keywordSettings = { matchMode: 'unknown' };
    if (variant === 'unknown_mode_anywhere') {
        // The index matches anywhere, the message does not start with the
        // keyword, and the body's own match mode is unknown. Only a port that
        // maps an unknown mode to `anywhere` - as the source's keywordMatches
        // does - proceeds; a port that falls back to `start` skips.
        bodies.good.keywordSettings = { matchMode: 'unknown' };
        index = ['missing', 'disabled', 'stale', 'good'].map(id => ({ id, text: 'hello', matchMode: 'anywhere' }));
        text = 'say hello there';
    }
    const keywordUtils = load(compiled[2], () => { throw Error('unexpected keyword import'); }, files[2]);
    // Load the real command module independently: ingress replaces its executor seam.
    const commandModule = load(compiled[1], () => new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key] : () => {} }), files[1]);
    if (typeof commandModule.executeCustomCommand !== 'function') throw Error('command export missing');
    const handler = load(compiled[0], id => {
        if (id.endsWith('/header.js')) return { TWITCH_BOT_ACCOUNT_ID: 'bot' };
        if (id.endsWith('/keyword_cache.js')) return { keywordIndexCache: { get: async () => index }, getKeywordBody: async (_, id) => { calls.bodies.push(id); return bodies[id]; } };
        if (id.endsWith('/keywords.js')) return { ...keywordUtils, matchKeywords: (index, text) => index.filter(entry => keywordUtils.keywordMatches(text, entry)) };
        if (id.endsWith('/commands.handler.js')) return { executeCustomCommand: async (channel, event, body, name, argument, authorization) => { calls.executions.push({ channel, body: body._id, name, argument, authorization }); return { error, message: 'sent', commandReferences: [] }; } };
        if (id.endsWith('/ast_command_delivery.js')) return { deliverAstMessage: async (_, message) => calls.delivered.push(message.parsedText) };
        throw Error(`unexpected import ${id}`);
    }, files[0]);
    try { await handler.handleKeywords('channel', { chatter_user_id: chatter, message: { text } }, identity); }
    catch (error) { calls.thrown = error.name; }
    return calls;
}
async function main() {
    const [mode, directory, ...extra] = process.argv.slice(2);
    if (!['--write', '--check'].includes(mode) || !directory || extra.length) throw Error('usage: --write DIR | --check DIR');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) throw Error('canonical directory required');
    const output = JSON.stringify({ schema: 1, provenance: { hashes: Object.fromEntries(files.map((file, i) => [file, crypto.createHash('sha256').update(sources[i]).digest('hex')])), node: process.version, typescript: ts.version }, cases: { success: await scenario('user', false), error: await scenario('user', true), bot: await scenario('bot', false), non_boolean_enabled: await scenario('user', false, 'non_boolean_enabled'), missing_cmd: await scenario('user', false, 'missing_cmd'), missing_message: await scenario('user', false, 'missing_message'), non_string_message: await scenario('user', false, 'non_string_message'), unknown_mode: await scenario('user', false, 'unknown_mode'), unknown_mode_anywhere: await scenario('user', false, 'unknown_mode_anywhere') } }, null, 2) + '\n';
    const target = path.join(directory, 'keywords_handler_cases.json');
    if (mode === '--write') { if (fs.readdirSync(directory).length) throw Error('write directory must be empty'); fs.writeFileSync(target, output, { flag: 'wx' }); }
    else if (fs.readFileSync(target, 'utf8') !== output) throw Error('fixture differs');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
