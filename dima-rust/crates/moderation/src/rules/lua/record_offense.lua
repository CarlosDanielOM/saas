
            local previous = redis.call('GET', KEYS[2])
            if previous then return tonumber(previous) end
            local count = redis.call('INCR', KEYS[1])
            if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
            redis.call('SET', KEYS[2], count, 'EX', 86400)
            return count
        