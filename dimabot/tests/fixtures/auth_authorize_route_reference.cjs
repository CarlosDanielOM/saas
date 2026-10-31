'use strict';
// Extracts the actual pinned declarations and handler, retaining Express/qs behavior.
// node tests/fixtures/auth_authorize_route_reference.cjs --write /absolute/empty/directory
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), Module = require('node:module'), http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_AUTH_AUTHORIZE_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json')), ts = local('typescript'), express = local('express');
assert.equal(process.versions.node, '24.22.1'); assert.equal(process.versions.v8, '13.6.233.17-node.58'); assert.equal(ts.version, '5.9.3');
const file = 'src/server/routes/auth.route.ts', pin = '05a6718d45f27365632ce7928a71a89d1b2e5a9e0e0e3a2a7dc919c8d17b806f';
const source = fs.readFileSync(path.join(root, file), 'utf8'); assert.equal(crypto.createHash('sha256').update(source).digest('hex'), pin);
assert.equal(local('express/package.json').version, '4.22.2'); assert.equal(local('qs/package.json').version, '6.15.3');
for (const [name, hash] of [['qs/lib/parse','28a66634f3f61e9f501f838f6e98dbf067633b068cb17f0bded574032c8559ea'], ['qs/lib/utils','50c7b4480a9c784d2c061c57472b0eaac020865d82bb0790a5f700db5f29523e']]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(local.resolve(name))).digest('hex'), hash);
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const scopes = ast.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === 'TWITCH_AUTH_SCOPES'));
const route = ast.statements.find(s => ts.isExpressionStatement(s) && s.expression.getText(ast).startsWith("router.get('/authorize',"));
assert(scopes && route);
const code = ts.transpileModule(`${scopes.getText(ast)}\n${route.getText(ast)}`, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const router = express.Router(); new Function('router', code)(router);
const cases = [
 ['missing',''], ['empty','?state='], ['activate','?state=hello+world&action=activate'], ['reauth','?state=A%2B%2F%C3%B1'],
 ['duplicate','?state=a&state=b&action=activate&action=activate'], ['duplicate-empty','?state=&state='],
 ['empty-array','?state[]='], ['array-repeat','?state[]=a&state[]=b'], ['indexed','?state[1]=b&state[0]=a'],
 ['sparse','?state[9]=z&state[2]=b'], ['index-repeat','?state[0]=a&state[0]=b'], ['overflow','?state[1000]=x'],
 ['safe-max','?state[9007199254740991]=a&state=b'], ['two53','?state[9007199254740992]=a&state=b'],
 ['rounded-odd','?state[9007199254740993]=a&state=b'], ['two53-shift','?state=a&state[9007199254740992]=b'],
 ['u64-max','?state[18446744073709551615]=a&state=b'], ['u64-rounded','?state=a&state[18446744073709552000]=b'],
 ['above-u64','?state=a&state[100000000000000000000]=b'], ['above-u64-merge','?state[100000000000000000000]=a&state[x]=b&state=c'],
 ['scientific','?state[1e%2B21]=a&state=b'], ['scientific-large','?state[1e%2B100]=a&state=b'],
 ['decimal-key','?state[9007199254740992.0]=a&state=b'], ['leading-zero','?state[0001000]=a&state=b'],
 ['object','?state[x]=a'], ['mixed','?state=a&state[x]=b'], ['mixed-reverse','?state[x]=b&state=a'],
 ['array-object','?state[]=a&state[x]=b'], ['nested-array','?state[0][]=a&state[0][]=b'],
 ['nested-object','?state[0][x]=a&state[0][y]=b'], ['deep','?state[a][b][c][d][e][f]=x'],
 ['proto','?state[__proto__][x]=a'], ['encoded-brackets','?state%5B0%5D=a&state%5B1%5D=b'],
 ['malformed-percent','?state=%E0%A4%A'], ['bad-percent','?state=a%20b%ZZ+c'], ['invalid-utf8','?state=%FF%20x'],
 ['malformed-key','?state[=x'], ['equals-key','?state[x=y]=z'], ['action-case','?state=x&action=Activate'],
 ['action-array','?state=x&action[]=activate'], ['action-mixed','?state=x&action=activate&action[x]=v'],
 ['limit','?'+Array.from({length:1000},(_,i)=>`x${i}=z`).join('&')+'&state=late'],
 ['localhost','?state=x&action=activate','localhost:9876'], ['host-case','?state=x','LOCALHOST:9876'],
 ['html','?state=x',null,'text/html'], ['none','?state=x',null,'application/json'], ['head','?state=x',null,'text/html','HEAD'],
 ['shadow','?state[toString]=x'], ['nested-shadow','?state[0][toString]=x']
];
(async () => {
 const [mode, dir, ...extra] = process.argv.slice(2); assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length); assert.equal(fs.realpathSync(dir),dir); assert(dir !== root && !dir.startsWith(root+path.sep)); if (mode === '--write') assert.deepEqual(fs.readdirSync(dir),[]);
 process.env.CLIENT_ID='fixture + id'; const app=express(); app.use('/auth',router); const server=http.createServer(app); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let rejection = null; const onRejection = error => { rejection = error; }; process.on('unhandledRejection', onRejection);
 try { const out=[]; for (const [name,query,host,accept,method='GET'] of cases) { const h={host:host || 'api.example.test'}; if (accept) h.accept=accept; rejection=null;
 const expected=await new Promise((resolve,reject)=>{ let settled=false; const finish=v=>{if(!settled){settled=true;resolve(v);}}; const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/auth/authorize'+query,method,headers:h},res=>{let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);res.on('end',()=>finish({kind:'response',status:res.statusCode,location:res.headers.location || null,contentType:res.headers['content-type'] || null,contentLength:res.headers['content-length'] || null,vary:res.headers.vary || null,body}));});
 const timer=setTimeout(()=>{req.destroy(); if(rejection) finish({kind:'rejected',errorName:rejection.name}); else reject(Error(`unexpected timeout: ${name}`));},500);
 req.on('close',()=>clearTimeout(timer)); req.on('error',e=>{if(!settled && !rejection){clearTimeout(timer);reject(e);}}); req.end(); }); out.push({name,request:{query,host:h.host,accept:accept || null,method},expected}); }
 const text=JSON.stringify({metadata:{file,pin,scope:'actual source declarations and handler mounted in Express',node:process.versions.node,v8:process.versions.v8,typescript:ts.version,express:local('express/package.json').version,qs:local('qs/package.json').version},cases:out},null,2)+'\n'; const target=path.join(dir,'auth-authorize-route-reference.json'); if(mode==='--write') fs.writeFileSync(target,text,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),text); console.log(crypto.createHash('sha256').update(text).digest('hex'));
 } finally { process.removeListener('unhandledRejection', onRejection); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1});
