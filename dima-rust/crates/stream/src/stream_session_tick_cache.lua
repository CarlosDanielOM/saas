-- Constant work: fence journal changes and release against the tick owner.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'put' then
    redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
elseif ARGV[2] == 'finish' then
    redis.call('HSET', KEYS[2], 'done', ARGV[3])
    redis.call('HDEL', KEYS[2], 'plan', 'cursor', 'board_cursor')
elseif ARGV[2] == 'release' then
    redis.call('DEL', KEYS[1])
else
    return redis.error_reply('unknown tick journal operation')
end
return 1
