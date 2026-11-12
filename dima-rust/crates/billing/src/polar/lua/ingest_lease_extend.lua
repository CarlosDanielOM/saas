-- Rust-only (P2-BILLING-01b item 1): extends the flush lease before a send that may outlast it.
-- KEYS[1] lease, KEYS[2] processing list (unused).
-- ARGV[1] owner token, ARGV[2] unused (no item), ARGV[3] milliseconds.
-- Returns 1, or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
