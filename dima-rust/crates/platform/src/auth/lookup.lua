-- The validation cache entry of a token and the server's clock, read together.
-- KEYS[1] the entry. Returns {seconds, microseconds} or {seconds, microseconds, entry}.
local t = redis.call('TIME')
local entry = redis.call('GET', KEYS[1])
if entry then
  return {t[1], t[2], entry}
end
return {t[1], t[2]}
