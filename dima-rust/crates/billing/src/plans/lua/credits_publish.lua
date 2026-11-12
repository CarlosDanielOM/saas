-- Rust-only (P2-BILLING-01b item 4, P2-BILLING-01c item 1): publishes the balance a fetch from
-- Polar built, fenced by the plan version (as ACCEPT_PLAN_CREDITS_SCRIPT in write mode), by the
-- generation and publication count read when the fetch began, and with every local debit
-- Polar's figure may not cover yet held against it. Follows credits_hold.lua.
-- KEYS[1] credits, KEYS[2] exhaustion, KEYS[3] legacy exhaustion, KEYS[4] plan fence,
-- KEYS[5] revision, KEYS[6] usage queue, KEYS[7] its processing list.
-- ARGV[1] plan version, ARGV[2] the snapshot (JSON), ARGV[3] its TTL in seconds, ARGV[4] the
-- generation and ARGV[5] the publications read when the fetch began, ARGV[6] the figure's date
-- (when the fetch began, ms), ARGV[7] now (ms), ARGV[8] updatedAt, ARGV[9] the revision's TTL,
-- ARGV[10] the oldest figure still published (ms of age), ARGV[11] how long a queued event is
-- held (ms), ARGV[12] the most queued events counted.
-- Returns {1, stored, publications, held, unsettled} published: the publications accepted in the
-- generation (this one included), the whole credits held against Polar's figure, and the part of
-- them whose count at Polar is not settled (P2-BILLING-02c item 1: a reset waits for it);
-- {2, cached, 0, 0, 0} a publication was accepted since the fetch began; {0, '', 0, 0, 0} the
-- plan fence is newer; {3, '', 0, 0, 0} the generation was lost (a balance left without its
-- revision is deleted); {4, cached, 0, 0, 0} too many queued events to count;
-- {5, '', 0, 0, 0} the figure is too old. Nothing changes except in the first case (and the
-- deletion of the third).
local fence = redis.call('GET', KEYS[4])
if fence and fence > ARGV[1] then return {0, '', 0, 0, 0} end
local kind = holdKind(KEYS[5])
if kind ~= 'none' and kind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(kind))
end
local gen = redis.call('HGET', KEYS[5], 'gen')
if gen ~= ARGV[4] then
    if not gen then redis.call('DEL', KEYS[1]) end
    return {3, '', 0, 0, 0}
end
if (tonumber(redis.call('HGET', KEYS[5], 'pub') or '0') or 0) > (tonumber(ARGV[5]) or 0) then
    return {2, redis.call('GET', KEYS[1]) or '', 0, 0, 0}
end
local now = tonumber(ARGV[7])
local asOf = math.min(tonumber(ARGV[6]), now)
local floor = now - tonumber(ARGV[10])
if asOf <= floor then return {5, '', 0, 0, 0} end
local held = heldAt(KEYS[5], asOf, floor)
local queued = queuedHeld(KEYS[6], KEYS[7], asOf, tonumber(ARGV[11]), tonumber(ARGV[12]))
if not held or not queued then return {4, redis.call('GET', KEYS[1]) or '', 0, 0, 0} end
local raw = ARGV[2]
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' then return {0, '', 0, 0, 0} end
-- Every hold is unsettled here: an acknowledged debit Polar's meter may not count yet, a queued
-- one Polar has not stored or answered.
local total, unsettled = held + queued, held + queued
if applyHeld(data, total, ARGV[8]) then
    raw = cjson.encode(data)
else
    total, unsettled = 0, 0
end
redis.call('SET', KEYS[1], raw, 'EX', ARGV[3])
if data.status == 'exhausted' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
else
    redis.call('DEL', KEYS[2], KEYS[3])
end
local publications = redis.call('HINCRBY', KEYS[5], 'pub', 1)
redis.call('EXPIRE', KEYS[5], ARGV[9])
return {1, raw, publications, total, unsettled}
