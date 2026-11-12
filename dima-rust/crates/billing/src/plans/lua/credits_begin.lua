-- Rust-only (P2-BILLING-01c item 1): a fetch from Polar or a webhook projection begins. Follows
-- the shared hold functions (credits_hold.lua).
-- KEYS[1] revision, KEYS[2] credits. ARGV[1] a new generation token, ARGV[2] the revision's TTL.
-- A balance found without its revision belongs to a lost generation: it is deleted and a new
-- generation starts. Returns {generation, publications accepted so far}.
local gen = ensureGeneration(KEYS[1], KEYS[2], ARGV[1], ARGV[2])
return {gen, tonumber(redis.call('HGET', KEYS[1], 'pub') or '0') or 0}
