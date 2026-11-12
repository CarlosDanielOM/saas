-- Rust-only (P2-BILLING-01b item 4): SYNC_CREDITS_SCRIPT (polar_billing_events.ts) with the
-- usage revision: the snapshot a Polar webhook carries is published as the reference publishes
-- it (fenced by the plan version and the snapshot version), local debits made since the
-- projection began are applied to it, and the publication advances the revision.
-- KEYS[1] credits, KEYS[2] exhaustion, KEYS[3] legacy exhaustion, KEYS[4] snapshot version,
-- KEYS[5] plan fence, KEYS[6] usage revision (hash: rev, pub, debits).
-- ARGV[1] snapshot version, ARGV[2] the snapshot or '', ARGV[3] exhaustion ('' keep, '1', '0'),
-- ARGV[4] the snapshot's TTL in seconds, ARGV[5] plan version, ARGV[6] debits read when the
-- projection began, ARGV[7] updatedAt, ARGV[8] the revision's TTL in seconds.
-- Returns 1 when published, 0 when a fence is newer.
local currentPlanVersion = redis.call('GET', KEYS[5])
if currentPlanVersion and currentPlanVersion > ARGV[5] then return 0 end
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[4], ARGV[1])
local exhaustion = ARGV[3]
if ARGV[2] ~= '' then
    local raw = ARGV[2]
    local debits = tonumber(redis.call('HGET', KEYS[6], 'debits') or '0') or 0
    local extra = debits - (tonumber(ARGV[6]) or 0)
    if extra > 0 then
        local ok, data = pcall(cjson.decode, raw)
        if ok and type(data) == 'table' and data.available ~= false then
            data.used = math.max(0, (tonumber(data.used) or 0) + extra)
            data.balance = (tonumber(data.balance) or 0) - extra
            data.updatedAt = ARGV[7]
            data.status = data.balance <= 0 and 'exhausted' or 'available'
            raw = cjson.encode(data)
            exhaustion = data.balance <= 0 and '1' or '0'
        end
    end
    redis.call('SET', KEYS[1], raw, 'EX', ARGV[4])
end
if exhaustion == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
elseif exhaustion == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
local advanced = (tonumber(redis.call('HGET', KEYS[6], 'rev') or '0') or 0) + 1
redis.call('HSET', KEYS[6], 'rev', advanced, 'pub', advanced)
redis.call('EXPIRE', KEYS[6], ARGV[8])
return 1
