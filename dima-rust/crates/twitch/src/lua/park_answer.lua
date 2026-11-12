
local held = redis.call('HGET', KEYS[1], 'rotation')
if held == ARGV[2] then return 1 end
if held then
    local generation = tonumber(redis.call('HGET', KEYS[1], 'generation') or '')
    if generation and generation >= tonumber(ARGV[1]) then return 2 end
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'generation', ARGV[1], 'rotation', ARGV[2])
return 0
