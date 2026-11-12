-- Rust-only (P2-BILLING-01b item 1): Polar will never accept this item; it moves to the
-- channel's dead-letter list with the reason, so the rest of the queue goes on.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] dead-letter list.
-- ARGV[1] owner token, ARGV[2] the item, exact bytes, ARGV[3] the header line (JSON).
-- Stored as the header, a newline, then the item's bytes. Returns 1, 0 when the item is not in
-- the processing list, or -1 when the lease is not ours (nothing changes).
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('LREM', KEYS[2], 1, ARGV[2]) == 0 then return 0 end
redis.call('RPUSH', KEYS[3], ARGV[3] .. '\n' .. ARGV[2])
return 1
