-- Rust-only (P2-BILLING-02a): a job was applied; it leaves the processing list (by its exact
-- bytes) and its attempt counter is dropped (`completeUsageJob`, fenced by the consumer lease).
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] attempts counter.
-- ARGV[1] owner token, ARGV[2] the job's exact bytes.
-- Returns how many copies were removed (0 or 1), or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local removed = redis.call('LREM', KEYS[2], 1, ARGV[2])
redis.call('DEL', KEYS[3])
return removed
