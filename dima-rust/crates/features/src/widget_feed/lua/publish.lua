-- Admission and PUBLISH share one server linearization point across all bot processes.
-- No loops. Message bytes retain their original JSON field order.
-- KEYS: all-rate, signal-rate, skipped, seen, demand. ARGV: payload, topic,
-- signal flag, action-key-present, chat-demand-required.
-- KEYS[6] is the FIFO hash. ARGV[6:7] identify a fenced ticket.
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local head = tonumber(redis.call('HGET', KEYS[6], 'head') or '0')
local next = tonumber(redis.call('HGET', KEYS[6], 'next') or '0')
for i = 1, 64 do
  if head >= next then break end
  local due = tonumber(redis.call('HGET', KEYS[6], 'due:' .. head) or '0')
  if due > now then break end
  redis.call('HDEL', KEYS[6], 'owner:' .. head, 'due:' .. head)
  head = head + 1
end
redis.call('HSET', KEYS[6], 'head', head)
local ticket = tonumber(ARGV[6])
if head > ticket or redis.call('HGET', KEYS[6], 'owner:' .. ticket) ~= ARGV[7] then return 5 end
if head < ticket then return 4 end
local function finish(status)
  redis.call('HDEL', KEYS[6], 'owner:' .. head, 'due:' .. head)
  redis.call('HSET', KEYS[6], 'head', head + 1)
  return status
end
if ARGV[5] == '1' and redis.call('EXISTS', KEYS[5]) == 0 then return finish(0) end
if ARGV[4] == '1' and redis.call('EXISTS', KEYS[4]) == 1 then return finish(2) end
local total = redis.call('INCR', KEYS[1])
if total == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 1) end
local limited = total > 100
if ARGV[3] == '1' then
  local n = redis.call('INCR', KEYS[2])
  if n == 1 or redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], 10) end
  limited = limited or n > 30
end
if limited then
  if ARGV[3] == '1' then
    local n = redis.call('INCR', KEYS[3])
    if n == 1 or redis.call('TTL', KEYS[3]) < 0 then redis.call('EXPIRE', KEYS[3], 600) end
  end
  return finish(3)
end
-- Unlike Node, rejected signals never allocate a day-long dedupe key.
-- This closes the unbounded-key amplification path above the signal quota.
if ARGV[4] == '1' then redis.call('SET', KEYS[4], '1', 'EX', 86400) end
finish(1)
redis.call('PUBLISH', ARGV[2], ARGV[1])
return 1
