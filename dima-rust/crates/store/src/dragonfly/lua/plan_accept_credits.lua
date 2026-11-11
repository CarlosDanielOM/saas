
local fence = redis.call('GET', KEYS[4])
if fence and fence > ARGV[1] then return 0 end
if ARGV[3] == 'read' then
    if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
else
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
end
if ARGV[4] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
else
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
