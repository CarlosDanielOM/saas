
for index = 1, #ARGV - 1 do
    local fence = redis.call('GET', KEYS[index])
    if fence and fence > ARGV[index] then return 0 end
end
if ARGV[#ARGV] ~= '' then
    redis.call('SET', KEYS[#KEYS], ARGV[#ARGV], 'EX', 3600)
end
return 1
