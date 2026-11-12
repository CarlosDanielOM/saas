-- A cache variable's value, read only when it is short enough (P4-ACT-CORE; no TypeScript
-- counterpart: the reference's GET reads any size).
-- KEYS[1] the cache variable's key (string)
-- ARGV[1] the most bytes the caller takes
-- Returns the value, nil when the key is missing, or its length (an integer) when it is longer.
-- A key of another type fails as GET does (WRONGTYPE). No loop.
local length = redis.call('STRLEN', KEYS[1])
if length > tonumber(ARGV[1]) then
    return length
end
return redis.call('GET', KEYS[1])
