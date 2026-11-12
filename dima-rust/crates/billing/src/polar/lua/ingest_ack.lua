-- Rust-only (P2-BILLING-01b item 1, P2-BILLING-01c item 1): Polar stored the batch; removes
-- exactly its items and, in the same step, holds each one's credits against the balances
-- published from Polar for the settle time (its meter may not show them at once). The event's
-- hold moves here from the processing list that held it (P2-BILLING-02c item 3: one event, one
-- hold, released by the settle time whenever the event was queued). Follows the shared hold
-- functions (plans/lua/credits_hold.lua).
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] revision, KEYS[4] credits.
-- ARGV[1] owner token, ARGV[2..#ARGV-6] the batch's items, exact bytes, then: now (ms), how long
-- after an acknowledgement a debit is held (ms), the bucket size (ms), a new generation token,
-- the revision's TTL (s), the sweep floor (ms).
-- Returns how many were removed, or -1 when the lease is not ours (nothing changes).
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local revisionKind = holdKind(KEYS[3])
if revisionKind ~= 'none' and revisionKind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(revisionKind) .. ', nothing acknowledged')
end
local last = #ARGV
local now = tonumber(ARGV[last - 5])
local settle = tonumber(ARGV[last - 4])
local granularity = tonumber(ARGV[last - 3])
ensureGeneration(KEYS[3], KEYS[4], ARGV[last - 2], ARGV[last - 1])
local removed = 0
for i = 2, #ARGV - 6 do
    if redis.call('LREM', KEYS[2], 1, ARGV[i]) == 1 then
        removed = removed + 1
        local ok, event = pcall(cjson.decode, ARGV[i])
        if ok and type(event) == 'table' and type(event.metadata) == 'table' then
            holdUntil(KEYS[3], now + settle, granularity, holdCredits(event.metadata.credits))
        end
    end
end
heldAt(KEYS[3], 0, tonumber(ARGV[last]))
return removed
