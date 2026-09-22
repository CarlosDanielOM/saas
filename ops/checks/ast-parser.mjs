// Runs inside an isolated bot or cron candidate with disposable Mongo/Redis.
import assert from 'node:assert/strict';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AstVariablesSchema } from '/app/dist/schemas/ast_variables.schema.js';
import { parse } from '/app/dist/utils/ast_parser/parser.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';

assert.ok(['bot', 'cron'].includes(process.env.SAAS_TARGET), 'check runs in the affected service');
await getMongoDBConnection('ast-parser-check');
const redis = await getDragonflyClient('ast-parser-check');
await AstVariablesSchema.createIndexes();

const channelID = 'ast-parser-fixture';
await redis.hSet(`accounts:twitch:${channelID}:data`, {
  id: channelID, name: 'astparserfixture', plan_tier: 'premium'
});

const context = {
  channelID,
  scopeType: 'command',
  scopeName: 'scope1',
  userPlan: 'premium',
  eventData: {
    chatter_user_id: 'caller-id',
    chatter_user_login: 'caller',
    chatter_user_name: 'Caller'
  }
};
const render = async (source, overrides = {}) =>
  (await parseSpecialCommands(source, { ...context, ...overrides })).parsedText;

await render('%(**score(alice) 11) %(**score(bob) 22) %(**score 3)');
assert.equal(await render('%(**score(alice)) %(**score(bob)) %(**score)'), '11 22 3');
await render('%del(**score(bob))');
assert.equal(await render('^(**score(alice)) ^(**score(bob))'), 'true false');

await render('%(**legacy 8)', { scopeName: 'oldscope' });
assert.equal(await render('%(**legacy)', { scopeName: 'newscope', scopeAliases: ['oldscope'] }), '8');
await render('%del(**legacy)', { scopeName: 'newscope', scopeAliases: ['oldscope'] });
assert.equal(await render('^(**legacy)', { scopeName: 'newscope', scopeAliases: ['oldscope'] }), 'false');

await render('%(##coins 3) %(##coins(caller) 4) %(##coins(alice) 9)');
assert.equal(await render('%(##coins) %(##coins(alice))'), '4 9');

for (const source of ['$(user', '%(x', '$(user))', '"unterminated', '%[one,two']) {
  assert.ok(parse(source).error, `${source} must report a parse error`);
}
assert.match(await render('before $(user'), /\[Parse error:.*unclosed/i);

await redis.quit();
console.log(`PASS ${process.env.SAAS_TARGET}: selected user storage, persistent deletion, aliases, cache scoping and syntax errors`);
process.exit(0);
