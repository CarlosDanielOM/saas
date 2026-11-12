
local held = tonumber(redis.call('HGET', KEYS[1], '__credential_generation') or '')
if held and held > tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('HSET', KEYS[1], '__credential_generation', ARGV[1])
return 1
