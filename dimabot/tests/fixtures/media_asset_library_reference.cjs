'use strict';
// Run only in the lead's task-owned Node container. Schema construction uses
// disconnected Mongoose. The source library and HTTP handlers use a unique,
// guarded Mongo/GridFS fixture database and an explicitly mocked auth boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && !extra.length);
assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, 'dimabot-migration', 'task-owned fixture phase only');
assert.equal(process.env.KEYWORD_FIXTURE_MONGO_URI, 'mongodb://keyword-mongo:27017', 'private fixture alias only');
const namespaceMatch = /^keyword-fixture-([0-9a-fA-F]{12}):$/.exec(process.env.KEYWORD_FIXTURE_NAMESPACE || '');
assert(namespaceMatch, 'driver-owned fixture namespace required');
const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const workspace = fs.realpathSync(path.join(root, '..'));
const outDir = fs.realpathSync(directory);
assert(outDir !== workspace && !outDir.startsWith(workspace + path.sep), 'output outside workspace');
const inputs = JSON.parse(fs.readFileSync(path.join(__dirname, 'media_asset_library_cases.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = { [inputs.source]: {sha256:inputs.sha256, provenance:inputs.provenance}, ...inputs.sources };
for (const [logical, pin] of Object.entries(sources)) {
  assert.equal(sha(fs.readFileSync(path.join(root, logical))), pin.sha256, `source changed: ${logical}`);
}
const localRequire = createRequire(path.join(root, 'package.json'));
const ts = localRequire('typescript');
const mongoose = localRequire('mongoose');
const express = localRequire('express');
const jwt = localRequire('jsonwebtoken');
const instance = new mongoose.Mongoose();
instance.set('bufferCommands', false);
instance.set('autoCreate', false);
instance.set('autoIndex', false);
const forbidden = () => { throw Error('oracle forbids database connections'); };
instance.connect = forbidden;
instance.createConnection = forbidden;
function load(logical, imports, globals = {}) {
  const source = fs.readFileSync(path.join(root, logical), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}}).outputText;
  const exported = {};
  const sandbox = {exports:exported, Buffer, console, setTimeout, clearTimeout, process:{env:{SECRET_KEY:'fixture secret'}}, ...globals,
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name.startsWith('node:')) return require(name);
      throw Error(`unexpected import ${logical}: ${name}`);
    }};
  vm.runInNewContext(code, sandbox, {filename:logical});
  return exported;
}
const service = load(inputs.source, {
  crypto:require('node:crypto'), path:require('node:path'), mongoose:{Types:{}},
  '../../middleware/admin.middleware.js':{}, '../../schemas/admin.schema.js':{},
  '../../schemas/user_media_library_item.schema.js':{}, '../../utils/dev.js':{}
});
const results = inputs.cases.map(c => {
  const tier = service.normalizePlanTier(c.tier);
  return {name:c.name, tier, upload:service.getPlanUploadLimitBytes(tier), quota:service.getPlanStorageQuotaBytes(tier),
    charge:service.getMediaQuotaChargeBytes(c.scope, c.bytes), scope:service.getDefaultMediaScope(tier, c.scope),
    type:service.inferMediaTypeFromMimeType(c.mime), extension:service.getFileExtension(c.filename, c.mime), search:service.buildMediaAssetSearchPattern(c.search)};
});
const extensions = inputs.extensions.map(c => ({...c, result:service.getFileExtension(c.filename, c.mime)}));
const mongooseImport = {__esModule:true, default:instance, Schema:instance.Schema, model:instance.model.bind(instance)};
const actualLibrary = load('src/assets/library.ts', {mongoose:mongooseImport,
  '../utils/databases/mongodb.database.js':{getMongoDBConnection:forbidden}, '../schemas/users.schema.js':{}});
const model = actualLibrary.Libraries;
const documents = inputs.documents.map(c => {
  const doc = new model(c.input);
  const error = doc.validateSync();
  return {name:c.name, document:JSON.parse(JSON.stringify(doc.toObject())),
    errors:error ? Object.keys(error.errors).sort().map(key => ({path:key, name:error.errors[key].name})) : []};
});
const schema = {collection:model.collection.name, versionKey:model.schema.options.versionKey,
  indexes:model.schema.indexes(), fields:Object.keys(model.schema.paths).sort()};
const owner = 'fixture-owner', id = '507f1f77bcf86cd799439011', bytes = Buffer.from('fixture-image-bytes');
const asset = inputs.documents.find(c => c.name === 'ready').input.assets[0];
const headersToCompare = ['cache-control','referrer-policy','content-type','content-range','content-length','x-content-type-options','content-security-policy','accept-ranges'];
async function main() {
  const live = new mongoose.Mongoose();
  live.set('autoCreate', false); live.set('autoIndex', false); live.set('bufferCommands', false);
  const dbName = `api_admin_${namespaceMatch[1]}_node${crypto.randomBytes(6).toString('hex')}`;
  let server, owned = false;
  try {
    await live.connect(process.env.KEYWORD_FIXTURE_MONGO_URI, {dbName});
    const db = live.connection.db;
    assert.deepEqual(await db.listCollections().toArray(), [], 'unique fixture database must be empty');
    await db.collection('_owner').insertOne({_id:process.env.KEYWORD_FIXTURE_NAMESPACE,owner:'dimabot-migration'});
    owned = true;
    const users = live.model('MediaOracleUsers', new live.Schema({}, {strict:false,collection:'users'}));
    await db.collection('users').insertOne({accounts:[{type:'twitch',id:owner}],plan_tier:'free'});
    const liveMongoose = {__esModule:true,default:live,Schema:live.Schema,model:live.model.bind(live)};
    const liveLibrary = load('src/assets/library.ts', {mongoose:liveMongoose,
      '../utils/databases/mongodb.database.js':{getMongoDBConnection:async()=>{}},
      '../schemas/users.schema.js':{__esModule:true,default:users}});
    const fileId = new live.mongo.ObjectId(id);
    await db.collection('asset_libraries').insertOne({_id:owner,usedBytes:bytes.length,assets:[asset]});
    await db.collection('private_assets.files').insertOne({_id:fileId,length:bytes.length,chunkSize:8,uploadDate:new Date('2030-01-01T00:00:00.000Z'),filename:'fixture.png'});
    await db.collection('private_assets.chunks').insertMany([0,1,2].map(n=>({files_id:fileId,n,data:bytes.subarray(n*8,Math.min(bytes.length,(n+1)*8))})));
    const http = load('src/assets/http.ts', {'./library.js':liveLibrary});
    const router = load('src/server/routes/asset-library.route.ts', {
      express, multer:localRequire('multer'), jsonwebtoken:jwt,
      '../../middleware/auth.middleware.js':{authMiddleware:(req,_res,next) => { req.user={id:req.headers['x-fixture-user']}; next(); }},
      '../../assets/library.js':liveLibrary, '../../assets/http.js':http
    });
    const app = express(); app.use(router.assetLibraryRoute);
    server = await new Promise((resolve,reject) => { const s = app.listen(0,'127.0.0.1',() => resolve(s)); s.once('error',reject); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ticket = jwt.sign({owner}, 'fixture secret', {algorithm:'HS256',audience:'asset-preview',subject:id,expiresIn:'15m'});
    const uploadBytes = Buffer.from(inputs.uploadBytesBase64,'base64');
    let uploadedId, gridfs;
    const cases = [];
    for (const c of inputs.http) {
      const requestHeaders = {};
      if (c.user) requestHeaders['x-fixture-user'] = c.user;
      if (c.range) requestHeaders.range = c.range;
      let body;
      if (c.multipart) {
        requestHeaders['content-type'] = 'multipart/form-data; boundary=fixture-boundary';
        body = Buffer.concat([Buffer.from('--fixture-boundary\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n'),uploadBytes,Buffer.from('\r\n--fixture-boundary--\r\n')]);
      }
      const response = await fetch(origin + c.path + (c.ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''), {method:c.method||'GET',headers:requestHeaders,body});
      const raw = await response.text();
      let responseBody = raw;
      if ((response.headers.get('content-type') || '').startsWith('application/json')) {
        responseBody = JSON.parse(raw);
        if (c.name === 'access' && responseBody.data?.path) responseBody.data.path = responseBody.data.path.replace(/ticket=.*/, 'ticket=<issued>');
        if (c.name === 'upload' && responseBody.data) {
          uploadedId = responseBody.data.id;
          const file = await db.collection('private_assets.files').findOne({_id:new live.mongo.ObjectId(uploadedId)});
          const chunks = await db.collection('private_assets.chunks').countDocuments({files_id:file._id});
          const read = await liveLibrary.readAsset(owner,uploadedId,1,9);
          const pieces = []; for await (const piece of read.stream) pieces.push(piece);
          const listing = await liveLibrary.listAssets(owner);
          gridfs = {fileFields:Object.keys(file).sort(),length:file.length,chunkSize:file.chunkSize,metadata:file.metadata,chunks,rangeHex:Buffer.concat(pieces).toString('hex'),usedBeforeDelete:listing.usedBytes,countBeforeDelete:listing.assets.length};
          responseBody.data.id='<generated>'; responseBody.data.createdAt='<generated>';
        }
      }
      const headers = {};
      for (const name of headersToCompare) {
        if (name === 'content-length' && !c.ticket) continue;
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      cases.push({name:c.name,status:response.status,headers,body:responseBody});
    }
    const listingAfter = await liveLibrary.listAssets(owner);
    gridfs.afterDelete = {fileCount:await db.collection('private_assets.files').countDocuments({_id:fileId}),
      chunkCount:await db.collection('private_assets.chunks').countDocuments({files_id:fileId}),
      usedBytes:listingAfter.usedBytes,assetCount:listingAfter.assets.length,
      pulled:!listingAfter.assets.some(item=>item.id===id)};
    assert(uploadedId, 'actual source upload required');
    await liveLibrary.deleteAsset(owner,uploadedId);
    const output = JSON.stringify({source:inputs.source,sha256:inputs.sha256,provenance:inputs.provenance,sources,
      results,extensions,documents,schema,http:cases,gridfs,
      boundaries:{mongoose:'disconnected source model',http:'actual source handlers and live task-owned Mongo/GridFS; fixture identity replaces auth',
        unavailable:['Node and Rust use separate unique databases; output is the comparison boundary']}},null,2)+'\n';
    const target = path.join(outDir, 'media-asset-library-reference.json');
    if (mode === '--write') fs.writeFileSync(target,output,{flag:'wx'});
    else assert.equal(fs.readFileSync(target,'utf8'),output);
  } finally {
    if (server) await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    if (owned) {
      const db = live.connection.db;
      assert.equal(db.databaseName, dbName);
      assert(await db.collection('_owner').findOne({_id:process.env.KEYWORD_FIXTURE_NAMESPACE,owner:'dimabot-migration'}), 'owned fixture marker');
      await db.dropDatabase();
    }
    await live.disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
