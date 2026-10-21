// Preserved shared TS implementation is the oracle; never import its worker.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const uri=new URL(process.env.MONGO_URI||'');assert.equal(uri.hostname,'mongo');assert.equal(uri.port,'27017');
assert.match(uri.pathname,/^\/dashboard_activity_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.DRAGONFLY_HOST,'redis');assert.equal(process.env.DRAGONFLY_PORT,'6379');
assert.match(process.argv[2]||'',/^\/tmp\/dashboard-activity-fixture-[0-9]+-[0-9]+\.json$/);
process.env.OBSERVABILITY_DISABLED='true';globalThis.fetch=async()=>{throw new Error('Reference provider fetch forbidden; use seeded cache');};
const require=createRequire('/app/package.json'),mongoose=require('mongoose');mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
let redis;
try{
 await(await import('/app/dist/utils/databases/mongodb.database.js')).getMongoDBConnection('DashboardIsolatedReference');
 redis=await(await import('/app/dist/utils/databases/dragonfly.database.js')).getDragonflyClient('DashboardIsolatedReference');
 const input=JSON.parse(await readFile(process.argv[2],'utf8'));
 const activity=await import('/app/dist/utils/dashboard_activity.js'),insights=await import('/app/dist/utils/dashboard_insights.js');
 let result;
 if(input.mode==='tick')result={projected:await activity.projectDashboardActivityBatch(),activity:await activity.refreshDashboardActivityOnce(),insights:await insights.refreshDashboardInsightsOnce()};
 else if(input.mode==='project')result=await activity.projectDashboardActivityBatch();
 else if(input.mode==='activity')result=await activity.refreshDashboardActivityOnce();
 else if(input.mode==='insights')result=await insights.refreshDashboardInsightsOnce();
 else throw new Error('Unsupported dashboard reference mode');
 console.log('DASHBOARD_REFERENCE:'+JSON.stringify(result));
}finally{await mongoose.disconnect();if(redis?.isOpen)redis.destroy();}
