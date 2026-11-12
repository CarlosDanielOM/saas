-- Rust-only (P2-BILLING-01b item 1): Polar will never accept this item; it moves to the
-- channel's dead-letter list with the reason, so the rest of the queue goes on.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] dead-letter list.
-- ARGV[1] owner token, ARGV[2] the item, exact bytes, ARGV[3] the header line (JSON).
-- Stored as the header, a newline, then the item's bytes. Returns 1, 0 when the item is not in
-- the processing list, or -1 when the lease is not ours (nothing changes). Both lists are checked
-- to be lists (or absent) before anything moves (P2-BILLING-01c item 6, re-check finding N7):
-- Lua does not undo the removal when the push fails, so a wrong type is an error, nothing moved.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local function kind(key)
    local t = redis.call('TYPE', key)
    if type(t) == 'table' then t = t.ok end
    return t
end
local source = kind(KEYS[2])
if source ~= 'none' and source ~= 'list' then
    return redis.error_reply('WRONGTYPE processing list is a ' .. tostring(source) .. ', nothing moved')
end
local target = kind(KEYS[3])
if target ~= 'none' and target ~= 'list' then
    return redis.error_reply('WRONGTYPE dead-letter list is a ' .. tostring(target) .. ', nothing moved')
end
if redis.call('LREM', KEYS[2], 1, ARGV[2]) == 0 then return 0 end
redis.call('RPUSH', KEYS[3], ARGV[3] .. '\n' .. ARGV[2])
return 1
