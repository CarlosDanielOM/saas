-- Publishes a validation unless a sign-out began after the authentication did.
-- KEYS[1] the entry, KEYS[2] the token's fence, KEYS[3] the user's fence.
-- ARGV[1] the value, ARGV[2] its lifetime in seconds, ARGV[3] when the authentication began
-- (server milliseconds, from the lookup), ARGV[4] the publication window in milliseconds.
-- Returns 1 written, 0 too old, -1 the token was forgotten, -2 the user was forgotten.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local began = tonumber(ARGV[3])
if not began or now - began > tonumber(ARGV[4]) then
  return 0
end
local function moved(key)
  local stamp = redis.call('GET', KEYS[key])
  if not stamp then
    return false
  end
  local at = tonumber(stamp)
  return (not at) or at >= began
end
if moved(2) then
  return -1
end
if moved(3) then
  return -2
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
