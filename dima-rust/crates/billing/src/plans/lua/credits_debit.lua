
if ARGV[5] == '1' then
    local marked = redis.call('SET', KEYS[4], '1', 'NX', 'EX', ARGV[4])
    if not marked then return 2 end
end
local consumedNow = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
if consumedNow > 0 then
    redis.call('HINCRBY', KEYS[5], 'rev', 1)
    redis.call('HINCRBY', KEYS[5], 'debits', consumedNow)
    redis.call('EXPIRE', KEYS[5], ARGV[4])
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, data = pcall(cjson.decode, raw)
if not ok or tonumber(data.version) ~= tonumber(ARGV[3]) or data.available == false then return 0 end
local consumed = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
if consumed == 0 then return 0 end
data.used = math.max(0, (tonumber(data.used) or 0) + consumed)
data.balance = (tonumber(data.balance) or 0) - consumed
data.updatedAt = ARGV[2]
data.status = data.balance <= 0 and 'exhausted' or 'available'
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ARGV[4])
if data.balance <= 0 then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
end
return data.balance <= 0 and 1 or 0
