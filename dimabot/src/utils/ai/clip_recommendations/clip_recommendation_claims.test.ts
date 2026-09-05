import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CLIP_CLAIM_SCRIPTS } from './clip_recommendation_claims.js';

for (const [action, script] of Object.entries(CLIP_CLAIM_SCRIPTS)) {
    test(`${action} executes its Lua ownership and failure guards with mocked Redis`, (t) => {
        const interpreter = spawnSync('lua', ['-v'], { encoding: 'utf8' });
        if ((interpreter.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            t.skip('Optional standalone Lua interpreter is not installed');
            return;
        }
        const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: `
local owner, processing, destination, dedupe, failPush = 'owner', {'claim'}, {}, true, false
local action = '${action}'
KEYS = action == 'acknowledge' and {'lock', 'processing', 'dedupe'} or {'lock', 'processing', 'destination', 'dedupe'}
ARGV = {'stale-owner', 'claim', 'replacement'}
redis = {}
function redis.call(command, key, a, b)
    if command == 'GET' then assert(key == 'lock'); return owner end
    if command == 'LPOS' then
        assert(key == 'processing')
        for index, value in ipairs(processing) do if value == a then return index - 1 end end
        return false
    end
    if command == 'LREM' then
        assert(key == 'processing' and a == 1)
        for index, value in ipairs(processing) do
            if value == b then table.remove(processing, index); return 1 end
        end
        return 0
    end
    if command == 'DEL' then assert(key == 'dedupe'); dedupe = false; return 1 end
    if command == 'LPUSH' or command == 'RPUSH' then
        assert(key == 'destination')
        if failPush then error('WRONGTYPE') end
        if command == 'LPUSH' then table.insert(destination, 1, a) else table.insert(destination, a) end
        return #destination
    end
    if command == 'RPOPLPUSH' then
        assert(key == 'processing' and a == 'destination')
        if failPush then error('WRONGTYPE') end
        local value = table.remove(processing)
        if value then table.insert(destination, 1, value) end
        return value or false
    end
    error('Unexpected command: ' .. command)
end
function redis.pcall(...)
    local ok, result = pcall(redis.call, ...)
    if ok then return result end
    return {err = result}
end
function redis.error_reply(message) return {err = message} end
local transition = assert(load([==[${script}]==]))
assert(transition() == -1)
assert(#processing == 1 and #destination == 0 and dedupe)
owner = false
ARGV[1] = 'owner'
assert(transition() == -1)
assert(#processing == 1 and #destination == 0 and dedupe)
owner = 'owner'
if action ~= 'acknowledge' then
    failPush = true
    if action == 'recover' then
        local ok, err = pcall(transition)
        assert(not ok and err:match('WRONGTYPE'))
    else
        assert(transition().err:match('WRONGTYPE'))
    end
    assert(#processing == 1 and #destination == 0 and dedupe)
    failPush = false
end
local outcome = transition()
assert(#processing == 0)
if action == 'acknowledge' then
    assert(outcome == 1 and not dedupe and #destination == 0)
elseif action == 'recover' then
    assert(outcome == 'claim' and destination[1] == 'claim' and dedupe)
else
    assert(outcome == 1 and destination[1] == 'replacement')
    assert(dedupe == (action == 'requeue'))
end
local again = transition()
assert(again == 0 or again == false)
assert(#destination == (action == 'acknowledge' and 0 or 1))
` });
        assert.equal(result.status, 0, result.stderr || String(result.error));
    });
}
