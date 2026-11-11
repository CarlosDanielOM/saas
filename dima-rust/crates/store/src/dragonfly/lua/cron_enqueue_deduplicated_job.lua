
if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
if KEYS[3] then
    local accepted = redis.pcall('SET', KEYS[3], '1')
    if type(accepted) == 'table' and accepted.err then
        redis.call('DEL', KEYS[1])
        return redis.error_reply(accepted.err)
    end
end
local pushed = redis.pcall('LPUSH', KEYS[2], ARGV[2])
if type(pushed) == 'table' and pushed.err then
    redis.call('DEL', KEYS[1])
    if KEYS[3] then redis.call('DEL', KEYS[3]) end
    return redis.error_reply(pushed.err)
end
return 1
