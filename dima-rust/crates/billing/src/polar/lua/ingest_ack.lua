-- Rust-only (P2-BILLING-01b item 1): Polar stored the batch; removes exactly its items.
-- KEYS[1] lease, KEYS[2] processing list.
-- ARGV[1] owner token, ARGV[2..] the batch's items, exact bytes.
-- Returns how many were removed, or -1 when the lease is not ours (nothing changes).
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local removed = 0
for i = 2, #ARGV do
    removed = removed + redis.call('LREM', KEYS[2], 1, ARGV[i])
end
return removed
