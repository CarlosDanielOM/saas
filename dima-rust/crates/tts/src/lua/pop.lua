-- DIMA032_POP
local next = redis.call('ZRANGE', KEYS[1], 0, 0)
if #next == 0 then return {} end
if next[1] ~= ARGV[1] then return {'retry'} end
local payload = redis.call('GET', KEYS[3]) or ''
local session = redis.call('GET', KEYS[2]) or ''
redis.call('ZREM', KEYS[1], next[1])
return {next[1], payload, session}