
local fence = redis.call('GET', KEYS[1])
if fence and fence > ARGV[1] then return 0 end
local held = tonumber(redis.call('HGET', KEYS[2], '__credential_generation') or '')
if held and held > tonumber(ARGV[2]) then
    local kept = redis.call('HMGET', KEYS[2], 'refresh_token', 'access_token', 'expires_at', 'has_permissions', 'up_to_date_permissions')
    redis.call('HSET', KEYS[2], unpack(ARGV, 3))
    local function restore(index, name)
        if kept[index] then
            redis.call('HSET', KEYS[2], name, kept[index])
        else
            redis.call('HDEL', KEYS[2], name)
        end
    end
    restore(1, 'refresh_token')
    restore(2, 'access_token')
    restore(3, 'expires_at')
    restore(4, 'has_permissions')
    restore(5, 'up_to_date_permissions')
    redis.call('DEL', KEYS[3])
    return 2
end
redis.call('HSET', KEYS[2], unpack(ARGV, 3))
redis.call('HSET', KEYS[2], '__credential_generation', ARGV[2])
redis.call('DEL', KEYS[3])
return 1
