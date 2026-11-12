-- Rust-only (P2-BILLING-01c item 1): the hold of local debits, shared by every script that
-- writes a channel's revision hash `twitch:{id}:ai:credits:revision` (see `plans/balance.rs`).
-- Fields: `gen` (the generation: a random token set when the hash is created), `pub` (the
-- publications accepted in it), `h:{ms}` (credits held for a figure from Polar dated before that
-- time, rounded up). A balance whose hash is gone belongs to a lost generation.
local function holdKind(key)
    local t = redis.call('TYPE', key)
    if type(t) == 'table' then t = t.ok end
    return t
end
-- The generation of `revision`, created (and the balance of the lost one deleted) when the hash
-- is missing or has none.
local function ensureGeneration(revision, credits, candidate, ttl)
    local gen = redis.call('HGET', revision, 'gen')
    if not gen then
        redis.call('DEL', revision, credits)
        redis.call('HSET', revision, 'gen', candidate, 'pub', 0)
        gen = candidate
    end
    redis.call('EXPIRE', revision, ttl)
    return gen
end
-- Whole credits of a usage amount, as the debit computes them (0 for anything else).
local function holdCredits(value)
    local credits = tonumber(value)
    if not credits or credits ~= credits or credits <= 0 or credits > 1e15 then return 0 end
    return math.ceil(credits)
end
-- Holds `amount` credits for every figure dated before `releaseAt` (rounded up to `granularity`).
local function holdUntil(revision, releaseAt, granularity, amount)
    if amount <= 0 then return end
    local bucket = math.ceil(releaseAt / granularity) * granularity
    redis.call('HINCRBY', revision, string.format('h:%d', bucket), amount)
end
-- The credits held for a figure dated `asOf`; buckets released at or before `floor` (older than
-- any figure still published) are removed. nil when the hash is past its bound (never reached).
local function heldAt(revision, asOf, floor)
    local all = redis.call('HGETALL', revision)
    if #all > 2000 then return nil end
    local held = 0
    for i = 1, #all - 1, 2 do
        local at = string.match(all[i], '^h:(%d+)$')
        if at then
            local releaseAt = tonumber(at)
            if releaseAt <= floor then
                redis.call('HDEL', revision, all[i])
            elseif releaseAt > asOf then
                held = held + (tonumber(all[i + 1]) or 0)
            end
        end
    end
    return held
end
-- The credits of the usage events still queued or claimed (Polar has not acknowledged them),
-- each held until its queuing time plus `holdMs`; nil when more than `most` are waiting.
local function queuedHeld(queue, processing, asOf, holdMs, most)
    if redis.call('LLEN', queue) + redis.call('LLEN', processing) > most then return nil end
    local held = 0
    for _, key in ipairs({queue, processing}) do
        local items = redis.call('LRANGE', key, 0, most - 1)
        for i = 1, #items do
            local ok, event = pcall(cjson.decode, items[i])
            if ok and type(event) == 'table' and type(event.metadata) == 'table' then
                local queuedAt = tonumber(event.queuedAt)
                if not queuedAt or queuedAt + holdMs > asOf then
                    held = held + holdCredits(event.metadata.credits)
                end
            end
        end
    end
    return held
end
-- Applies `held` credits to a snapshot (an unavailable one is left as it is).
local function applyHeld(data, held, updatedAt)
    if held <= 0 or data.available == false then return false end
    data.used = math.max(0, (tonumber(data.used) or 0) + held)
    data.balance = (tonumber(data.balance) or 0) - held
    data.updatedAt = updatedAt
    data.status = data.balance <= 0 and 'exhausted' or 'available'
    return true
end
