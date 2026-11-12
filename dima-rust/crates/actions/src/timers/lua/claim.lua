
local raw = redis.call('GET', KEYS[1])
if not raw then redis.call('ZREM', KEYS[2], ARGV[1]); return nil end
local job = cjson.decode(raw)
if job.dueAt > tonumber(ARGV[2]) then return nil end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if job.expiresAt <= tonumber(ARGV[2]) then return nil end
return raw