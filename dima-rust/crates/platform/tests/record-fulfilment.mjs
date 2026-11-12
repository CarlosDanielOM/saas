// DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC node <this-file>
// Transpile only these two functions and the inventory schema. No app clients/timers.
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {createRequire} from 'node:module';import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=process.env.DIMABOT_DIR,require=createRequire(path.join(root,'package.json'));
const ts=require('typescript'),mongoose=require('mongoose'),{EJSON}=require('bson');
const now=1794355200000,RealDate=Date;
class FixedDate extends RealDate {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
Object.defineProperty(FixedDate,'name',{value:'Date'});globalThis.Date=FixedDate;
const source=fs.readFileSync(path.join(root,'src/server/services/dimafx-fulfillment.service.ts'),'utf8');
function load(src,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>{if(id!=='mongoose')throw Error(id);return mongoose;},Date:FixedDate,...extra});return exports;}
const db=`dima_test_platform_${randomUUID().replaceAll('-','')}`,steps=[];
try{
 await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:db});
 const {UserExtensionInventorySchema:M}=load(fs.readFileSync(path.join(root,'src/schemas/user_extension_inventory.schema.ts'),'utf8'));
 await M.init();
 const f=load(source.replace(/^import .*;\n/gm,''),{Types:mongoose.Types,UserExtensionInventorySchema:M});
 const seed={_id:new mongoose.Types.ObjectId('000000000000000000000001'),platform:'twitch',channelID:'123',userID:'456',balance:100};
 await M.create(seed);
 const docs=async()=>EJSON.serialize(await M.collection.find({},{promoteValues:false}).sort({_id:1}).toArray(),{relaxed:false});
 const initial=await docs();
 for(const [name,kind,amount,key] of [['refund','refund',12.5,'refund:one'],['refund-repeat','refund',12.5,'refund:one'],['zero','refund',0,'refund:zero'],['negative','refund',-5,'refund:negative'],['save','save',20,'ledger-one'],['save-repeat','save',20,'ledger-one'],['fraction-price','save',0.5,'ledger-two'],['new-refund','refund',1,'refund:two'],['refund-missing','missing-refund',10,'missing'],['save-missing','missing-save',20,'missing']]){
  let error=null;try{if(kind.endsWith('refund'))await f.refundDimafxOnce('123',kind.startsWith('missing')?'absent':'456',amount,key);else await f.saveDimafxPurchaseOnce('123',kind.startsWith('missing')?'absent':'456','000000000000000000000002',amount,key);}catch(e){error=e.message;}
  steps.push({name,kind,amount,key,error,documents:await docs()});
 }
 const singleEffects={};
 for(const kind of ['refund','save']){await M.deleteMany({});await M.create(seed);if(kind==='refund')await f.refundDimafxOnce('123','456',12.5,'refund:one');else await f.saveDimafxPurchaseOnce('123','456','000000000000000000000002',20,'ledger-one');singleEffects[kind]=await docs();}
 fs.writeFileSync(fileURLToPath(new URL('fulfilment-reference.json',import.meta.url)),JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),now,seed:EJSON.serialize(seed,{relaxed:false}),initial,steps,singleEffects},null,2)+'\n');
}finally{if(mongoose.connection.readyState)await mongoose.connection.dropDatabase();await mongoose.disconnect();globalThis.Date=RealDate;}
