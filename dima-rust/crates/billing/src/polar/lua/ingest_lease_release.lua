-- Rust-only (P2-BILLING-01b item 1): releases the flush lease if it is still ours (the
-- reference read it and deleted it in two commands).
-- KEYS[1] lease, KEYS[2] processing list (unused). ARGV[1] owner token, ARGV[2] unused.
-- Returns 1, or -1 when the lease is not ours.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
redis.call('DEL', KEYS[1])
return 1
