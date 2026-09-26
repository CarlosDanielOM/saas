// Isolated saas-ops candidate; provider effects captured by ast-timer-fixtures.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { ChannelModerationSettingsSchema } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { messageHandler } from '/app/dist/handlers/message.handler.js';
import { sendTwitchChatMessage } from '/app/dist/functions/chats/send_message.chat.js';
import { deliverAstMessage } from '/app/dist/utils/ast_command_delivery.js';
import { renderTimerMessage } from '/app/dist/utils/timer_runtime.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';
import { parse } from '/app/dist/utils/ast_parser/parser.js';
import { createExecutionContext, evaluate } from '/app/dist/utils/ast_parser/evaluator.js';
import { AstTimerScheduler, AST_TIMER_INDEX } from '/app/dist/utils/ast_timer_runtime.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
  assert.fail(label);
}
const mongo = await getMongoDBConnection('ast-reference-check');
const redis = await getDragonflyClient('ast-reference-check');
const channelID = '998801';
const event = {
  chatter_user_id: 'viewer-id', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
  badges: [], message_id: 'fixture', message: { text: '', fragments: [] }
};
let scheduler;
if (process.env.SAAS_TARGET === 'bot') {
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:3333/eventsub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).status === 403; } catch { return false; }
  }, 'normal bot entrypoint must become ready');
} else {
  scheduler = new AstTimerScheduler(redis);
  await scheduler.start();
}
await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'referencefixture', plan_tier: 'pro' });
await redis.set('app:twitch:token', 'dummy-app', { EX: 3600 });
await ChannelModerationSettingsSchema.create({ channelID, channel: 'referencefixture', enabled: false });
const definitions = {
  discord: 'Discord: https://discord.example/invite',
  socials: 'Join us on: #(discord)',
  only: '#(discord)',
  self: 'Once #(self)',
  a: 'A #(b)', b: 'B #(a)',
  siblings: 'Root #(branch) #(branch)', branch: 'Branch #(discord)',
  echo: 'You said: &t', literal: '#(echo &t)',
  action: '$(chat.send action) Action done', actionroot: 'Root #(action)',
  counter: 'Count $(scount)', countroot: 'Root #(counter)',
  limited: 'Limited', limitroot: 'Root #(limited)',
  disabled: 'Never', skip: 'Root #(missing) #(disabled)',
  delayed: 'Scheduled $(timer 1 Delay done #(discord))',
  timerloop: 'Tick $(timer 1 #(timerloop))',
  restricted: 'Restricted',
  ...Object.fromEntries(Array.from({length:8},(_,i)=>[`c${i}`,`C${i} #(c${i+1})`]))
};
for (const [cmd, message] of Object.entries(definitions)) {
  await CommandsSchema.create({ channelID, channel: 'referencefixture', cmd, name: cmd, func: 'custom', message,
    cooldown: cmd === 'limited' ? 2 : 0, enabled: cmd !== 'disabled', userLevel: cmd === 'restricted' ? 7 : 1 });
}
const effectsKey = 'test:ast-timer:effects';
const messages = async () => (await redis.lRange(effectsKey,0,-1)).map(JSON.parse)
  .filter(effect => effect.kind === 'chat').map(effect => effect.body.message);
const clear = () => redis.del(effectsKey);
let messageSequence=0;
async function chat(text) {
  await messageHandler(channelID,{...event,message_id:`fixture-${++messageSequence}`,message:{text,fragments:[]}});
}

await chat('!socials');
assert.deepEqual(await messages(), ['Join us on:', 'Discord: https://discord.example/invite']);
await clear(); await chat('!only');
assert.deepEqual(await messages(), ['Discord: https://discord.example/invite']);
await clear(); await chat('!self');
assert.deepEqual(await messages(), ['Once']);
await clear(); await chat('!a');
assert.deepEqual(await messages(), ['A','B']);
await clear(); await chat('!siblings');
assert.deepEqual(await messages(), ['Root','Branch','Discord: https://discord.example/invite','Branch','Discord: https://discord.example/invite']);
await clear(); await chat('!c0');
assert.deepEqual(await messages(), ['C0','C1','C2','C3','C4','C5']);
await clear(); await chat('!literal $(chat.send injected)');
assert.deepEqual(await messages(), ['You said: $(chat.send injected)']);
await clear(); await chat('!actionroot');
assert.deepEqual(await messages(), ['Root','action','Action done']);
await clear(); await chat('!countroot');
assert.deepEqual(await messages(), ['Root','Count 1']);
assert.equal((await CommandsSchema.findOne({channelID,cmd:'counter'})).count,1);
await clear(); await chat('!skip');
assert.deepEqual(await messages(), ['Root']);

// The same cooldown applies regardless of which entrypoint invoked the command.
await clear(); await chat('!limitroot'); await chat('!limited');
assert.deepEqual(await messages(), ['Root','Limited']);
await sleep(2100); await clear(); await chat('!limited'); await chat('!limitroot');
assert.deepEqual(await messages(), ['Limited','Root']);

await clear();
await sendTwitchChatMessage(channelID,'Reward: #(discord)',null,{channelID,eventData:event});
assert.deepEqual(await messages(), ['Reward: ','Discord: https://discord.example/invite']);
await clear();
const timer = await renderTimerMessage({channelID,streamerName:'referencefixture',timerName:'socials',
  message:'Reminder: #(discord)',planTier:'pro',parse:parseSpecialCommands});
await deliverAstMessage(channelID,timer);
assert.deepEqual(await messages(), ['Reminder:','Discord: https://discord.example/invite']);

await clear();
const untrusted=createExecutionContext({broadcasterId:channelID,userLevel:1,
  authorization:{origin:'llm',identity:{level:1,tags:[]}}});
await evaluate(parse('#(restricted)').ast,untrusted);
await deliverAstMessage(channelID,{parsedText:'',commandReferences:untrusted.commandReferences});
assert.deepEqual(await messages(),[]);

await clear(); await chat('!delayed');
assert.deepEqual(await messages(), ['Scheduled']);
await until(async()=> (await messages()).length===3,'timer must send body then referenced command');
assert.deepEqual(await messages(), ['Scheduled','Delay done','Discord: https://discord.example/invite']);
await clear(); await chat('!timerloop');
assert.deepEqual(await messages(), ['Tick']);
assert.equal(await redis.zCard(AST_TIMER_INDEX),1);
await until(async()=>await redis.zCard(AST_TIMER_INDEX)===0,'timer must finish without rescheduling a recursive command');
await sleep(2200);
assert.deepEqual(await messages(), ['Tick']);
assert.equal(await redis.zCard(AST_TIMER_INDEX),0);

scheduler?.stop();
await mongo.connection.close();
await redis.quit();
console.log(`PASS ${process.env.SAAS_TARGET}: real chat dispatch, separate ordered responses, cycles/depth, siblings, literal text, actions/counters, cooldowns, events, recurring timers, delayed references and permissions`);
process.exit(0);
