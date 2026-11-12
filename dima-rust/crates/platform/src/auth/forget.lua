-- Advances a fence (a token's or a user's) and deletes a token's entry, in one step.
-- KEYS[1] the fence, KEYS[2] (optional) the entry to delete.
-- ARGV[1] the clock allowance in milliseconds, ARGV[2] the fence's lifetime in milliseconds.
-- The fence holds a server time: every authentication that began at or before it is refused.
-- Returns the fence.
local t = redis.call('TIME')
local stamp = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[1])
local previous = tonumber(redis.call('GET', KEYS[1]) or '')
if previous and previous > stamp then
  stamp = previous
end
redis.call('SET', KEYS[1], tostring(stamp), 'PX', ARGV[2])
if KEYS[2] then
  redis.call('DEL', KEYS[2])
end
return stamp
