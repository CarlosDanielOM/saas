local fields = {}
local moved = 0
local function take(key, slot)
    local kind = redis.call('TYPE', key)
    if type(kind) == 'table' then kind = kind['ok'] end
    if kind == 'none' then return end
    if kind == 'hash' then
        local generation = redis.call('HGET', key, 'generation')
        local number = tonumber(generation or '')
        if number and number >= tonumber(ARGV[1]) then return end
        local rotation = redis.call('HGET', key, 'rotation')
        if generation then
            fields[#fields + 1] = slot .. ':generation'
            fields[#fields + 1] = generation
        end
        if rotation then
            fields[#fields + 1] = slot .. ':rotation'
            fields[#fields + 1] = rotation
        end
    end
    fields[#fields + 1] = slot .. ':type'
    fields[#fields + 1] = kind
    redis.call('DEL', key)
    moved = moved + 1
end
take(KEYS[1], 'parked')
take(KEYS[2], 'conflict')
if moved == 0 then return 0 end
fields[#fields + 1] = 'signed_in_generation'
fields[#fields + 1] = ARGV[1]
fields[#fields + 1] = 'quarantined_at'
fields[#fields + 1] = ARGV[2]
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[3], unpack(fields))
redis.call('PEXPIRE', KEYS[3], ARGV[3])
return moved
