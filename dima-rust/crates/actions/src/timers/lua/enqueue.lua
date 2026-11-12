
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5] - ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[5])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) or redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[8]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
redis.call('PEXPIREAT', KEYS[3], redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')[2])
return 1