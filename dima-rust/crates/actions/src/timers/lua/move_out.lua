-- Takes one pending AST timer out of a database, whatever its due time (P4-ACT-CORE's one-off
-- carry step at the cutover; no TypeScript counterpart).
-- KEYS[1] ast:timers:job:{id}  KEYS[2] ast:timers:pending  KEYS[3] ast:timers:channel:{channel}
-- ARGV[1] the job id
-- Returns the job's payload, or nil when it was gone. No loop.
local raw = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return raw
