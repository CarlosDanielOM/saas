-- Rust-only (P2-BILLING-02a): claims the next batch of a usage job queue under its consumer lease.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] queue, KEYS[4] health hash.
-- ARGV[1] owner token, ARGV[2] unused (no item), ARGV[3] most jobs (capped at 1000), ARGV[4] now (ms).
-- What the processing list already holds was claimed by an earlier owner that stopped before it
-- settled it: it is resumed first (every job is applied idempotently), then topped up from the
-- queue head. `processingSince` is set when new jobs are claimed, as the reference's claim did.
-- Returns {jobs resumed, the batch in order}, or -1 when the lease is not ours (nothing moves).
-- Both lists are checked to be lists (or absent) first: a wrong type is an error, nothing moves.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local function kind(key)
    local t = redis.call('TYPE', key)
    if type(t) == 'table' then t = t.ok end
    return t
end
for _, key in ipairs({KEYS[2], KEYS[3]}) do
    local t = kind(key)
    if t ~= 'none' and t ~= 'list' then
        return redis.error_reply('WRONGTYPE ' .. key .. ' is a ' .. tostring(t) .. ', nothing moved')
    end
end
local batch = redis.call('LRANGE', KEYS[2], 0, math.min(tonumber(ARGV[3]), 1000) - 1)
local resumed = #batch
for i = #batch + 1, math.min(tonumber(ARGV[3]), 1000) do
    local item = redis.call('LPOP', KEYS[3])
    if not item then break end
    redis.call('RPUSH', KEYS[2], item)
    batch[i] = item
end
if #batch > resumed then redis.call('HSET', KEYS[4], 'processingSince', ARGV[4]) end
return {resumed, batch}
