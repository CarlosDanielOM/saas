
local previous = redis.call('GET', KEYS[1])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
