-- Rust-only (P2-BILLING-02a): releases a usage queue's consumer lease if it is still ours.
-- KEYS[1] lease, KEYS[2] processing list (unused). ARGV[1] owner token, ARGV[2] unused.
-- Returns 1, or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
redis.call('DEL', KEYS[1])
return 1
