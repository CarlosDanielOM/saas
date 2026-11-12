-- Rust-only (P2-BILLING-01c item 3): releases the owner's plan effects lease if this process
-- still holds it.
-- KEYS[1] the lease. ARGV[1] the holder's token. Returns 1, or 0 when it was not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
