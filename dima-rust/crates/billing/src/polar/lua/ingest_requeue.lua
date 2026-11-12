-- Rust-only (P2-BILLING-01b item 1): Polar did not store these items and may later; they go
-- back to the queue head in their order.
-- KEYS[1] lease, KEYS[2] processing list, KEYS[3] queue.
-- ARGV[1] owner token, ARGV[2..] the items, exact bytes, in batch order.
-- Returns how many moved, or -1 when the lease is not ours (nothing changes). Both lists are
-- checked to be lists (or absent) before anything moves (P2-BILLING-01c item 6): a wrong type is
-- an error and nothing moves.
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
    return redis.error_reply('WRONGTYPE queue is a ' .. tostring(target) .. ', nothing moved')
end
local moved = 0
for i = #ARGV, 2, -1 do
    if redis.call('LREM', KEYS[2], 1, ARGV[i]) == 1 then
        redis.call('LPUSH', KEYS[3], ARGV[i])
        moved = moved + 1
    end
end
return moved
