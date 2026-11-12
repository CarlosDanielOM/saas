if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[3], 'registered_users', ARGV[4], 'live_users', ARGV[5], 'total_live_viewers', ARGV[6], 'authorized_accounts', ARGV[7], 'total_messages', ARGV[8], 'total_commands', ARGV[9], 'registered', ARGV[4], 'live', ARGV[5], 'active', ARGV[7])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
