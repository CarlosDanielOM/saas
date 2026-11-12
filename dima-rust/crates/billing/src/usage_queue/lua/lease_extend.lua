-- Rust-only (P2-BILLING-02a): renews a usage queue's consumer lease if it is still ours.
-- KEYS[1] lease, KEYS[2] processing list (unused). ARGV[1] owner token, ARGV[2] unused, ARGV[3] ms.
-- Returns 1, or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
