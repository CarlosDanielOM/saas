
local found = redis.call('LPOS', KEYS[1], ARGV[1], 'MAXLEN', ARGV[2])
if not found then redis.call('LPUSH', KEYS[1], ARGV[1]) end
if KEYS[2] then redis.call('SET', KEYS[2], '1') end
if found then return 0 else return 1 end
