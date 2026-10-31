'use strict';
// Actual-source oracle for `src/utils/overlay-token.ts`.
//
// Run only in an isolated toolchain:
//   node tests/fixtures/overlay_token_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/overlay_token_reference.cjs --check <absolute-dir>
//
// The fixture transpiles and executes the real `src/utils/overlay-token.ts` and
// the real (retired) `utils/crypto.ts` archived source. It never contacts a
// database, cache, Twitch endpoint or network.
//
// Boundaries (also recorded in the output's `boundaries`):
// * `src/utils/crypto.ts` was retired after its native port; the preserved
//   archived source is loaded so the real `./crypto.js` import resolves, and it
//   uses Node's real AES-256-CTR implementation.
// * `src/roulette/model.ts` is still live; its real `fail` supplies the exact
//   code, message and status for every rejection branch.
// * Entropy is the only injected primitive: `node:crypto.randomBytes` is a
//   deterministic generator whose draws are recorded, so the token value and
//   the persisted envelope can be replayed by the native side. `createHash`,
//   `createCipheriv` and `createDecipheriv` are Node's own.
// * Storage is an in-memory fake with the source's `read`/`save` signature. It
//   records the exact `expectedHash`, `replace`, hash and envelope each save
//   receives, and can be scripted to lose a compare-and-set or to fail.
// * `SECRET_KEY` is a synthetic fixture key, not a credential.
//
// Run only with the pinned isolated source-corpus toolchain.

const fs = require('node:fs');
const path = require('node:path');
const realCrypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');

assert.equal(process.versions.node, '24.22.1', 'pinned Node required');
assert.equal(process.versions.v8, '13.6.233.17-node.58', 'pinned V8 required');
const root = path.resolve(__dirname, '../..');
const requireFromRoot = Module.createRequire(path.join(root, 'package.json'));
const ts = requireFromRoot('typescript');
assert.equal(ts.version, '5.9.3');

const SECRET_KEY = 'overlay-token-oracle-key';
process.env.SECRET_KEY = SECRET_KEY;

const sources = {
    overlayToken: 'src/utils/overlay-token.ts',
    crypto: '../archives/dimabot-typescript/2026-10-28/src/utils/crypto.ts',
    rouletteModel: 'src/roulette/model.ts',
    oracle: 'tests/fixtures/overlay_token_reference.cjs',
};
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');
const sha = file => realCrypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex');

// --- module loading -------------------------------------------------------
function compile(file) {
    const result = ts.transpileModule(read(file), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    });
    assert(
        !result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
        `${file} failed to transpile`,
    );
    return result.outputText;
}

const cache = new Map();
function load(file, resolve) {
    if (cache.has(file)) return cache.get(file);
    const record = {exports: {}};
    new Function('require', 'module', 'exports', '__filename', compile(file))(
        resolve,
        record,
        record.exports,
        path.resolve(root, file),
    );
    cache.set(file, record.exports);
    return record.exports;
}

// --- deterministic entropy ------------------------------------------------
// Draws are recorded in order; each entry is a `randomBytes(size)` call made by
// the real source. Fixture-built documents use `seal` with an explicit IV and
// are not recorded.
let entropy = [];
let counter = 0;
let pendingIv = null;

function generated(size) {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (counter * 37 + index * 53 + 11) & 0xff;
    counter += 1;
    return bytes;
}

function randomBytes(size) {
    if (pendingIv !== null) {
        assert.equal(size, 16, 'a sealed envelope only overrides its IV');
        const bytes = Buffer.from(pendingIv, 'hex');
        pendingIv = null;
        return bytes;
    }
    const bytes = generated(size);
    entropy.push({op: 'randomBytes', size, hex: bytes.toString('hex')});
    return Buffer.from(bytes);
}

const cryptoFacade = {
    createHash: realCrypto.createHash,
    randomBytes,
    randomUUID: realCrypto.randomUUID,
    createCipheriv: realCrypto.createCipheriv,
    createDecipheriv: realCrypto.createDecipheriv,
};
const cryptoResolve = id => {
    if (id === 'crypto' || id === 'node:crypto') return cryptoFacade;
    throw Error(`unexpected crypto import ${id}`);
};

const cryptoModule = load(sources.crypto, cryptoResolve);
const model = load(sources.rouletteModel, cryptoResolve);
const overlay = load(sources.overlayToken, id => {
    if (id === './crypto.js') return cryptoModule;
    if (id === 'node:crypto') return cryptoFacade;
    throw Error(`unexpected overlay-token import ${id}`);
});

for (const name of [
    'overlayTokenHash',
    'storedOverlayToken',
    'readOverlayToken',
    'manageOverlayToken',
    'rememberOverlayToken',
]) {
    assert.equal(typeof overlay[name], 'function', `${name} export`);
}
assert.equal(typeof model.fail, 'function');

const {overlayTokenHash, storedOverlayToken, readOverlayToken, manageOverlayToken, rememberOverlayToken} = overlay;
const {fail} = model;

function seal(text, ivHex) {
    assert.equal(pendingIv, null, 'nested seal');
    pendingIv = ivHex;
    const value = cryptoModule.encrypt(text);
    assert.equal(pendingIv, null, 'unused seal IV');
    return value;
}

function ivFor(seed) {
    return realCrypto.createHash('sha256').update(`overlay-token-oracle-iv:${seed}`).digest('hex').slice(0, 32);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// --- fake store -----------------------------------------------------------
function makeStore(doc, plan) {
    const state = {
        doc: clone(doc),
        reads: 0,
        saves: [],
        plan: plan && plan.saves ? plan.saves.slice() : null,
        failure: (plan && plan.failure) || null,
    };
    const store = {
        read: async () => {
            state.reads += 1;
            if (state.failure === 'read') throw Error('injected read failure');
            return clone(state.doc);
        },
        save: async (expectedHash, token, replace) => {
            // The real store builds `storedOverlayToken(token)` before the
            // driver call, so the envelope exists even when the write fails.
            const stored = storedOverlayToken(token);
            state.saves.push({
                expectedHash: expectedHash ?? null,
                hash: stored.tokenHash,
                replace,
                envelope: stored.overlayToken,
            });
            if (state.failure === 'save') throw Error('injected save failure');
            const ok = state.plan && state.plan.length ? state.plan.shift() : true;
            if (ok) state.doc = stored;
            return ok;
        },
    };
    return {state, store};
}

// --- case helpers ---------------------------------------------------------
const cases = [];
const codecCases = [];

function tokenFor(label) {
    return realCrypto.createHash('sha256').update(`overlay-token-oracle-token:${label}`).digest('base64url');
}

const TOKEN_A = tokenFor('a');
const TOKEN_B = tokenFor('b');
const HASH_A = overlayTokenHash(TOKEN_A);
const HASH_B = overlayTokenHash(TOKEN_B);
const SEAL_A = seal(TOKEN_A, ivFor('a'));
const SEAL_B = seal(TOKEN_B, ivFor('b'));

function emptyDocument() {
    return {tokenHash: null, overlayToken: null};
}

function linkedDocument() {
    return {tokenHash: HASH_A, overlayToken: clone(SEAL_A)};
}

async function run(kind, name, options) {
    const {input, doc = emptyDocument(), plan = null, token} = options;
    assert.equal(pendingIv, null, `${name}: no pending seal`);
    entropy = [];
    counter = 0;
    const {state, store} = makeStore(doc, plan);
    let expect;
    try {
        const value =
            kind === 'read'
                ? await readOverlayToken(store)
                : kind === 'manage'
                  ? await manageOverlayToken(store, clone(input), fail)
                  : await rememberOverlayToken(store, token);
        expect = {ok: true, value: kind === 'remember' ? null : value};
    } catch (error) {
        expect =
            error instanceof model.RouletteError
                ? {ok: false, kind: 'rejection', code: error.code, status: error.status, message: error.message}
                : {ok: false, kind: 'store', message: error && error.message ? error.message : String(error)};
    }
    cases.push({
        name,
        kind,
        input: kind === 'remember' ? {token} : clone(input),
        doc: clone(doc),
        plan: clone(plan),
        expect,
        observed: {
            reads: state.reads,
            saves: clone(state.saves),
            entropy: clone(entropy),
            finalDocument: clone(state.doc),
        },
    });
}

function readCase(name, doc, plan) {
    return run('read', name, {doc, plan});
}

function manageCase(name, input, options = {}) {
    return run('manage', name, {...options, input});
}

function rememberCase(name, token, options = {}) {
    return run('remember', name, {...options, token});
}

// --- codec parity cases ---------------------------------------------------
for (const [index, token] of [TOKEN_A, TOKEN_B].entries()) {
    const iv = ivFor(`codec-${index}`);
    const envelope = seal(token, iv);
    codecCases.push({
        name: `codec_roundtrip_${index}`,
        token,
        hash: overlayTokenHash(token),
        iv,
        envelope,
    });
}

// --- collection -----------------------------------------------------------
async function collect() {
    // Read: decrypt, hash verification and JavaScript truthiness.
    await readCase('read_null_document', {tokenHash: null, overlayToken: null});
    await readCase('read_absent_fields', {});
    await readCase('read_hash_only', {tokenHash: HASH_A, overlayToken: null});
    await readCase('read_envelope_roundtrip', linkedDocument());
    await readCase('read_hash_mismatch', {tokenHash: HASH_B, overlayToken: clone(SEAL_A)});
    await readCase('read_unreadable_iv', {tokenHash: HASH_A, overlayToken: {iv: 'zz', content: '00'}});
    await readCase('read_short_iv', {tokenHash: HASH_A, overlayToken: {iv: 'abc', content: '00'}});
    await readCase('read_empty_iv', {tokenHash: HASH_A, overlayToken: {iv: '', content: ''}});
    await readCase('read_empty_content', {tokenHash: HASH_A, overlayToken: {iv: ivFor('empty-content'), content: ''}});
    await readCase('read_envelope_without_fields', {tokenHash: HASH_A, overlayToken: {}});
    await readCase('read_empty_string_hash', {tokenHash: '', overlayToken: null});
    await readCase('read_store_failure', linkedDocument(), {failure: 'read'});

    // Request validation: all runs before any store read.
    await manageCase('invalid_null_input', null);
    await manageCase('invalid_array_input', []);
    await manageCase('invalid_string_input', 'rotate');
    await manageCase('invalid_number_input', 7);
    await manageCase('invalid_unknown_key', {rotate: false, extra: 1});
    await manageCase('invalid_rotate_string', {rotate: 'yes'});
    await manageCase('invalid_rotate_null', {rotate: null});
    await manageCase('invalid_rotate_with_token', {rotate: true, token: TOKEN_A});
    await manageCase('invalid_token_number', {token: 42});
    await manageCase('invalid_token_null', {token: null});
    await manageCase('invalid_token_short', {token: TOKEN_A.slice(0, 42)});
    await manageCase('invalid_token_long', {token: `${TOKEN_A}A`});
    await manageCase('invalid_token_character', {token: `${TOKEN_A.slice(0, 42)}+`});

    // Creation is idempotent.
    await manageCase('create_null_hash', {}, {doc: emptyDocument()});
    await manageCase('create_absent_hash_field', {}, {doc: {}});
    await manageCase('create_is_idempotent', {}, {doc: linkedDocument()});
    await manageCase('create_explicit_no_rotate', {rotate: false}, {doc: linkedDocument()});
    await manageCase('create_hash_only_requires_recovery', {}, {doc: {tokenHash: HASH_A, overlayToken: null}});
    await manageCase('create_hash_only_with_rotation_is_recovery_free', {rotate: true, version: HASH_A}, {
        doc: {tokenHash: HASH_A, overlayToken: null},
    });

    // Rotation requires the confirmed version.
    await manageCase('rotate_null_version_on_empty', {rotate: true, version: null}, {doc: emptyDocument()});
    await manageCase('rotate_absent_version_on_empty', {rotate: true}, {doc: emptyDocument()});
    await manageCase('rotate_stale_version', {rotate: true, version: HASH_B}, {doc: linkedDocument()});
    await manageCase('rotate_current_version', {rotate: true, version: HASH_A}, {doc: linkedDocument()});
    await manageCase('rotate_null_version_on_linked', {rotate: true, version: null}, {doc: linkedDocument()});
    await manageCase('rotate_empty_version_on_empty_hash', {rotate: true, version: ''}, {
        doc: {tokenHash: '', overlayToken: null},
    });
    await manageCase('rotate_cas_conflict_is_immediate', {rotate: true, version: HASH_A}, {
        doc: linkedDocument(),
        plan: {saves: [false]},
    });
    await manageCase('create_cas_retry_then_success', {}, {
        doc: emptyDocument(),
        plan: {saves: [false, true]},
    });
    await manageCase('create_cas_exhaustion', {}, {
        doc: emptyDocument(),
        plan: {saves: [false, false, false, false, false, false, false, false]},
    });

    // Replacement requires a live link and ignores the version field.
    await manageCase('replace_current_link', {token: TOKEN_A}, {doc: linkedDocument()});
    await manageCase('replace_hash_only_link', {token: TOKEN_A}, {doc: {tokenHash: HASH_A, overlayToken: null}});
    await manageCase('replace_unlinked_document', {token: TOKEN_A}, {doc: emptyDocument()});
    await manageCase('replace_wrong_token', {token: TOKEN_B}, {doc: linkedDocument()});
    await manageCase('replace_with_current_version', {token: TOKEN_A, version: HASH_A}, {doc: linkedDocument()});
    await manageCase('replace_ignores_stale_version', {token: TOKEN_A, version: HASH_B}, {doc: linkedDocument()});
    await manageCase('replace_cas_retry_then_success', {token: TOKEN_A}, {
        doc: linkedDocument(),
        plan: {saves: [false, true]},
    });
    await manageCase('replace_cas_exhaustion', {token: TOKEN_A}, {
        doc: linkedDocument(),
        plan: {saves: [false, false, false, false, false, false, false, false]},
    });

    // Recovery writes only after successful overlay authentication.
    await rememberCase('remember_hash_only_link', TOKEN_A, {doc: {tokenHash: HASH_A, overlayToken: null}});
    await rememberCase('remember_readable_link_is_untouched', TOKEN_A, {doc: linkedDocument()});
    await rememberCase('remember_hash_mismatch_is_untouched', TOKEN_B, {doc: linkedDocument()});
    await rememberCase('remember_ignores_lost_cas', TOKEN_A, {
        doc: {tokenHash: HASH_A, overlayToken: null},
        plan: {saves: [false]},
    });
    await rememberCase('remember_empty_token', '', {
        doc: {tokenHash: overlayTokenHash(''), overlayToken: null},
    });
    await rememberCase('remember_read_failure', TOKEN_A, {doc: linkedDocument(), plan: {failure: 'read'}});
    await rememberCase('remember_save_failure', TOKEN_A, {
        doc: {tokenHash: HASH_A, overlayToken: null},
        plan: {failure: 'save'},
    });

    // Store failures from the manage paths.
    await manageCase('manage_read_failure', {}, {doc: emptyDocument(), plan: {failure: 'read'}});
    await manageCase('manage_save_failure', {}, {doc: emptyDocument(), plan: {failure: 'save'}});
    await manageCase('replace_save_failure', {token: TOKEN_A}, {doc: linkedDocument(), plan: {failure: 'save'}});
}

// --- output ---------------------------------------------------------------
async function main() {
    await collect();
    const mode = process.argv[2];
    const directory = process.argv[3];
    assert(mode === '--write' || mode === '--check', 'usage: <--write|--check> <absolute-dir>');
    assert(path.isAbsolute(directory), 'fixture directory must be absolute');
    if (mode === '--write') assert.equal(fs.readdirSync(directory).length, 0, 'write directory must be empty');

    const output = `${JSON.stringify({
        schema: 1,
        provenance: {
            node: process.versions.node,
            v8: process.versions.v8,
            typescript: ts.version,
            sources: {
                [sources.overlayToken]: sha(sources.overlayToken),
                [sources.crypto]: sha(sources.crypto),
                [sources.rouletteModel]: sha(sources.rouletteModel),
            },
            oracleSha256: sha(sources.oracle),
        },
        boundaries: {
            crypto: 'src/utils/crypto.ts is retired; the preserved archived source performs real Node AES-256-CTR',
            fail: 'src/roulette/model.ts is live; its fail supplies code, message and status',
            entropy: 'node:crypto.randomBytes is a recorded deterministic generator; hashes and ciphers are Node own',
            storage: 'in-memory fake store with the source read/save signature; no driver is contacted',
            secretKey: 'synthetic fixture key, not a credential',
            encryption: 'the source encrypts once for the save and again for the returned view; the native port encrypts once and reuses that envelope',
            compareAndSet: 'the fake store normalises an absent expected version to null because the native adapter always keeps the tokenHash condition; Mongoose drops an undefined filter path, which the native adapter deliberately does not',
        },
        constants: {
            secretKey: SECRET_KEY,
            maxAttempts: 8,
            tokenBytes: 32,
            tokenLength: 43,
            ivBytes: 16,
            fields: {tokenHash: 'tokenHash', overlayToken: 'overlayToken', revision: 'revision'},
            messages: {
                invalidRequest: 'Invalid overlay link request',
                invalidToken: 'Invalid overlay token',
                linkInvalid: 'This link is no longer active',
                recoveryRequired: 'Save the existing OBS link before retrieving it',
                conflictReplace: 'The overlay link changed; reload before replacing it',
                conflictRetry: 'The overlay link changed; reload before trying again',
            },
        },
        codecCases,
        cases,
    }, null, 2)}\n`;

    const target = path.join(directory, 'overlay-token-reference.json');
    if (mode === '--write') {
        fs.writeFileSync(target, output, {flag: 'wx'});
    } else {
        assert.equal(fs.readFileSync(target, 'utf8'), output, 'fixture differs');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
