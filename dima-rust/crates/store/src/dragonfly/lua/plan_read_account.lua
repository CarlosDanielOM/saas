
if redis.call('HLEN', KEYS[1]) > tonumber(ARGV[1]) then return {-2, {}} end
local account = redis.call('HGETALL', KEYS[1])
local id = ''
local version = ''
local bytes = 0
for index = 1, #account, 2 do
    bytes = bytes + string.len(account[index]) + string.len(account[index + 1])
    if bytes > tonumber(ARGV[2]) then return {-2, {}} end
    if account[index] == 'id' then id = account[index + 1] end
    if account[index] == '__polar_plan_version' then version = account[index + 1] end
end
if id == '' then return {0, {}} end
local fence = redis.call('GET', KEYS[2])
if fence and fence > version then return {-1, {}} end
return {1, account}
