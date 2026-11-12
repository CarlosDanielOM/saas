local held = redis.call('HGET', KEYS[1], 'rotation')
if held == ARGV[2] then return 1 end
local generation = tonumber(ARGV[1])
if held then
    local kept = tonumber(redis.call('HGET', KEYS[1], 'generation') or '')
    if kept and kept > generation then return 2 end
    if kept and kept == generation then
        local side = redis.call('HGET', KEYS[2], 'rotation')
        if side == ARGV[2] then return 3 end
        if side then
            local sideGeneration = tonumber(redis.call('HGET', KEYS[2], 'generation') or '')
            if not sideGeneration or sideGeneration >= generation then return 4 end
        end
        redis.call('DEL', KEYS[2])
        redis.call('HSET', KEYS[2], 'generation', ARGV[1], 'rotation', ARGV[2])
        return 3
    end
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'generation', ARGV[1], 'rotation', ARGV[2])
return 0
