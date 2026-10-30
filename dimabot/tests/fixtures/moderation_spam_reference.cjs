'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const lib=require('./moderation_spam_source.cjs');lib.independent('DIMA_SPAM_READER_SHA256',__filename);
const {encode,realm,capture,captureAsync}=lib;
function matrix(){
 const api=realm().api,cases=[];
 const add=(name,id,args)=>cases.push({id,export:name,args:encode(args),result:capture(()=>api[name](...args))});
 const ctx=(message,isBroadcaster=true)=>[{message,isBroadcaster,messageID:'prior',username:'broadcaster',timestamp:1700000000000}];
 const positive=['share channel','Please share your channel links!','POST Twitch link','drop social links here','comparte canal','compartan sus canales','compartid vuestros enlaces','publica tu canal','publiquen redes','deja tus enlaces','dejen su canal'];
 const negative=["don't share channel",'dont post twitch','do not drop social','never share channel','stop share channel','no share channel','not share channel','prohibido comparte canal','prohibida comparte canal','nunca comparte canal','reshare channel','share channels','shareyour channel','comparte canalesx','share your own channel','share-channel','do\tnot share channel'];
 const unicode=['ſhare channel','ſhare\u00a0channel','share\ufeffyour\u2028channel','share\nchannel','share\r\nchannel','share\u0085channel','share\u180echannel','share\u200bchannel','Kshare channel','éshare channel','_share channel','😀share channel','\ud800share channel','share channel\udc00','share channeℓ','share channel\u0301','NO\u0301 share channel','don’t share channel','do\nnot share channel'];
 for(const [i,text] of [...positive,...negative,...unicode].entries()){add('broadcasterInvitedPromotion',`invite-${i}`,[ctx(text)]);add('broadcasterInvitedPromotion',`unverified-${i}`,[ctx(text,false)]);}
 add('broadcasterInvitedPromotion','empty-context',[[]]);add('broadcasterInvitedPromotion','one-negative-one-positive',[[...ctx('no share channel'),...ctx('post social')]]);
 // Test .some short-circuit and a sparse context without replacing source logic.
 const sparse=new Array(3);sparse[2]=ctx('share channel')[0];add('broadcasterInvitedPromotion','sparse-context',[sparse]);
 for(const flag of [undefined,null,false,0,'true',true])add('broadcasterInvitedPromotion',`verified-${typeof flag}-${String(flag)}`,[[{message:'share channel',isBroadcaster:flag}]]);
 const protections=[undefined,null,{}, {enabled:false},{enabled:true,reviewAllMessages:true},{enabled:null,reviewAllMessages:1},{enabled:0,reviewAllMessages:'true'},{categories:[]},{categories:['unknown','ads','ads']},{categories:null,exemptTags:null},{categories:'😀x',exemptTags:'vip'},{exemptTags:[]},{exemptTags:['vip','unknown','mod']},{thresholdPercent:0},{thresholdPercent:-0},{thresholdPercent:NaN},{thresholdPercent:Infinity},{thresholdPercent:-Infinity},{thresholdPercent:85.125},{thresholdPercent:null}];
 for(const [i,p] of protections.entries()){
  const settings={spamProtection:p};add('spamProtectionSettings',`settings-${i}`,[settings]);
  for(const invited of [false,true])add('spamRuleForContext',`rule-${i}-${invited}`,[ctx(invited?'share channel':'ordinary chat'),settings]);
  for(const first of [false,true])for(const tier of [undefined,null,'free','premium','pro','Premium',1])add('spamReviewSource',`review-${i}-${first}-${String(tier)}`,[first,settings,tier]);
 }
 for(const [i,c] of ['', 'chan', '😀\ud800\udc00', 'é\u0301', '"\\\n'].entries())add('defaultSpamModerationSettings',`defaults-${i}`,[c]);
 const decisions=[];
 for(const ruleID of [lib.exportsExpected.includes('SPAM_RULE_ID')?api.SPAM_RULE_ID:'', 'custom',''])for(const reviewSource of [undefined,null,'first_message','spam_continuous','rule','FIRST_MESSAGE'])for(const settingsVersion of [0,1,-0,NaN,Infinity])decisions.push({ruleID,reviewSource,settingsVersion});
 for(const [i,d] of decisions.entries()){
  add('isSpamDecision',`decision-${i}`,[d]);
  const settings=[undefined,null,{settingsVersion:0,enabled:false,rules:[]},{settingsVersion:1,enabled:true,rules:[{id:'custom',enabled:true}]},{settingsVersion:NaN,enabled:true,rules:[{id:'custom',enabled:true}]},{settingsVersion:0,spamProtection:{reviewAllMessages:true,categories:['unknown']}},{settingsVersion:0,spamProtection:{enabled:false}},{settingsVersion:0,spamProtection:{categories:[]}}];
  settings.forEach((s,j)=>add('semanticPolicyActive',`policy-${i}-${j}`,[s,d]));
 }
 for(const [i,args] of [['a','b'],['b','a'],['ab','c'],['a','bc'],['',''],['😀','\ud800'],['\udc00','😀'],['"\\\n','\u0000'],['é','e\u0301']].entries())add('chatterMarkerID',`marker-${i}`,args);
 return cases;
}
function identity(){const {api}=realm(),a=api.spamRuleForContext([]),b=api.spamRuleForContext([]),p=api.spamProtectionSettings({}),q=api.spamProtectionSettings({}),d=api.defaultSpamModerationSettings('a'),e=api.defaultSpamModerationSettings('a');
 return {ruleFresh:a!==b,semanticFresh:a.semantic!==b.semantic,categoriesFresh:a.semantic.categories!==b.semantic.categories,offenseShared:a.firstOffense===b.firstOffense,termsShared:a.terms===b.terms,allowlistShared:a.allowlistDomains===b.allowlistDomains,examplesShared:a.semantic.examples===b.semantic.examples,exemptFresh:a.exemptExpression!==b.exemptExpression,protectionFresh:p!==q,protectionCategoriesFresh:p.categories!==q.categories,protectionTagsFresh:p.exemptTags!==q.exemptTags,defaultsFresh:d!==e,defaultDatesFresh:d.createdAt!==e.createdAt,defaultRulesFresh:d.rules!==e.rules};}
function makeError(config){if(config&&config.kind==='plain')return config.value;const e=new Error(config?.message||'fixture storage failure');if(config?.code!==undefined)e.code=config.code;return e;}
async function claims(){const observations=[];
 const markerCases=[['insert',{upsertedCount:1}],['existing',{upsertedCount:0}],['string-count',{upsertedCount:'1'}],['cache-hit',{get:'1'}],['empty-cache',{get:''}],['zero-cache',{get:0}],['false-cache',{get:false}],['null-cache',{get:null}],['object-cache',{get:{}}],['duplicate',{mongoError:{code:11000}}],['string-code',{mongoError:{code:'11000'}}],['mongo-error',{mongoError:{code:123,message:'mongo failed'}}],['get-error',{getError:{message:'get failed'}}],['acquire-error',{acquireError:{message:'acquire failed'}}],['set-error',{setError:{message:'set failed'}}]];
 const budgetCases=[...[[1],[0],[-1],[1.5],['1'],[' 1 '],['1.0'],['0x1'],['1e0'],[''],[null],[undefined],[true],[false],['NaN'],[NaN],[Infinity],[[]],[[1]],[{}]].map(([value],i)=>[`budget-value-${i}`,{eval:value}]),['budget-eval-error',{evalError:{message:'eval failed'}}],['budget-acquire-error',{acquireError:{message:'acquire failed'}}]];
 for(const [name,configs] of [['claimFirstObservedMessage',markerCases],['claimSpamReviewBudget',budgetCases]])for(const [id,config] of configs){const calls=[];
  const hooks={model:{updateOne:async(...args)=>{calls.push(['updateOne',...args]);if(config.mongoError)throw makeError(config.mongoError);return {upsertedCount:config.upsertedCount??1};}},acquire:async scope=>{calls.push(['getDragonflyClient',scope]);if(config.acquireError)throw makeError(config.acquireError);return {get:async(...args)=>{calls.push(['get',...args]);if(config.getError)throw makeError(config.getError);return config.get;},set:async(...args)=>{calls.push(['set',...args]);if(config.setError)throw makeError(config.setError);return 'OK';},eval:async(...args)=>{calls.push(['eval',...args]);if(config.evalError)throw makeError(config.evalError);return config.eval;}};}};
  const api=realm({hooks}).api,args=name==='claimFirstObservedMessage'?['channel😀','user\ud800']:['channel😀'];const result=await captureAsync(()=>api[name](...args));observations.push({id,export:name,args:encode(args),config:encode(config),result,calls:encode(calls)});
 }
 assert.equal(new Set(observations.map(c=>c.export+':'+c.id)).size,observations.length,'duplicate claim case IDs');
 return observations;
}
(async()=>{
 const first=realm(),vm=realm({kind:'vm'}),cases=matrix();
 assert.equal(new Set(cases.map(c=>c.id)).size,cases.length,'duplicate pure case IDs');
 // Correctness crosscheck through the normal CommonJS and VM loaders.
 for(const c of cases){const args=lib.decode(c.args);assert.deepEqual(capture(()=>vm.api[c.export](...args)),c.result,c.id);}
 const schemaDoc=new first.settings.ChannelModerationSettingsSchema({_id:'000000000000000000000001',channelID:'fixture'});
 const chatterDoc=new first.chatter.ModerationChatter({_id:'marker',firstSeenAt:new Date(lib.FIXED_MS)});
 const reference={metadata:{format:1,nodeSha256:lib.nodeSha,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:'5.9.3',mongoose:'8.24.2'},pins:lib.pins,compiled:lib.compiled,evidence:lib.evidence,loaderSha256:lib.sha(fs.readFileSync(require.resolve('./moderation_spam_source.cjs'))),readerSha256:lib.sha(fs.readFileSync(__filename)),sdk:lib.sdk(),mongooseFiles:lib.mongooseFiles,re2Runtime:lib.re2Runtime,runtimeExports:lib.exportsExpected,typeExports:[],caseCount:cases.length,fixedClockMilliseconds:lib.FIXED_MS,boundary:'Own enumerable JSON-like values, tagged undefined, holes, Dates, binary64 bits and lossless UTF-16. No accessors, symbols, proxies, functions, BigInt or cycles. Real disconnected Mongoose schemas/default constructors. Only ORM updateOne, Redis acquisition/commands and Date clock are application test seams. No real I/O.'},constants:encode({SPAM_RULE_ID:first.api.SPAM_RULE_ID,SPAM_CHANNEL_REVIEWS_PER_MINUTE:first.api.SPAM_CHANNEL_REVIEWS_PER_MINUTE,SPAM_GLOBAL_REVIEWS_PER_MINUTE:first.api.SPAM_GLOBAL_REVIEWS_PER_MINUTE,spamRule:first.api.spamRule}),schemaEvidence:{readyState:first.instance.connection.readyState,settingsCollection:first.settings.ChannelModerationSettingsSchema.collection.name,chatterCollection:first.chatter.ModerationChatter.collection.name,settingsPaths:Object.keys(first.settings.ChannelModerationSettingsSchema.schema.paths),chatterPaths:Object.keys(first.chatter.ModerationChatter.schema.paths),settingsDefaults:encode({...schemaDoc.toObject({versionKey:false}),_id:String(schemaDoc._id)}),chatterDocument:encode(chatterDoc.toObject({versionKey:false}))},identity:identity(),cases,claims:await claims()};
 const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&extra.length===0);const real=lib.external(dir),name='moderation-spam-reference.json';assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[name]);const bytes=JSON.stringify(reference,null,2)+'\n';if(mode==='--write')fs.writeFileSync(path.join(real,name),bytes,{flag:'wx'});else assert.equal(fs.readFileSync(path.join(real,name),'utf8'),bytes);console.log(JSON.stringify({mode,sha256:lib.sha(bytes),cases:cases.length,claims:reference.claims.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
