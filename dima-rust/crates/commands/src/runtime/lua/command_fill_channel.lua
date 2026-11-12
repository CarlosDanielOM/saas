-- Publishes a channel's snapshot loaded from MongoDB, only while the revision read before the
-- load is still current and no writer holds a live lease (a write in flight or one that may
-- have committed without finishing).
-- KEYS[1] commands:snapshot:{channel}  KEYS[2] commands:revision:{channel}
-- KEYS[3] commands:writers:{channel} (sorted set: writer token -> lease end, epoch ms)
-- ARGV[1] revision read before the load  ARGV[2] now (epoch ms)  ARGV[3] lifetime (ms)
-- ARGV[4] mode ('c' complete, 'p' partial)  ARGV[5] bytes of the entries
-- ARGV[6..] field, value pairs (c:{name}, BSON)
-- Returns 1 when written, 0 when refused.
if (redis.call('get', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[2])
if redis.call('zcard', KEYS[3]) > 0 then return 0 end
redis.call('del', KEYS[1])
redis.call('hset', KEYS[1], 'v', ARGV[4], 'b', unpack(ARGV, 5))
redis.call('pexpire', KEYS[1], ARGV[3])
return 1
