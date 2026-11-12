
        local now = redis.call('TIME')
        local window = math.floor(tonumber(now[1]) / 60)
        local channel = redis.call('HMGET', KEYS[1], 'window', 'count')
        local global = redis.call('HMGET', KEYS[2], 'window', 'count')
        local channelCount = tonumber(channel[1]) == window and tonumber(channel[2]) or 0
        local globalCount = tonumber(global[1]) == window and tonumber(global[2]) or 0
        if channelCount >= tonumber(ARGV[1]) or globalCount >= tonumber(ARGV[2]) then return 0 end
        redis.call('HSET', KEYS[1], 'window', window, 'count', channelCount + 1)
        redis.call('HSET', KEYS[2], 'window', window, 'count', globalCount + 1)
        redis.call('EXPIRE', KEYS[1], 120)
        redis.call('EXPIRE', KEYS[2], 120)
        return 1
    