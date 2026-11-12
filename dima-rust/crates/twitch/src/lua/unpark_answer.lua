if redis.call('HGET', KEYS[1], 'rotation') == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
if redis.call('HGET', KEYS[2], 'rotation') == ARGV[1] then
    return redis.call('DEL', KEYS[2])
end
return 0
