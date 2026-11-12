-- Rust-only (P2-BILLING-01b item 1): claims the channel's next usage batch under the flush lease.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] queue.
-- ARGV[1] owner token, ARGV[2] unused (no item), ARGV[3] most events, ARGV[4] most bytes.
-- What processing already holds is the unfinished batch of an earlier owner (its outcome is
-- unknown): it is resumed first, then topped up from the queue head within both limits (the
-- first item is always taken, so an item over the byte limit is claimed alone and refused by
-- the caller). Returns {items resumed, the batch in order}, or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local limit = tonumber(ARGV[4])
local batch = redis.call('LRANGE', KEYS[2], 0, math.min(tonumber(ARGV[3]), 1000) - 1)
local resumed = #batch
local bytes = 0
for i = 1, #batch do
    bytes = bytes + string.len(batch[i])
end
for i = #batch + 1, math.min(tonumber(ARGV[3]), 1000) do
    local item = redis.call('LINDEX', KEYS[3], 0)
    if not item then break end
    if i > 1 and bytes + string.len(item) > limit then break end
    redis.call('LMOVE', KEYS[3], KEYS[2], 'LEFT', 'RIGHT')
    bytes = bytes + string.len(item)
    batch[i] = item
end
return {resumed, batch}
