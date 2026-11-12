-- Rust-only (P2-BILLING-01c item 3): confirms that this process still holds the owner's plan
-- effects lease and extends it.
-- KEYS[1] the lease. ARGV[1] the holder's token, ARGV[2] milliseconds.
-- Returns 1, or 0 when another holder (or nobody) has it: nothing changes.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
