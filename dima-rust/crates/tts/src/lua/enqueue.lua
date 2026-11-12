-- DIMA032_ENQUEUE
local session = redis.call('GET', KEYS[3])
local item = cjson.decode(ARGV[1])
item.queueSession = session or cjson.null
redis.call('SET', KEYS[2], cjson.encode(item))
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return session or ''