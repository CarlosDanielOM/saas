'use strict';
// Small disconnected Mongoose oracle for the six media/extension schemas.
// Patches Date.now before the schema modules evaluate, because acquiredAt
// captures that function. Does not connect, save, or install indexes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const checkout = path.dirname(root);
const req = createRequire(path.join(root, 'package.json'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const FIXED = 1900000000000;
const sourceFiles = [
    'src/schemas/media_asset.schema.ts',
    'src/schemas/user_media_library_item.schema.ts',
    'src/schemas/channel_extension_item.schema.ts',
    'src/schemas/user_extension_inventory.schema.ts',
    'src/schemas/extension_wallet_transaction.schema.ts',
    'src/schemas/dimafx_playback.schema.ts',
];
const exportNames = [
    'MediaAssetSchema',
    'UserMediaLibraryItemSchema',
    'ChannelExtensionItemSchema',
    'UserExtensionInventorySchema',
    'ExtensionWalletTransactionSchema',
    'DimafxPlaybackSchema',
];
const expectedModels = [
    'MediaAsset',
    'UserMediaLibraryItem',
    'ChannelExtensionItem',
    'UserExtensionInventory',
    'ExtensionWalletTransaction',
    'DimafxPlayback',
];
const expectedCollections = [
    'mediaassets',
    'usermedialibraryitems',
    'channelextensionitems',
    'userextensioninventories',
    'extensionwallettransactions',
    'dimafxplaybacks',
];
const expectedIndexCounts = [11, 7, 11, 3, 8, 1];

const args = process.argv.slice(2);
if (args.length !== 2 || (args[0] !== '--write' && args[0] !== '--check') || !path.isAbsolute(args[1])) {
    throw new Error('usage: node tests/fixtures/media_extension_schemas_reference.cjs --write|--check <absolute-dir-outside-checkout>');
}
const [mode, dir] = args;
assert.equal(fs.realpathSync(dir), dir);
assert.equal(fs.lstatSync(dir).isDirectory(), true);
assert.notEqual(dir, checkout);
assert.equal(dir.startsWith(checkout + path.sep), false);

const ts = req('typescript');
const mongoose = req('mongoose');
const bsonRequire = createRequire(req.resolve('mongoose'));
const bson = bsonRequire('bson');
const bsonEntry = bsonRequire.resolve('bson');
const bsonPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(bsonEntry), '..', 'package.json'), 'utf8'));
assert.equal(ts.version, '5.9.3');
assert.equal(mongoose.version, '8.24.2');
assert.equal(bsonPackage.version, '6.10.4');

const instance = new mongoose.Mongoose();
for (const key of ['autoCreate', 'autoIndex', 'bufferCommands']) {
    instance.set(key, false);
    instance.connection.config[key] = false;
}
instance.now = () => new Date(FIXED);
Date.now = () => FIXED;

function plain(value) {
    if (value == null || typeof value !== 'object' || value instanceof Date || value._bsontype) return value;
    if (Array.isArray(value)) return value.map(plain);
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = plain(value[key]);
    return copy;
}

function hex(value) {
    return bson.serialize(value).toString('hex');
}

function indexRecord([keys, options]) {
    return {
        keys: plain(keys),
        unique: !!options.unique,
        sparse: !!options.sparse,
        ttl: options.expireAfterSeconds ?? null,
        partial: options.partialFilterExpression == null ? null : plain(options.partialFilterExpression),
    };
}

function mappedKind(item) {
    return item && item.name === 'CastError' ? 'cast' : item.kind;
}

function mapError(error) {
    if (error && error.name === 'CastError') return [{ path: error.path || '', name: error.name, kind: 'cast' }];
    if (!error || !error.errors) throw error;
    return Object.keys(error.errors).map((key) => {
        const item = error.errors[key];
        return { path: key, validatorPath: item.path || key, name: item.name, kind: mappedKind(item) };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
}

function run(Model, input) {
    let document;
    try {
        document = new Model(input);
    } catch (error) {
        if (error && (error.name === 'CastError' || error.name === 'ValidationError')) {
            return { errors: mapError(error), outputHex: null };
        }
        throw error;
    }
    const error = document.validateSync();
    if (error) return { errors: mapError(error), outputHex: null };
    const output = document.toObject({ versionKey: true, virtuals: false, getters: false, minimize: true });
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'id'), false);
    if (output.createdAt == null) output.createdAt = new Date(FIXED);
    output.updatedAt = output.createdAt;
    if (output.__v == null) output.__v = 0;
    assert.equal(output.createdAt.getTime(), FIXED);
    assert.equal(output.updatedAt.getTime(), FIXED);
    return { errors: [], outputHex: hex(output) };
}

const sources = {};
const loaded = [];
for (const file of sourceFiles) {
    const bytes = fs.readFileSync(path.join(root, file));
    sources[file] = sha(bytes);
    const transpiled = ts.transpileModule(bytes.toString('utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        reportDiagnostics: true,
    });
    assert.deepEqual((transpiled.diagnostics || []).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
    for (const needle of ['media_asset.schema', 'user_extension_inventory.schema', 'dimafx_queue']) {
        const line = transpiled.outputText.split('\n').find((entry) => entry.includes(needle));
        assert.equal(line, undefined, `${file} compiled ${needle}`);
    }
    const exports = {};
    vm.runInThisContext(`(function(exports, require){\n${transpiled.outputText}\n})`, { filename: file })(exports, (id) => {
        if (id !== 'mongoose') throw new Error(`unexpected require: ${id}`);
        return { Schema: instance.Schema, model: instance.model.bind(instance), Types: instance.Types };
    });
    loaded.push(exports);
}
assert.equal(instance.connection.readyState, 0);

const models = loaded.map((api, index) => {
    const model = api[exportNames[index]];
    assert.equal(typeof model, 'function', exportNames[index]);
    assert.equal(model.modelName, expectedModels[index]);
    assert.equal(model.collection.name, expectedCollections[index]);
    assert.equal(model.schema.options.versionKey !== false, true);
    assert.equal(model.schema.$timestamps.createdAt, 'createdAt');
    assert.equal(model.schema.$timestamps.updatedAt, 'updatedAt');
    const indexes = model.schema.indexes();
    assert.equal(indexes.length, expectedIndexCounts[index], model.modelName);
    for (const [, options] of indexes) {
        assert.equal(options.expireAfterSeconds, undefined);
        assert.equal(!!options.sparse, false);
    }
    return model;
});

const mediaIndexes = models[0].schema.indexes();
const s3 = mediaIndexes.find(([keys]) => Object.keys(keys).length === 1 && keys.s3Key === 1);
assert.equal(s3[1].unique, true);
const libraryUnique = models[1].schema.indexes().find(([, options]) => options.unique);
assert.deepEqual(plain(libraryUnique[0]), { channelID: 1, assetID: 1, isActive: 1 });
assert.deepEqual(plain(libraryUnique[1].partialFilterExpression), { isActive: true });
const walletUnique = models[4].schema.indexes().find(([keys, options]) => options.unique && keys.twitchTransactionID === 1);
assert.equal(Object.keys(walletUnique[0]).length, 1);
assert.deepEqual(plain(walletUnique[1].partialFilterExpression), { twitchTransactionID: { $type: 'string' } });

const idA = new instance.Types.ObjectId('507f1f77bcf86cd799439011');
const idB = new instance.Types.ObjectId('507f1f77bcf86cd799439012');

function mediaBase() {
    return {
        _id: idA,
        ownerUserID: 'owner',
        ownerChannelID: 'channel',
        ownerChannelName: 'Channel',
        uploadedByUserID: 'uploader',
        originalName: 'airhorn.mp3',
        displayName: 'Airhorn',
        fileName: 'airhorn.mp3',
        extension: 'mp3',
        mimeType: 'audio/mpeg',
        mediaType: 'audio',
        bytes: 12,
        bucket: 'bucket',
        s3Key: 'media/airhorn.mp3',
        storageUrl: 'https://cdn.example/airhorn.mp3',
        scope: 'private',
    };
}
function libraryBase() {
    return {
        _id: idA,
        channelID: 'channel',
        channelName: 'Channel',
        addedByUserID: 'user',
        assetID: idB,
        relationType: 'owner_upload',
        quotaBytesCharged: 10,
        assetScope: 'private',
        mediaType: 'audio',
    };
}
function channelBase() {
    return {
        _id: idA,
        channelID: 'channel',
        channelName: 'Channel',
        createdByUserID: 'user',
        assetID: idB,
        name: 'Airhorn',
        mediaType: 'audio',
        bitsPrice: 25,
        sku: 'airhorn',
    };
}
function inventoryBase() {
    return {
        _id: idA,
        userID: 'user',
        channelID: 'channel',
        items: [{ channelExtensionItemID: idB }],
    };
}
function walletBase() {
    return {
        _id: idA,
        channelID: 'channel',
        type: 'bits_purchase',
        metadata: { reason: 'test' },
    };
}
function playbackBase() {
    return {
        _id: 'bits-ledger-1',
        channelID: 'channel',
        payload: {
            triggerID: 'trigger',
            channelID: 'channel',
            itemID: 'item',
            name: 'Airhorn',
            category: 'audio',
            volume: 100,
            durationMs: 1000,
            source: 'bits_purchase',
            enqueuedAt: 1900000000000,
        },
    };
}

const specs = [
    ['media-minimal', 0, mediaBase],
    ['library-hex-asset', 1, () => ({ ...libraryBase(), assetID: '507f1f77bcf86cd799439011' })],
    ['channel-media-trim', 2, () => ({ ...channelBase(), name: '  Airhorn  ', bitsPrice: '100' })],
    ['channel-tts', 2, () => ({ ...channelBase(), assetID: null, name: 'Hello', category: 'tts', mediaType: 'audio', bitsPrice: 50, sku: 'hello', tts: { text: '  hello  ', language: 'es' } })],
    ['inventory-item-defaults', 3, inventoryBase],
    ['wallet-metadata', 4, walletBase],
    ['wallet-empty-metadata', 4, () => ({ ...walletBase(), metadata: {} })],
    ['playback-queue', 5, playbackBase],
    ['media-type-enum', 0, () => ({ ...mediaBase(), mediaType: 'nope' })],
    ['library-relation-enum', 1, () => ({ ...libraryBase(), relationType: 'nope' })],
    ['channel-category-image', 2, () => ({ ...channelBase(), category: 'image' })],
    ['inventory-source-enum', 3, () => { const input = inventoryBase(); input.items[0].source = 'nope'; return input; }],
    ['inventory-config-enum', 3, () => ({ ...inventoryBase(), config: { quickPurchasePriority: 'nope' } })],
    ['wallet-type-enum', 4, () => ({ ...walletBase(), type: 'nope' })],
    ['playback-state-enum', 5, () => ({ ...playbackBase(), state: 'nope' })],
    ['media-missing-s3', 0, () => { const input = mediaBase(); delete input.s3Key; return input; }],
    ['library-missing-channel', 1, () => { const input = libraryBase(); delete input.channelID; return input; }],
    ['channel-missing-user', 2, () => { const input = channelBase(); delete input.createdByUserID; return input; }],
    ['channel-missing-channel', 2, () => { const input = channelBase(); delete input.channelID; return input; }],
    ['channel-missing-bits', 2, () => { const input = channelBase(); delete input.bitsPrice; return input; }],
    ['inventory-missing-user', 3, () => { const input = inventoryBase(); delete input.userID; return input; }],
    ['channel-name-blank', 2, () => ({ ...channelBase(), name: '' })],
    ['channel-name-whitespace', 2, () => ({ ...channelBase(), name: '   ' })],
    ['channel-name-maxlength', 2, () => ({ ...channelBase(), name: 'a'.repeat(81) })],
    ['channel-tts-text-maxlength', 2, () => ({ ...channelBase(), category: 'tts', tts: { text: 'a'.repeat(501) } })],
    ['channel-volume-max', 2, () => ({ ...channelBase(), volume: 101 })],
    ['channel-volume-min', 2, () => ({ ...channelBase(), volume: -1 })],
    ['inventory-quantity-min', 3, () => { const input = inventoryBase(); input.items[0].quantity = -1; return input; }],
    ['inventory-balance-min', 3, () => ({ ...inventoryBase(), balance: -1 })],
    ['library-asset-cast', 1, () => ({ ...libraryBase(), assetID: 'not-an-objectid' })],
    ['playback-missing-payload', 5, () => { const input = playbackBase(); delete input.payload; return input; }],
    ['playback-missing-id', 5, () => { const input = playbackBase(); delete input._id; return input; }],
    ['channel-asset-required-video', 2, () => { const input = channelBase(); input.category = 'video'; delete input.assetID; return input; }],
    ['channel-asset-null-video', 2, () => ({ ...channelBase(), category: 'video', assetID: null })],
    ['channel-asset-required-default-category', 2, () => { const input = channelBase(); delete input.category; delete input.assetID; return input; }],
];

const cases = specs.map(([label, model, build]) => {
    const input = build();
    const inputHex = hex(input);
    const result = run(models[model], input);
    return { label, model, inputHex, errors: result.errors, outputHex: result.outputHex };
});

const byLabel = (label) => cases.find((item) => item.label === label);
for (const label of ['media-minimal', 'library-hex-asset', 'channel-media-trim', 'channel-tts', 'inventory-item-defaults', 'wallet-metadata', 'wallet-empty-metadata', 'playback-queue']) {
    const item = byLabel(label);
    assert.deepEqual(item.errors, [], label);
    assert.equal(typeof item.outputHex, 'string', label);
}
const tts = byLabel('channel-tts');
if (tts.errors.length) throw new Error(`mongoose rejected channel-tts: ${JSON.stringify(tts.errors)}`);
for (const label of ['channel-asset-required-video', 'channel-asset-null-video', 'channel-asset-required-default-category']) {
    const item = byLabel(label);
    assert.equal(item.outputHex, null);
    assert.deepEqual(item.errors.map((error) => [error.path, error.kind]), [['assetID', 'required']]);
}
const wallet = new models[4]({ ...walletBase(), metadata: {} });
assert.deepEqual(wallet.metadata, {});
assert.deepEqual(wallet.toObject({ minimize: false }).metadata, {});
assert.equal(wallet.toObject({ minimize: true }).metadata, undefined);
for (const label of ['media-type-enum', 'library-relation-enum', 'channel-category-image', 'inventory-source-enum', 'inventory-config-enum', 'wallet-type-enum', 'playback-state-enum', 'media-missing-s3', 'library-missing-channel', 'channel-missing-user', 'channel-missing-channel', 'channel-missing-bits', 'inventory-missing-user', 'channel-name-blank', 'channel-name-whitespace', 'channel-name-maxlength', 'channel-tts-text-maxlength', 'channel-volume-max', 'channel-volume-min', 'inventory-quantity-min', 'inventory-balance-min', 'library-asset-cast', 'playback-missing-payload', 'playback-missing-id']) {
    const item = byLabel(label);
    assert.equal(item.errors.length > 0, true, `${label}: ${JSON.stringify(item.errors)}`);
    assert.equal(item.outputHex, null, label);
}

const payload = {
    schemaVersion: 1,
    versions: { typescript: ts.version, mongoose: mongoose.version, bson: bsonPackage.version },
    sources,
    models: models.map((model) => ({
        model: model.modelName,
        collection: model.collection.name,
        versionKey: model.schema.options.versionKey !== false,
        createdAt: model.schema.$timestamps.createdAt,
        updatedAt: model.schema.$timestamps.updatedAt,
        indexes: model.schema.indexes().map((index) => hex(indexRecord(index))),
    })),
    cases,
    caseCount: cases.length,
};
const text = `${JSON.stringify(payload, null, 2)}\n`;
const file = path.join(dir, 'media-extension-schemas.json');
if (mode === '--write') {
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.writeFileSync(file, text, { flag: 'wx' });
} else {
    assert.equal(fs.readFileSync(file).equals(Buffer.from(text)), true);
}

// Optional private fixture: verify the in-memory/default, stored and hydrated
// representations against the actual source model, never a configured database.
if (process.env.MEDIA_EXTENSION_MONGO_PROBE === '1') {
    assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, 'dimabot-migration');
    assert.equal(process.env.KEYWORD_FIXTURE_MONGO_URI, 'mongodb://keyword-mongo:27017');
    const namespace = process.env.KEYWORD_FIXTURE_NAMESPACE;
    assert.match(namespace, /^keyword-fixture-[a-z0-9]{6,32}:$/);
    const dbName = namespace.slice(0, -1).replaceAll('-', '_') + '_media_source';
    (async () => {
        await instance.connect(process.env.KEYWORD_FIXTURE_MONGO_URI, { dbName });
        let ownedEmpty = false;
        try {
            assert.deepEqual(await instance.connection.db.listCollections().toArray(), []);
            await instance.connection.db.collection('__fixture_owner').insertOne({ _id: 'owner', owner: 'dimabot-migration', namespace });
            ownedEmpty = true;
            const saved = await models[4].create({ ...walletBase(), metadata: {} });
            assert.deepEqual(saved.metadata, {});
            assert.equal(saved.toObject({ minimize: true }).metadata, undefined);
            const raw = await models[4].collection.findOne({ _id: saved._id });
            assert.equal(raw.metadata, undefined);
            const hydrated = await models[4].findById(saved._id);
            assert.deepEqual(hydrated.metadata, {});
            const inventoryFilter = { platform: 'twitch', userID: 'upsert-user', channelID: 'upsert-channel' };
            const inventoryInsert = { ...inventoryFilter, balance: 0, config: { quickPurchasePriority: 'credits_first', quickPurchaseAction: 'use_now' }, items: [] };
            const inventory = await models[3].findOneAndUpdate(inventoryFilter, { $setOnInsert: inventoryInsert, $set: { displayName: 'First' } }, { upsert: true, new: true }).lean();
            assert.equal(inventory.displayName, 'First');
            assert.equal(inventory.__v, 0);
            assert.deepEqual(inventory.dimafxReceipts, []);
            assert.equal(inventory.config.quickPurchasePriority, 'credits_first');
            await models[3].updateOne(inventoryFilter, { $set: { balance: 7 } });
            const inventoryAgain = await models[3].findOneAndUpdate(inventoryFilter, { $setOnInsert: inventoryInsert, $set: { displayName: 'Second' } }, { upsert: true, new: true }).lean();
            assert.equal(inventoryAgain.balance, 7);
            assert.equal(inventoryAgain.displayName, 'Second');
            const playbackFilter = { _id: 'source-upsert' };
            const playbackInsert = { channelID: 'upsert-channel', payload: { triggerID: 'source-upsert' }, state: 'queued', leaseOwner: '', leaseUntil: new Date(0) };
            await models[5].updateOne(playbackFilter, { $setOnInsert: playbackInsert }, { upsert: true });
            await models[5].updateOne(playbackFilter, { $set: { state: 'playing' } });
            await models[5].updateOne(playbackFilter, { $setOnInsert: playbackInsert }, { upsert: true });
            const playback = await models[5].findById('source-upsert').lean();
            assert.equal(playback.state, 'playing');
            assert.equal(playback.__v, 0);
            assert.equal(playback.payload.triggerID, 'source-upsert');
            console.log('wallet memory/storage/hydration and inventory/playback insert/repeat upserts verified');
        } finally {
            if (ownedEmpty) {
                const marker = await instance.connection.db.collection('__fixture_owner').findOne({ _id: 'owner' });
                assert.equal(marker?.owner, 'dimabot-migration');
                assert.equal(marker?.namespace, namespace);
                await instance.connection.dropDatabase();
            }
            await instance.disconnect();
        }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
}
