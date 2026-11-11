
local currentPlanVersion = redis.call('GET', KEYS[5])
if currentPlanVersion and currentPlanVersion > ARGV[5] then return 0 end
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[4], ARGV[1])
if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4]) end
if ARGV[3] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
elseif ARGV[3] == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
