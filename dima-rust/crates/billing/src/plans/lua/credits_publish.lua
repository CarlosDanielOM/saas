-- Rust-only (P2-BILLING-01b item 4): publishes the balance a fetch from Polar built, fenced by
-- the plan version (as ACCEPT_PLAN_CREDITS_SCRIPT in write mode) and by the usage revision read
-- before the fetch started.
-- KEYS[1] credits, KEYS[2] exhaustion, KEYS[3] legacy exhaustion, KEYS[4] plan fence,
-- KEYS[5] usage revision (hash: rev, pub, debits).
-- ARGV[1] plan version, ARGV[2] the snapshot (JSON), ARGV[3] its TTL in seconds,
-- ARGV[4] rev and ARGV[5] debits read before the fetch, ARGV[6] updatedAt, ARGV[7] the
-- revision's TTL in seconds.
-- A publication accepted since the fetch began is newer: {2, the cached value} and nothing
-- changes. Local debits made since are applied to the snapshot before it is stored (an
-- unavailable snapshot is stored as it is). Returns {1, the stored value}, or {0, ''} when the
-- plan fence is newer.
local fence = redis.call('GET', KEYS[4])
if fence and fence > ARGV[1] then return {0, ''} end
local rev = tonumber(redis.call('HGET', KEYS[5], 'rev') or '0') or 0
local pub = tonumber(redis.call('HGET', KEYS[5], 'pub') or '0') or 0
local debits = tonumber(redis.call('HGET', KEYS[5], 'debits') or '0') or 0
local start = tonumber(ARGV[4]) or 0
if rev < start or pub > start then
    return {2, redis.call('GET', KEYS[1]) or ''}
end
local raw = ARGV[2]
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' then return {0, ''} end
local extra = debits - (tonumber(ARGV[5]) or 0)
if extra > 0 and data.available ~= false then
    data.used = math.max(0, (tonumber(data.used) or 0) + extra)
    data.balance = (tonumber(data.balance) or 0) - extra
    data.updatedAt = ARGV[6]
    data.status = data.balance <= 0 and 'exhausted' or 'available'
    raw = cjson.encode(data)
end
redis.call('SET', KEYS[1], raw, 'EX', ARGV[3])
if data.status == 'exhausted' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
else
    redis.call('DEL', KEYS[2], KEYS[3])
end
local advanced = rev + 1
redis.call('HSET', KEYS[5], 'rev', advanced, 'pub', advanced)
redis.call('EXPIRE', KEYS[5], ARGV[7])
return {1, raw}
