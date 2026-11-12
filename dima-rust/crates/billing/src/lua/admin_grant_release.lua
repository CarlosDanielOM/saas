-- Rust-only (P2-BILLING-02b): forgets a pending admin grant once its outcome is known, if the
-- key still holds this operation id (a later grant's id is never removed).
-- KEYS[1] the pending grant. ARGV[1] the operation id. Returns 1, or 0 when it was not this one.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
