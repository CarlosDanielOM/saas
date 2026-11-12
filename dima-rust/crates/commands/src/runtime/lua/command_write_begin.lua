-- A write to a channel's commands is about to reach MongoDB: registers the writer's lease
-- (pruning expired ones), moves the revision (loads that started before cannot publish) and
-- marks the named entries stale ('' = read MongoDB), or drops the whole snapshot when no name
-- is given. Field 'b' (bytes of the entries) follows.
-- KEYS as command_fill_channel.lua
-- ARGV[1] writer token  ARGV[2] now (epoch ms)  ARGV[3] lease end (epoch ms)
-- ARGV[4] lifetime of the writer set (ms)  ARGV[5..] fields (c:{name}); none drops the snapshot
redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[2])
redis.call('zadd', KEYS[3], ARGV[3], ARGV[1])
redis.call('pexpire', KEYS[3], ARGV[4])
redis.call('incr', KEYS[2])
if #ARGV < 5 then
  redis.call('del', KEYS[1])
elseif redis.call('exists', KEYS[1]) == 1 then
  local bytes = tonumber(redis.call('hget', KEYS[1], 'b')) or 0
  for i = 5, #ARGV do
    bytes = bytes - redis.call('hstrlen', KEYS[1], ARGV[i])
    redis.call('hset', KEYS[1], ARGV[i], '')
  end
  redis.call('hset', KEYS[1], 'b', tostring(bytes))
end
return 1
