-- Rust-only (P2-BILLING-02a): a job failed (`failUsageJob`, fenced by the consumer lease): its
-- attempt is counted (7 days), the queue's failure count rises, and it goes back to the queue
-- tail, or to the dead-letter list once it reached the most attempts (1 for a job that cannot
-- be read). The reference's order: the counters change even when the job is no longer in the
-- processing list.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] queue, KEYS[4] dead-letter list,
-- KEYS[5] attempts counter, KEYS[6] health hash.
-- ARGV[1] owner token, ARGV[2] the job's exact bytes, ARGV[3] most attempts, ARGV[4] counter TTL (s).
-- Returns 2 (dead-lettered), 1 (requeued), 0 (not in the processing list) or -1 (lease not ours).
-- The three lists are checked first: Lua does not undo the removal when a push fails.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local function kind(key)
    local t = redis.call('TYPE', key)
    if type(t) == 'table' then t = t.ok end
    return t
end
for _, key in ipairs({KEYS[2], KEYS[3], KEYS[4]}) do
    local t = kind(key)
    if t ~= 'none' and t ~= 'list' then
        return redis.error_reply('WRONGTYPE ' .. key .. ' is a ' .. tostring(t) .. ', nothing moved')
    end
end
local attempts = redis.call('INCR', KEYS[5])
redis.call('EXPIRE', KEYS[5], ARGV[4])
redis.call('HINCRBY', KEYS[6], 'failures', 1)
if redis.call('LREM', KEYS[2], 1, ARGV[2]) == 0 then return 0 end
if attempts >= tonumber(ARGV[3]) then
    redis.call('RPUSH', KEYS[4], ARGV[2])
    redis.call('DEL', KEYS[5])
    return 2
end
redis.call('RPUSH', KEYS[3], ARGV[2])
return 1
