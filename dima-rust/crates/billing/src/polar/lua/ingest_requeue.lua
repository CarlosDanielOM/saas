-- Rust-only (P2-BILLING-01b item 1): Polar did not store these items and may later; they go
-- back to the queue head in their order.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] queue.
-- ARGV[1] owner token, ARGV[2..] the items, exact bytes, in batch order.
-- Returns how many moved, or -1 when the lease is not ours (nothing changes).
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local moved = 0
for i = #ARGV, 2, -1 do
    if redis.call('LREM', KEYS[2], 1, ARGV[i]) == 1 then
        redis.call('LPUSH', KEYS[3], ARGV[i])
        moved = moved + 1
    end
end
return moved
