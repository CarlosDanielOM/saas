-- Rust-only (P2-BILLING-01c item 2): the local top-up after a grant Polar accepted
-- (`adminGrantAiCredits` writes `{...before, limit + credits, balance + credits, available, status
-- 'available'}` and removes the exhaustion flags when credit is left), applied only on top of the
-- publication of the read that verified the balance, once. Follows credits_hold.lua.
-- KEYS[1] credits, KEYS[2] exhaustion, KEYS[3] legacy exhaustion, KEYS[4] revision.
-- ARGV[1] whole credits, ARGV[2] the generation and ARGV[3] the publication count of the verified
-- read, ARGV[4] updatedAt, ARGV[5] the TTL in seconds, ARGV[6] the meter id, ARGV[7] the schema
-- version.
-- Returns 1 applied (the top-up counts as a publication, so it cannot apply twice), 0 nothing
-- changed: another generation, a publication since, or no balance cached.
local kind = holdKind(KEYS[4])
if kind ~= 'none' and kind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(kind))
end
if redis.call('HGET', KEYS[4], 'gen') ~= ARGV[2] then return 0 end
if (tonumber(redis.call('HGET', KEYS[4], 'pub') or '0') or 0) ~= tonumber(ARGV[3]) then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' then return 0 end
local credits = tonumber(ARGV[1])
data.version = tonumber(ARGV[7])
data.limit = (tonumber(data.limit) or 0) + credits
data.balance = (tonumber(data.balance) or 0) + credits
data.meterId = ARGV[6]
data.updatedAt = ARGV[4]
data.available = true
data.status = 'available'
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ARGV[5])
if data.balance > 0 then redis.call('DEL', KEYS[2], KEYS[3]) end
redis.call('HINCRBY', KEYS[4], 'pub', 1)
return 1
