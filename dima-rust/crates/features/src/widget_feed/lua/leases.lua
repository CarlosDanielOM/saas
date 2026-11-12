-- Bounded registry owned by realtime sessions; max 128 channel entries / 16 per widget.
-- KEYS: expiry zset, uses hash, demand string. ARGV: now-ms, member, uses, op.
-- ZSET and hash have the same membership; every touch removes expired entries.
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 128)
for i = 1, 128 do
  local member = expired[i]
  if not member then break end
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[2], member)
end
local status = 1
if ARGV[4] == 'remove' then
  redis.call('ZREM', KEYS[1], ARGV[2])
  redis.call('HDEL', KEYS[2], ARGV[2])
elseif ARGV[4] == 'add' then
  local all = redis.call('ZRANGE', KEYS[1], 0, 127)
  local widget = string.match(ARGV[2], '^([^:]+):') .. ':'
  local count = 0
  for i = 1, 128 do
    local member = all[i]
    if not member then break end
    if string.sub(member, 1, string.len(widget)) == widget then count = count + 1 end
  end
  if redis.call('HEXISTS', KEYS[2], ARGV[2]) == 0 and (#all >= 128 or count >= 16) then
    status = 0
  else
    redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + 60000, ARGV[2])
    redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
    redis.call('PEXPIRE', KEYS[1], 60000)
    redis.call('PEXPIRE', KEYS[2], 60000)
  end
end
local all = redis.call('ZRANGE', KEYS[1], 0, 127)
local chat = false
local result = {tostring(status)}
for i = 1, 128 do
  local member = all[i]
  if not member then break end
  local uses = redis.call('HGET', KEYS[2], member) or ''
  if string.find(',' .. uses .. ',', ',chat,', 1, true) then chat = true end
  table.insert(result, member)
  table.insert(result, uses)
end
if chat then redis.call('SET', KEYS[3], '1', 'EX', 60)
else redis.call('DEL', KEYS[3]) end
return result
