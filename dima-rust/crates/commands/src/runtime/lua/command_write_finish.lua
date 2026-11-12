-- The write is done (or failed): moves the revision again and marks the same entries stale once
-- more (needed when the write outlived its lease: a load may have published what MongoDB held
-- before the commit), then releases the writer's lease.
-- KEYS as command_fill_channel.lua
-- ARGV[1] writer token  ARGV[2..] fields (c:{name}) to mark stale; none drops the snapshot
redis.call('incr', KEYS[2])
if #ARGV < 2 then
  redis.call('del', KEYS[1])
elseif redis.call('exists', KEYS[1]) == 1 then
  local bytes = tonumber(redis.call('hget', KEYS[1], 'b')) or 0
  for i = 2, #ARGV do
    bytes = bytes - redis.call('hstrlen', KEYS[1], ARGV[i])
    redis.call('hset', KEYS[1], ARGV[i], '')
  end
  redis.call('hset', KEYS[1], 'b', tostring(bytes))
end
redis.call('zrem', KEYS[3], ARGV[1])
return 1
