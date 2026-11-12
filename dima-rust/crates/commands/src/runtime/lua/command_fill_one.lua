-- Replaces one entry of an existing snapshot with what MongoDB answered for its name, under the
-- same fence as command_fill_channel.lua. An empty value removes the entry (in a complete
-- snapshot: the name does not exist). Field 'b' counts the bytes of the entries: a complete
-- snapshot that would exceed ARGV[5] is dropped (the next lookup loads the channel again and
-- finds it too large); a partial one refuses the entry, and holds at most ARGV[6] fields.
-- KEYS as command_fill_channel.lua
-- ARGV[1] revision read before the load  ARGV[2] now (epoch ms)  ARGV[3] field (c:{name})
-- ARGV[4] value ('' for none)  ARGV[5] most bytes  ARGV[6] most fields of a partial snapshot
-- Returns 1 when written, 2 when the snapshot was dropped, 0 when refused.
if (redis.call('get', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[2])
if redis.call('zcard', KEYS[3]) > 0 then return 0 end
local mode = redis.call('hget', KEYS[1], 'v')
if not mode then return 0 end
local bytes = (tonumber(redis.call('hget', KEYS[1], 'b')) or 0)
  - redis.call('hstrlen', KEYS[1], ARGV[3]) + string.len(ARGV[4])
if ARGV[4] == '' then
  redis.call('hdel', KEYS[1], ARGV[3])
  redis.call('hset', KEYS[1], 'b', tostring(bytes))
  return 1
end
if bytes > tonumber(ARGV[5]) then
  if mode == 'c' then
    redis.call('del', KEYS[1])
    return 2
  end
  return 0
end
if mode ~= 'c' and redis.call('hexists', KEYS[1], ARGV[3]) == 0
  and redis.call('hlen', KEYS[1]) >= tonumber(ARGV[6]) then
  return 0
end
redis.call('hset', KEYS[1], ARGV[3], ARGV[4], 'b', tostring(bytes))
return 1
