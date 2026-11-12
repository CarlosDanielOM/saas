-- FIFO admission before async normalization, shared across processes. Only 64 live tickets.
-- Server time fences operational leases; application time still comes from injected Clock.
-- KEYS: order hash, demand; ARGV: unique nonce, lease-ms, demand-required.
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[2]) == 0 then return {0, 0} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local head = tonumber(redis.call('HGET', KEYS[1], 'head') or '0')
local next = tonumber(redis.call('HGET', KEYS[1], 'next') or '0')
for i = 1, 64 do
  if head >= next then break end
  local due = tonumber(redis.call('HGET', KEYS[1], 'due:' .. head) or '0')
  if due > now then break end
  redis.call('HDEL', KEYS[1], 'owner:' .. head, 'due:' .. head)
  head = head + 1
end
redis.call('HSET', KEYS[1], 'head', head)
if next - head >= 64 then return {3, 0} end
redis.call('HSET', KEYS[1], 'next', next + 1, 'owner:' .. next, ARGV[1], 'due:' .. next, now + tonumber(ARGV[2]))
redis.call('EXPIRE', KEYS[1], 60)
return {1, next}
