// Isolated API check; use fish-fixtures with disposable Redis/Mongo.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { createClient } = createRequire('/app/package.json')('redis');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const root = 'http://127.0.0.1:3000';
const sockets = [];
const wait = async (condition, description) => {
  const deadline = Date.now() + 15000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const connect = async channel => {
  const namespace = `/speech/${channel}`;
  const messages = [];
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  ws.addEventListener('message', event => {
    const data = String(event.data);
    if (data === '2') ws.send('3');
    else if (data.startsWith('0')) ws.send(`40${namespace},{}`);
    else if (data.startsWith(`42${namespace},`)) {
      const [name, payload] = JSON.parse(data.slice(`42${namespace},`.length));
      if (name === 'speech') messages.push(payload);
    }
  });
  await wait(() => redis.exists(`twitch:${channel}:tts:connected`), 'overlay connected');
  return { ws, messages, finish(id) { ws.send(`42${namespace},${JSON.stringify(['speech-ended', { speechID: id }])}`); } };
};
const request = async (channel, text) => {
  const response = await fetch(`${root}/speech/${channel}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({mode:'clone',cloneName:'rias_gremory',text,language:'en'}) });
  return { status: response.status, ...await response.json() };
};
const seed = async channel => {
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'isolated-burst', polar_sh_customer_id: 'fixture', plan_tier: 'premium' });
  await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({version:3, used:0,limit:100000,balance:100000,available:true,status:'available'}));
  const token = `fixture-${channel}`;
  await redis.hSet(`token:${token}`, {id:channel,login:'isolated-burst',display_name:'Test'});
  const response = await fetch(`${root}/speech/settings/${channel}`, {method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,queue:{maxItems:20}})});
  assert.equal(response.status,200,await response.text());
};
const synthesisCount = () => fs.readFileSync('/tmp/saas-fixtures/provider-calls.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(c=>c.synthesis).length;
try {
  const channel = '999981', other = '999982';
  await seed(channel); await seed(other);
  let overlay = await connect(channel);
  const duplicateOverlay = await connect(channel);
  const independent = await connect(other);
  const first = await request(channel, 'First item held during burst');
  assert.equal(first.status,200);
  await wait(()=>overlay.messages.length===1 && duplicateOverlay.messages.length===1,'first speech');
  const before = synthesisCount();
  const burst = await Promise.all(Array.from({length:300},(_,i)=>request(channel,`Burst message ${i}`)));
  const accepted = burst.filter(r=>r.status===200);
  assert.ok(accepted.length > 0);
  assert.ok(burst.every(r => r.status === 200 || r.status === 429));
  assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`),accepted.length);
  assert.equal(synthesisCount(),before,'waiting items are not synthesized before completion');
  const otherSpeech = await request(other,'Another channel remains responsive');
  await wait(()=>independent.messages.length===1,'independent channel');
  independent.finish(otherSpeech.data.speechID);
  await wait(async()=>!await redis.exists(`twitch:${other}:tts:processing`),'independent completion');
  const beforeReconnect = synthesisCount();
  overlay.ws.close();
  await new Promise(resolve=>overlay.ws.addEventListener('close',resolve,{once:true}));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await redis.get(`twitch:${channel}:tts:processing`),first.data.speechID,'one disconnected overlay cannot interrupt another connected overlay');
  duplicateOverlay.ws.close();
  await new Promise(resolve=>duplicateOverlay.ws.addEventListener('close',resolve,{once:true}));
  await wait(async()=>!await redis.exists(`twitch:${channel}:tts:processing`),'disconnect skips interrupted item');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(synthesisCount(),beforeReconnect,'disconnected channel does not consume its backlog');
  assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`),accepted.length);
  const expectedOrder = await redis.zRange(`twitch:${channel}:tts:queue`,0,-1);
  overlay = await connect(channel);
  const ordered = expectedOrder.map(id=>accepted.find(r=>r.data.speechID===id));
  for(let i=0;i<ordered.length;i++) {
    await wait(()=>overlay.messages.length>i,`delivery ${i}`);
    assert.equal(overlay.messages[i].speechID,ordered[i].data.speechID,'strict acceptance order');
    const audio = await fetch(root+new URL(overlay.messages[i].audioUrl,root).pathname);
    assert.equal(audio.status,200);
    assert.ok((await audio.arrayBuffer()).byteLength>100);
    overlay.finish(ordered[i].data.speechID);
    overlay.finish(ordered[i].data.speechID);
  }
  await wait(async()=>!await redis.exists(`twitch:${channel}:tts:processing`),'burst drains');
  assert.equal(overlay.messages.length,accepted.length);
  assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`),0);
  assert.equal((await redis.keys(`twitch:${channel}:tts:queue:data:*`)).length,0);
  console.log(`PASS: 300 concurrent requests; ${accepted.length + 1} accepted under soft cap; sequential draining, duplicate acknowledgements, disconnect skip/pause/resume, independent channel`);
} finally {
  for(const ws of sockets) ws.close();
  await redis.quit();
}
