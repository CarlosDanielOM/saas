-- Rust-only (P2-BILLING-01b item 4, P2-BILLING-01c item 1): SYNC_CREDITS_SCRIPT
-- (polar_billing_events.ts) with the hold: the snapshot a Polar webhook carries is published as
-- the reference publishes it (fenced by the plan version and the snapshot version; an equal
-- version is published again), within the generation read when the projection began, with every
-- local debit Polar's figure at `occurredAt` may not cover held against it. Publishing the same
-- snapshot twice therefore stores the same balance. Follows credits_hold.lua.
-- KEYS[1] credits, KEYS[2] exhaustion, KEYS[3] legacy exhaustion, KEYS[4] snapshot version,
-- KEYS[5] plan fence, KEYS[6] revision, KEYS[7] usage queue, KEYS[8] its processing list,
-- KEYS[9] its dead-letter list.
-- ARGV[1] snapshot version, ARGV[2] the snapshot or '', ARGV[3] exhaustion ('' keep, '1', '0'),
-- ARGV[4] the snapshot's TTL in seconds, ARGV[5] plan version, ARGV[6] the generation read when
-- the projection began, ARGV[7] the snapshot's date (occurredAt, ms), ARGV[8] now (ms),
-- ARGV[9] updatedAt, ARGV[10] the revision's TTL, ARGV[11] the oldest figure still published
-- (ms of age), ARGV[12] how long a queued event is held (ms), ARGV[13] the most queued and
-- dead-lettered events, ARGV[14] the clock skew allowed between the processes that set events
-- aside (ms).
-- Returns 1 published, 0 a fence is newer, 3 the generation was lost (a balance left without
-- its revision is deleted), 4 too many queued events to count, 5 the snapshot is too old.
local currentPlanVersion = redis.call('GET', KEYS[5])
if currentPlanVersion and currentPlanVersion > ARGV[5] then return 0 end
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
local kind = holdKind(KEYS[6])
if kind ~= 'none' and kind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(kind))
end
local gen = redis.call('HGET', KEYS[6], 'gen')
if gen ~= ARGV[6] then
    if not gen then redis.call('DEL', KEYS[1]) end
    return 3
end
local now = tonumber(ARGV[8])
local asOf = math.min(tonumber(ARGV[7]), now)
local floor = now - tonumber(ARGV[11])
if asOf <= floor then return 5 end
local held = heldAt(KEYS[6], asOf, floor)
local queued, waiting = queuedHeld(KEYS[7], KEYS[8], asOf, tonumber(ARGV[12]), tonumber(ARGV[13]))
local dead = queued and deadHeld(KEYS[9], asOf, tonumber(ARGV[12]), tonumber(ARGV[14]), tonumber(ARGV[13]) - waiting)
if not held or not queued or not dead then return 4 end
redis.call('SET', KEYS[4], ARGV[1])
local exhaustion = ARGV[3]
if ARGV[2] ~= '' then
    local raw = ARGV[2]
    local ok, data = pcall(cjson.decode, raw)
    if ok and type(data) == 'table' and applyHeld(data, held + queued + dead, ARGV[9]) then
        raw = cjson.encode(data)
        exhaustion = data.balance <= 0 and '1' or '0'
    end
    redis.call('SET', KEYS[1], raw, 'EX', ARGV[4])
end
if exhaustion == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
elseif exhaustion == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
redis.call('HINCRBY', KEYS[6], 'pub', 1)
redis.call('EXPIRE', KEYS[6], ARGV[10])
return 1
