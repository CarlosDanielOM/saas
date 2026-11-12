-- DIMA032_RESET
local previous = redis.call('GET', KEYS[1]) or ''
local waiting = redis.call('ZRANGE', KEYS[2], 0, -1)
local processing = redis.call('GET', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
if processing then table.insert(waiting, processing) end
table.insert(waiting, 1, previous)
return waiting