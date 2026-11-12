-- Rust-only (P2-BILLING-02a): an operator settles or requeues one entry of a channel's usage
-- dead-letter list, once per operation id. The entry is `{"reason","at"}`, a newline, then the
-- queued event's bytes; a requeue appends those bytes to the usage queue (its external id is
-- unchanged, so a resend that Polar already has is counted as a duplicate there).
-- KEYS[1] dead-letter list, KEYS[2] usage queue, KEYS[3] the operation's record.
-- ARGV[1] the entry's exact bytes, ARGV[2] 'settle' or 'requeue', ARGV[3] the entry's sha256
-- hex, ARGV[4] the record's TTL (s).
-- Returns {repeated (0|1), outcome}: outcome is 'settled', 'requeued', 'missing' (no such
-- entry), or 'conflict' (the operation id was used for another entry or action). A repeated
-- operation changes nothing and answers its first outcome.
local record = redis.call('GET', KEYS[3])
local tag = ARGV[2] .. ':' .. ARGV[3]
if record then
    local at = string.find(record, '|', 1, true)
    if not at or string.sub(record, at + 1) ~= tag then return {1, 'conflict'} end
    return {1, string.sub(record, 1, at - 1)}
end
local function kind(key)
    local t = redis.call('TYPE', key)
    if type(t) == 'table' then t = t.ok end
    return t
end
for _, key in ipairs({KEYS[1], KEYS[2]}) do
    local t = kind(key)
    if t ~= 'none' and t ~= 'list' then
        return redis.error_reply('WRONGTYPE ' .. key .. ' is a ' .. tostring(t) .. ', nothing moved')
    end
end
local newline = string.find(ARGV[1], '\n', 1, true)
if ARGV[2] == 'requeue' and not newline then return {0, 'missing'} end
local outcome = 'missing'
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
    if ARGV[2] == 'requeue' then
        redis.call('RPUSH', KEYS[2], string.sub(ARGV[1], newline + 1))
        outcome = 'requeued'
    else
        outcome = 'settled'
    end
end
redis.call('SET', KEYS[3], outcome .. '|' .. tag, 'EX', ARGV[4])
return {0, outcome}
