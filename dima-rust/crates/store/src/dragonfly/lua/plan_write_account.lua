
local fence = redis.call('GET', KEYS[1])
if fence and fence > ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV, 2))
redis.call('DEL', KEYS[3])
return 1
