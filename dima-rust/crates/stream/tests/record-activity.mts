// Invoked by record.mts --activity <output>. All writes are to one owned scratch DB.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root = process.env.DIMABOT_DIR!;
if (!root || !process.env.DIMA_TEST_MONGO_URI || !process.argv[3]) throw new Error('reference, local test stores and output required');
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON } = require('bson');
const now = 1794355200000, RealDate = Date;
class FixedDate extends RealDate { constructor(...args: any[]) { super(...(args.length ? args : [now]) as [any]); } static now() { return now; } }
const database=`dima_test_stream_${randomUUID().replaceAll('-','')}`;
try {
    await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
    const activity = await import(`${root}/src/utils/stream_activity.ts`);
    const { StreamActivitySchema:A, StreamActivityAggregateSchema:G, StreamActivityStateSchema:S } = await import(`${root}/src/schemas/stream_activity.schema.ts`);
    await Promise.all([A.init(),G.init(),S.init()]);
    globalThis.Date=FixedDate as any;
    const session={_id:new mongoose.Types.ObjectId('0123456789abcdef01234567'),started_at:new RealDate(now-600000)};
    const seedSessions=[{...session,channelID:'channel',stream_id:'stream-test',ended_at:null}];
    await mongoose.connection.db.collection('streamsessions').insertMany(seedSessions);
    const fragments=[{type:'emote',text:'Kappa👋éשם',emote:{id:'25'}},{type:'text',text:'hi'},{type:'emote',text:'other',emote:{id:'25'}}];
    const emotes=activity.extractTimelineEmotes({fragments} as any);
    const steps:any[]=[];
    async function snapshot(name:string, operation:any,result:any) {
        const documents:any={};
        for(const model of [A,G,S]) documents[model.collection.name]=(await model.collection.find({},{promoteValues:false}).sort({_id:1}).toArray()).map((d:any)=>{if(d.owner)d.owner='<owner>';return EJSON.serialize(d,{relaxed:false});});
        const reads={};for(const tier of ['free','premium','pro']) reads[tier]=await activity.getStreamActivity('channel',session._id,tier);
        steps.push({name,operation:EJSON.serialize(operation,{relaxed:false}),result,documents,reads});
    }
    await snapshot('empty-batch',{limit:2},await activity.projectStreamActivityBatch(2));
    const message={channelID:'channel',eventID:'message',kind:'message',session,occurredAt:new RealDate(now-590000),actor:'viewer',actorLabel:'שם👋é',emotes};
    await activity.captureStreamActivity(message as any);await snapshot('first-capture',{capture:message},null);
    await activity.captureStreamActivity(message as any);await snapshot('repeat-capture',{capture:message},null);
    for(const [eventID,kind,offset,value] of [['command','command',10000,1],['late','message',1000,1],['bits','bits',350000,12.5],['raid','raid',400000,30],['gift','gift',450000,5],['follow','follow',460000,1],['sub','sub',470000,1],['redemption','redemption',480000,1]] as any[]) {
        const capture={...message,session:kind==='command'?undefined:session,eventID,kind,occurredAt:new RealDate(+session.started_at+offset),key:'!hello',label:'Hello👋éשם',value,outcome:'error',emotes:kind==='message'?emotes:[]};
        await activity.captureStreamActivity(capture as any);await snapshot(eventID,{capture},null);
    }
    for(let i=0;i<6;i++) await snapshot(`batch-${i}`,{limit:2},await activity.projectStreamActivityBatch(2));
    const invalid={...message,eventID:'expired',occurredAt:new RealDate(now-91*86400000)};
    await activity.captureStreamActivity(invalid as any);await snapshot('expired',{capture:invalid},null);
    await writeFile(process.argv[3],JSON.stringify({now,seedSessions:EJSON.serialize(seedSessions,{relaxed:false}),emotes,fragments,steps},null,2)+'\n');
    console.log(`recorded activity: ${steps.length} steps; ${steps.reduce((n,s)=>n+Object.values(s.documents).reduce((n:number,a:any)=>n+a.length,0),0)} BSON documents`);
} finally {globalThis.Date=RealDate;await mongoose.connection.dropDatabase();await mongoose.disconnect();}
