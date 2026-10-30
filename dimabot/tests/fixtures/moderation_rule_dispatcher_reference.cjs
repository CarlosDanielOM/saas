'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Compile the complete, unmodified TypeScript exports; resolve retired modules
// to their byte-pinned archive copies. No evaluator implementations are mocked.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const Module=require('node:module'), assert=require('node:assert/strict');
const root=fs.realpathSync(process.env.DIMA_RULE_SOURCE_ROOT || path.resolve(__dirname,'../../..'));
const read=p=>fs.readFileSync(p.startsWith('dimabot/') ? leaf.sourcePath(path.join(root,'dimabot'),p.slice(8)) : path.join(root,p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pins={
 'dimabot/src/utils/moderation/rules/index.ts':'39e93288c898eaa68826ec2f011d2ea3fc326d5993293815c3df588552a65d08',
 'dimabot/src/utils/moderation/rules/links.rule.ts':'802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0',
 'dimabot/src/utils/moderation/rules/blacklist.rule.ts':'8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff',
 'dimabot/src/utils/moderation/normalize.ts':'07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab',
 'dimabot/src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/caps.rule.ts':'62f7fe37760cbf5640544cab646a639d06b42883532657634a00e25488888797',
 'archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/emote_spam.rule.ts':'24e7c603569d1063642575372de1066e4f5d5d5de46c88e15e450a549c17f12f',
 'dimabot/node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
};
for(const [p,h] of Object.entries(pins)) assert.equal(sha(read(p)),h,p);
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local=Module.createRequire(path.join(root,'dimabot/package.json')),ts=local('typescript');
assert.equal(ts.version,'5.9.3'); assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'dimabot/node_modules/typescript/lib/typescript.js')));
const files={normalize:'dimabot/src/utils/moderation/normalize.ts',caps:'archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/caps.rule.ts',links:'dimabot/src/utils/moderation/rules/links.rule.ts',emote:'archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/emote_spam.rule.ts',blacklist:'dimabot/src/utils/moderation/rules/blacklist.rule.ts',index:'dimabot/src/utils/moderation/rules/index.ts'};
const expectImports={normalize:[],caps:[['../../../schemas/channel_moderation_settings.schema.js',true]],links:[['../../../schemas/channel_moderation_settings.schema.js',true]],emote:[['../../../schemas/channel_moderation_settings.schema.js',true]],blacklist:[['../../../schemas/channel_moderation_settings.schema.js',true],['../normalize.js',false]],index:[['../../../schemas/channel_moderation_settings.schema.js',true],['./caps.rule.js',false],['./links.rule.js',false],['./emote_spam.rule.js',false],['./blacklist.rule.js',false]]};
const expectExports={normalize:['escapeRegExp','foldText'],caps:['evaluateCapsRule','stripEmoteTexts'],links:['evaluateLinksRule'],emote:['evaluateEmoteSpamRule'],blacklist:['compileBlacklistPattern','evaluateBlacklistRule'],index:['evaluateRule']};
const loaded={},evidence={},compiled={};
for(const [key,file] of Object.entries(files)) {
 const source=read(file).toString('utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);
 assert.deepEqual(ast.parseDiagnostics,[]);
 const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>({path:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,text:s.getText(ast)}));
 assert.deepEqual(imports.map(x=>[x.path,x.typeOnly]),expectImports[key]);
 const declarations=ast.statements.filter(s=>(ts.isFunctionDeclaration(s)||ts.isInterfaceDeclaration(s))&&s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>({kind:ts.SyntaxKind[s.kind],name:s.name.text,signature:ts.isFunctionDeclaration(s)?source.slice(s.getStart(ast),s.body.getStart(ast)).trim():s.getText(ast)}));
 evidence[file]={imports,declarations};
 const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true}); assert.deepEqual(out.diagnostics,[]); compiled[file]=sha(out.outputText);
 const mod=new Module(path.join(root,file),module); mod.filename=path.join(root,file);
 mod.require=id=>{ const map={'../normalize.js':'normalize','./caps.rule.js':'caps','./links.rule.js':'links','./emote_spam.rule.js':'emote','./blacklist.rule.js':'blacklist'}; assert.ok(map[id] && loaded[map[id]],id); return loaded[map[id]]; };
 mod._compile(out.outputText,mod.filename); loaded[key]=mod.exports; assert.deepEqual(Object.keys(mod.exports).sort(),expectExports[key].slice().sort());
}
const schemaFile='dimabot/src/schemas/channel_moderation_settings.schema.ts',schemaSource=read(schemaFile).toString('utf8'),schema=ts.createSourceFile(schemaFile,schemaSource,ts.ScriptTarget.ES2022,true);
assert.deepEqual(schema.parseDiagnostics,[]);
const rule=schema.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='IModerationRule'); assert.ok(rule);
const types=Object.fromEntries(rule.members.map(m=>[m.name.getText(schema),m.type.getText(schema)]));
for(const [k,v] of Object.entries({type:'ModerationRuleType',capsThresholdMode:'CapsThresholdMode',minCapsCount:'number',maxCapsPercentage:'number',minMessageLength:'number',allowlistDomains:'string[]',maxEmoteCount:'number',terms:'string[]'})) assert.equal(types[k],v);
evidence[schemaFile]={interface:rule.getText(schema),aliases:schema.statements.filter(s=>ts.isTypeAliasDeclaration(s)&&['ModerationRuleType','CapsThresholdMode'].includes(s.name.text)).map(s=>s.getText(schema))};
const units=s=>s==null?null:Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const base={capsThresholdMode:'count',minCapsCount:2,maxCapsPercentage:50,minMessageLength:1,allowlistDomains:[],maxEmoteCount:3,terms:['bad']};
const cases=[];
function add(name,type,text,options={}) { const r={...base,...options.rule,type}; const input={text,emoteTexts:options.emotes||[],emoteCount:options.count??0}; if('count' in options) input.emoteCount=options.count; const pattern=options.pattern==='compiled'?loaded.blacklist.compileBlacklistPattern(r.terms):options.pattern==='null'?null:undefined; const result=loaded.index.evaluateRule(r,input,pattern); cases.push({name,type,text:units(text),emotes:input.emoteTexts.map(units),count:bits(input.emoteCount),mode:r.capsThresholdMode,minCaps:bits(r.minCapsCount),maxCaps:bits(r.maxCapsPercentage),minLength:bits(r.minMessageLength),allowlist:r.allowlistDomains.map(units),maxEmotes:bits(r.maxEmoteCount),terms:r.terms.map(units),pattern:options.pattern||'missing',triggered:result.triggered,detail:units(result.detail)}); }
add('caps-trigger','caps','AAa'); add('caps-no','caps','aaa'); add('caps-half','caps','A'+ 'a'.repeat(199),{rule:{capsThresholdMode:'percentage'}}); add('caps-emotes','caps','KAPPA AAa',{emotes:['KAPPA']}); add('caps-unicode','caps','𐐀a\ud800');
add('links-trigger','links','HTTPS://Σ\ud800.Example/path'); add('links-allowed','links','https://clips.twitch.tv/x',{rule:{allowlistDomains:['twitch.tv']}}); add('links-empty','links','hello');
for(const [name,n,max] of [['above',4,3],['equal',3,3],['nan',NaN,3],['infinity',Infinity,3],['negative-infinity',-Infinity,Infinity],['negative-zero',-0,-0],['large',1e21,1000000000000000100],['tiny',1e-7,0]]) add('emote-'+name,'emote_spam','',{count:n,rule:{maxEmoteCount:max}});
add('blacklist-match','blacklist','!CAFÉ!',{rule:{terms:['cafe']},pattern:'compiled'}); add('blacklist-no','blacklist','clean',{pattern:'compiled'}); add('blacklist-lone','blacklist','!\ud800!',{rule:{terms:['\ud800']},pattern:'compiled'}); add('blacklist-missing','blacklist','bad'); add('blacklist-null','blacklist','bad',{pattern:'null'}); add('unknown','future','bad');
function reference(){const native=['dimabot/src/utils/moderation/rule_dispatcher.rs','dimabot/src/utils/moderation/caps.rs','dimabot/src/utils/moderation/links_rule.rs','dimabot/src/utils/moderation/emote_spam.rs','dimabot/src/utils/moderation/blacklist.rs','dimabot/src/utils/moderation/normalize.rs','dimabot/src/utils/json_number.rs','dimabot/src/utils/js_string.rs','dimabot/tests/moderation_rule_dispatcher.rs','dimabot/tests/fixtures/moderation_rule_dispatcher_reference.cjs'];return {metadata:{format:1,sourceProvenance:leaf.provenance(path.join(root,'dimabot'),['src/utils/moderation/normalize.ts','src/utils/moderation/rules/links.rule.ts']),pins,compiled,evidence,nodeSha,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},hashes:Object.fromEntries(native.map(p=>[p,sha(read(p))]))},cases};}
if(require.main===module){const [mode,dir,...extra]=process.argv.slice(2);assert.ok(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&!extra.length);const real=fs.realpathSync(dir);assert.ok(real!==root&&!real.startsWith(root+path.sep));const file=path.join(real,'moderation-rule-dispatcher-reference.json');assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(file)]);const output=JSON.stringify(reference(),null,2)+'\n';if(mode==='--write')fs.writeFileSync(file,output,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),output);console.log(JSON.stringify({mode,sha256:sha(output),cases:cases.length}));}
