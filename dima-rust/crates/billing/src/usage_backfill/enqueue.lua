
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  redis.call('RPUSH', KEYS[2], ARGV[3])
  return 1
end
return 0
