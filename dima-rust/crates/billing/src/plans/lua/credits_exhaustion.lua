-- Rust-only (P2-BILLING-01b item 4, review finding 7): isAiCreditsExhausted's reads and its
-- repair of the exhaustion flags in one atomic step, so a repair can never recreate flags that
-- a refill published after the read had cleared.
-- KEYS[1] exhaustion, KEYS[2] legacy exhaustion, KEYS[3] credits.
-- Either flag, or a cached snapshot that is exhausted (`status` 'exhausted', or `available`
-- true with a numeric `balance` at or below 0), means exhausted: both flags are then set.
-- Returns 1 (exhausted) or 0.
local canonical = redis.call('EXISTS', KEYS[1]) == 1
local legacy = redis.call('EXISTS', KEYS[2]) == 1
if canonical or legacy then
    if not (canonical and legacy) then
        redis.call('SET', KEYS[1], 'true')
        redis.call('SET', KEYS[2], 'true')
    end
    return 1
end
local raw = redis.call('GET', KEYS[3])
if not raw or raw == '' then return 0 end
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' then return 0 end
if data.status == 'exhausted'
    or (data.available == true and type(data.balance) == 'number' and data.balance <= 0) then
    redis.call('SET', KEYS[1], 'true')
    redis.call('SET', KEYS[2], 'true')
    return 1
end
return 0
