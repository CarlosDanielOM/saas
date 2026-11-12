// Run: DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC node <this-file>
// Only transpile the service after removing imports/types: never load admin middleware,
// schemas, dev.ts or their database clients/timers. Inject only their actual dependencies.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.env.DIMABOT_DIR;
const require=createRequire(path.join(root,'package.json'));
const ts=require('typescript');
const source=fs.readFileSync(path.join(root,'src/server/services/media_library.service.ts'),'utf8');
const stripped=source.replace(/^import .*;\n/gm,'');
const js=ts.transpileModule(stripped,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mongoose=require('mongoose');
const exports={};
const dbModels={};
vm.runInNewContext(js,{exports,path,Date:class extends Date{static now(){return 1794355200000;}},randomBytes:n=>Buffer.alloc(n,0xab),getApiUrl:()=> 'https://api.domdimabot.com',UserMediaLibraryItemSchema:{aggregate:(p)=>dbModels.library.aggregate(p)},AdminSchema:{findOne:(p)=>dbModels.admin.findOne(p)},hasGlobalChannelOwnerAccess:async(id)=>id==='global'});
const rows=[];
function record(fn,...args){rows.push({fn,args,result:exports[fn](...args)});}
const names=['','A','a_b','a__b','a_','1a','_a','abc123','José','e\u0301','😀','مرحبا','../x','a/b','a\\b','A'.repeat(79),'A'.repeat(80),'A'.repeat(81),'A'.repeat(10000),'a\n'];
for(const name of names){record('isValidMediaDisplayName',name);record('buildMediaAssetSearchPattern',name);}
for(const s of ['mejor país de chile','cdom.*','.*+?^${}()|[]\\','(a+)+$','a a a a a !',' a__b\t c ','a'.repeat(79)+'😀','x'.repeat(10000),'Ångström','\ufeff É _ Ñ'])record('buildMediaAssetSearchPattern',s);
for(const tier of [null,'','free','premium','pro','PRO']){record('normalizePlanTier',tier);if(['free','premium','pro'].includes(tier)){record('getPlanUploadLimitBytes',tier);record('getPlanStorageQuotaBytes',tier);for(const scope of [null,'public','private','system'])record('getDefaultMediaScope',tier,scope);}}
for(const scope of ['private','public','system']){record('getInitialMarketplaceStatus',scope);for(const n of [-1,0,0.5,1000000000])record('getMediaQuotaChargeBytes',scope,n);for(const type of ['gif','image','audio','video'])for(const file of ['abcd-A-1794355200000.mp4','a.b.c','../x','a/b','a\\b','..'])record('buildMediaS3Key',scope,type,'123',file);}
for(const mime of ['image/gif','IMAGE/GIF','image/gif; charset=utf8','video/mp4','audio/mpeg','audio/x-wav','audio/mp4','image/jpeg','image/svg+xml','video/quicktime','application/octet-stream','','audio/']){record('inferMediaTypeFromMimeType',mime);for(const file of ['x.JPEG','x.a.b','../x','a/b.mp4','a\\b.MP3','.hidden','..','a.','/x.mp4/',''])record('getFileExtension',file,mime);}
for(const name of ['A','A_b','A'.repeat(79),'A'.repeat(80),'A'.repeat(81),'','José','😀','../x','A'.repeat(10000)])for(const ext of ['mp4','jpg','x.y'])record('buildStoredMediaFileName',name,ext);
record('buildMediaPlaybackUrl','0123456789abcdef01234567');
const database=`dima_test_platform_${require('crypto').randomUUID().replaceAll('-','')}`;
let storeRecording;
try {
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
 // Schema-only modules import mongoose, no application clients or timers.
 for(const [key,file,name] of [['library','user_media_library_item','UserMediaLibraryItemSchema'],['admin','admin','AdminSchema']]) {
  const src=fs.readFileSync(path.join(root,`src/schemas/${file}.schema.ts`),'utf8');
  const out={};const code=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports:out,require:(id)=>{if(id!=='mongoose')throw Error(id);return mongoose;},Date});dbModels[key]=out[name];
 }
 // Await every auto-create/index task before cleanup: otherwise one may recreate the
 // empty collection after dropDatabase has acknowledged.
 await Promise.all(Object.values(dbModels).map(model=>model.init()));
 const seeds=[];
 for(const [channel,scope,active,deleted,bytes] of [['123','private',true,null,12.5],['123','private',true,null,7],['123','public',true,null,999],['123','private',false,null,999],['123','private',true,new Date(0),999],['other','private',true,null,999]]) {
  const seed={channelID:channel,channelName:'test',addedByUserID:'123',assetID:new mongoose.Types.ObjectId(),relationType:'owner_upload',quotaBytesCharged:bytes,assetScope:scope,mediaType:'video',isActive:active,deletedAt:deleted};
  await dbModels.library.create(seed);seeds.push(require('bson').EJSON.serialize(seed));
 }
 const adminSeeds=[];
 for(const [id,active,permissions] of [['editor',true,['triggers:edit']],['wild',true,['*']],['all',true,['triggers:all']],['inactive',false,['*']],['other',true,['foo']]]) {
  const seed={channelID:'123',adminID:id,actived:active,permissions};await dbModels.admin.create(seed);adminSeeds.push(seed);
 }
 storeRecording={seeds,adminSeeds,quotas:[],permissions:[]};
 for(const channel of ['123','other','absent']) storeRecording.quotas.push({channel,result:await exports.getChannelQuotaUsageBytes(channel)});
 for(const requester of ['123','global','editor','wild','all','inactive','other','absent'])for(const required of [[],['triggers:edit'],['foo']])storeRecording.permissions.push({requester,required,result:await exports.hasTriggerPermission(requester,'123',required)});
} finally { if(mongoose.connection.readyState){await mongoose.connection.dropDatabase();}await mongoose.disconnect(); }
fs.writeFileSync(fileURLToPath(new URL('media-library-reference.json',import.meta.url)),JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),rows,storeRecording},null,2)+'\n');
