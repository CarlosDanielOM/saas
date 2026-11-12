-- Rust-only (P2-BILLING-01b item 1): Polar will never accept this item; it moves to the
-- channel's dead-letter list with the reason, so the rest of the queue goes on. Its credits stay
-- held until its queuing time plus the queued hold (P2-BILLING-01c item 1): Polar never counts
-- it, an operator settles it. Follows the shared hold functions (plans/lua/credits_hold.lua).
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] dead-letter list, KEYS[4] revision,
-- KEYS[5] credits.
-- ARGV[1] owner token, ARGV[2] the item, exact bytes, ARGV[3] the header line (JSON), ARGV[4]
-- now (ms), ARGV[5] how long after queuing it is held (ms), ARGV[6] the bucket size (ms),
-- ARGV[7] a new generation token, ARGV[8] the revision's TTL (s), ARGV[9] the sweep floor (ms).
-- Stored as the header, a newline, then the item's bytes. Returns 1, 0 when the item is not in
-- the processing list, or -1 when the lease is not ours (nothing changes). Every key is checked
-- to have its type (or be absent) before anything moves (P2-BILLING-01c item 6, re-check finding
-- N7): Lua does not undo the removal when the push fails, so a wrong type is an error, nothing
-- moved.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local source = holdKind(KEYS[2])
if source ~= 'none' and source ~= 'list' then
    return redis.error_reply('WRONGTYPE processing list is a ' .. tostring(source) .. ', nothing moved')
end
local target = holdKind(KEYS[3])
if target ~= 'none' and target ~= 'list' then
    return redis.error_reply('WRONGTYPE dead-letter list is a ' .. tostring(target) .. ', nothing moved')
end
local revisionKind = holdKind(KEYS[4])
if revisionKind ~= 'none' and revisionKind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(revisionKind) .. ', nothing moved')
end
if redis.call('LREM', KEYS[2], 1, ARGV[2]) == 0 then return 0 end
redis.call('RPUSH', KEYS[3], ARGV[3] .. '\n' .. ARGV[2])
ensureGeneration(KEYS[4], KEYS[5], ARGV[7], ARGV[8])
local ok, event = pcall(cjson.decode, ARGV[2])
if ok and type(event) == 'table' and type(event.metadata) == 'table' then
    local queuedAt = tonumber(event.queuedAt) or tonumber(ARGV[4])
    holdUntil(KEYS[4], queuedAt + tonumber(ARGV[5]), tonumber(ARGV[6]), holdCredits(event.metadata.credits))
end
heldAt(KEYS[4], 0, tonumber(ARGV[9]))
return 1
