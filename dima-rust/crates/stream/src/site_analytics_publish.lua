if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('HSET', KEYS[3], 'live_users', ARGV[4], 'live', ARGV[4], 'total_live_viewers', ARGV[5])
return 1
