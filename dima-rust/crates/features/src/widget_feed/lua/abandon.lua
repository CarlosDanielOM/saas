-- Mark only the caller's fenced ticket abandoned. Later commit/reserve skips it.
if redis.call('HGET', KEYS[1], 'owner:' .. ARGV[1]) == ARGV[2] then
  redis.call('HSET', KEYS[1], 'due:' .. ARGV[1], 0)
end
return 1
