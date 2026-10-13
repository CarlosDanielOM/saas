import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { MongoClient } from 'mongodb';
import { createChannelNames } from '../src/channel-names.mjs';

test('public names are cached briefly, refresh after a rename, and fail gracefully',async()=>{
  let time=0,name='original_name',calls=0,fail=false;
  const redis={multi(){const ids=[];return {hGet(key,field){assert.equal(field,'name');ids.push(key);return this;},async exec(){calls++;if(fail)throw Error('unavailable');return ids.map(()=>name);}};}};
  const names=createChannelNames({redis,now:()=>time});
  assert.deepEqual(await names.resolve(['123','123','bad:key']),{'123':'original_name'});
  name='renamed_streamer';assert.deepEqual(await names.resolve(['123']),{'123':'original_name'});assert.equal(calls,1);
  time=61000;assert.deepEqual(await names.resolve(['123']),{'123':'renamed_streamer'});
  time=122000;fail=true;assert.deepEqual(await names.resolve(['123']),{'123':null});
  fail=false;name='not a valid username';time=138000;assert.deepEqual(await names.resolve(['123']),{'123':null});await names.close();
});
test('each response bounds directory lookups to 500 authorized IDs',async()=>{
  let fetched=0;
  const redis={multi(){let count=0;return {hGet(){count++;return this;},async exec(){assert(count<=50);fetched+=count;return Array(count).fill('streamer');}};}};
  const names=createChannelNames({redis});const result=await names.resolve(Array.from({length:1200},(_,i)=>String(i)));assert.equal(Object.keys(result).length,500);assert.equal(fetched,500);await names.close();
});
test('real account directory fallback returns Twitch names without private account data',{skip:!process.env.ANALYTICS_TEST||!process.env.MONGO_METRICS_URI},async()=>{
  assert.match(process.env.MONGO_METRICS_URI,/analytics_accounts_test/);
  const mongo=new MongoClient(process.env.MONGO_METRICS_URI),redis=createClient({url:process.env.REDIS_URL});redis.on('error',()=>{});await mongo.connect();await redis.connect();
  const names=createChannelNames({redis,mongoUrl:process.env.MONGO_METRICS_URI});
  try{
    await mongo.db().collection('users').insertOne({accounts:[{type:'twitch',id:'701',name:'mongo_streamer',email:'private@example.invalid',access_token:'secret-token'},{type:'youtube',id:'702',name:'other_platform'}]});
    await redis.hSet('accounts:twitch:700:data',{name:'cached_streamer',email:'private@example.invalid',access_token:'secret-token'});
    assert.deepEqual(await names.resolve(['700','701','702','703']),{'700':'cached_streamer','701':'mongo_streamer','702':null,'703':null});
  }finally{await names.close();await mongo.close();await redis.quit();}
});
