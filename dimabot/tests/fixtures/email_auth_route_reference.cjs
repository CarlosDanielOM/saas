'use strict';
// Actual TypeScript route and archived token verifier; only user lookup is a seam.
// node tests/fixtures/email_auth_route_reference.cjs --write /absolute/empty/directory
// Uses a synthetic fixture secret; no external services or credentials.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), Module = require('node:module'), http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_EMAIL_AUTH_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript'), express = local('express'), jwt = local('jsonwebtoken'), mongoose = local('mongoose');
const file = 'src/server/routes/email-auth.route.ts', pin = '105ba8e717e6e4a9e2edca8da3a7034eb754eb48a20f119b43d8ee8a85e29763';
const source = fs.readFileSync(path.join(root, file)); assert.equal(crypto.createHash('sha256').update(source).digest('hex'), pin);
const verifierFile = path.resolve(root, '../archives/dimabot-typescript/2026-10-28/src/utils/email/email-activation-token.ts');
const verifierSource = fs.readFileSync(verifierFile); const verifierPin = '73ea7d089c1b8c205c9e11973a7f8fbb47d887a3e08f68e7d76685b41f98836a';
assert.equal(crypto.createHash('sha256').update(verifierSource).digest('hex'), verifierPin);
const secret = 'fixture-secret', id = '507f1f77bcf86cd799439011';
const verifierCode = ts.transpileModule(verifierSource.toString(), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const verifierModule = {exports:{}}; const previousSecret = process.env.EMAIL_AUTH_JWT_SECRET; process.env.EMAIL_AUTH_JWT_SECRET = secret;
try { new Function('require','module','exports',verifierCode)(name => { assert.equal(name,'jsonwebtoken'); return jwt; },verifierModule,verifierModule.exports); } finally { if(previousSecret === undefined) delete process.env.EMAIL_AUTH_JWT_SECRET; else process.env.EMAIL_AUTH_JWT_SECRET = previousSecret; }
const good = jwt.sign({sub:id, login:'fallback'}, secret, {expiresIn:'1h'});
const expired = jwt.sign({sub:id, login:'fallback', exp:1}, secret);
const wrong = jwt.sign({sub:id, login:'fallback'}, 'wrong-secret', {expiresIn:'1h'});
let current = '', lookups = 0;
const users = { findById(userId) { lookups++; assert.equal(userId,id); return {lean: async () => {
    if (current === 'database-error') throw Error('fixture failure');
    if (current === 'missing-user') return null;
    if (current === 'missing-twitch') return {accounts:[{type:'youtube'}]};
    if (current === 'active') return {accounts:[{type:'twitch', actived:true}]};
    const names = {fallback:'', 'name-number':42, 'name-zero':0, 'name-boolean':true, 'name-array':['one',null,42,['x','y']], 'name-object':{x:1}, 'name-shadowed':{toString:'not callable'}, 'name-object-id':new mongoose.Types.ObjectId('507f1f77bcf86cd799439012'), 'name-empty-array':[], 'name-null':null};
    if (current === 'account-null') return {accounts:[null, {type:'twitch'}]};
    if (current === 'accounts-object') return {accounts:{type:'twitch'}};
    return {accounts:[{type:'twitch', actived:false, name: Object.hasOwn(names,current) ? names[current] : 'A +/ñ'}]};
}}; }};
function dependencies(id) {
    if (id === 'express') return express;
    if (id.endsWith('/schemas/users.schema.js')) return {__esModule:true, default:users};
    if (id.endsWith('/utils/email/email-activation-token.js')) return verifierModule.exports;
    throw Error(`unexpected import ${id}`);
}
const compiled = ts.transpileModule(source.toString(), {fileName:file, compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}});
const mod = {exports:{}}; new Function('require','module','exports',compiled.outputText)(dependencies,mod,mod.exports);
const specs = [
 {name:'missing', query:'missing'}, {name:'empty', query:'empty'}, {name:'bad', query:'bad'}, {name:'expired', query:'expired'}, {name:'wrong-signature', query:'wrong'}, {name:'duplicate', query:'duplicate'},
 ...['missing-user','missing-twitch','active','inactive','fallback','database-error','account-null','accounts-object','name-number','name-zero','name-boolean','name-array','name-object','name-shadowed','name-object-id','name-empty-array','name-null'].map(name => ({name})),
 {name:'localhost',host:'localhost:9876'}, {name:'host-escaped',host:'example.test:8000/a%2Fb%zz<quote>'}, {name:'host-case',host:'LOCALHOST:9999'},
 {name:'accept-html',accept:'text/html'}, {name:'accept-html-high',accept:'text/plain;q=0.4, text/html;q=0.9'}, {name:'accept-plain-high',accept:'text/html;q=0.2, text/plain;q=0.9'},
 {name:'accept-tie-order',accept:'text/html, text/plain'}, {name:'accept-tie-wildcard',accept:'text/*'}, {name:'accept-zero',accept:'text/plain;q=0, text/html;q=0'},
 {name:'accept-specific-zero',accept:'text/plain;q=0, */*;q=1'}, {name:'accept-none',accept:'application/json'}, {name:'accept-repeat',accept:'text/plain;q=.7, text/html;q=.7, text/plain;q=.7'}, {name:'accept-param',accept:'text/html;level=1, text/plain;q=.5'},
 {name:'accept-quoted',accept:'text/html;foo="a,b;c";q=1, text/plain;q=.2'}, {name:'head-html',accept:'text/html',method:'HEAD'}
];
function queryFor(query) { return query === 'missing' ? '' : query === 'empty' ? '?token=' : query === 'bad' ? '?token=bad' : query === 'expired' ? `?token=${expired}` : query === 'wrong' ? `?token=${wrong}` : query === 'duplicate' ? `?token=${good}&token=${good}` : `?token=${good}`; }

(async () => {
 const [mode, dir, ...extra] = process.argv.slice(2); assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length); assert.equal(fs.realpathSync(dir),dir); assert(!dir.startsWith(root + path.sep) && dir !== root); if(mode === '--write') assert.deepEqual(fs.readdirSync(dir),[]);
 const app = express(); app.use('/email', mod.exports.emailAuthRoute); const server = http.createServer(app); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 try { const cases = []; for (const spec of specs) { const {name,query,host,accept,method='GET'} = spec; current=name; lookups=0; const result = await new Promise((resolve,reject) => { const headers = {host:host || 'api.example.test'}; if (accept !== undefined) headers.accept=accept; const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/email/auth'+queryFor(query),method,headers},res => { let body=''; res.setEncoding('utf8'); res.on('data',x=>body+=x); res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location,contentType:res.headers['content-type'] || null,contentLength:res.headers['content-length'],vary:res.headers.vary,body,lookups})); }); req.on('error',reject); req.end(); }); cases.push({name,request:{query:query || 'good',host:host || 'api.example.test',accept:accept ?? null,method},expected:result}); }
 const text=JSON.stringify({metadata:{file,pin,verifierPin,scope:'actual TS route and archived verifier; fixture user lookup seam',node:process.versions.node,typescript:ts.version},cases},null,2)+'\n'; const target=path.join(dir,'email-auth-route-reference.json'); if(mode==='--write') fs.writeFileSync(target,text,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),text); console.log(crypto.createHash('sha256').update(text).digest('hex'));
 } finally { await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
