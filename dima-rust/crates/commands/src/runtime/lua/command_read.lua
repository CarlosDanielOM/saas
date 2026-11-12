-- One chat message's command lookup: the channel's snapshot mode, the named entry and the
-- channel's revision, read together.
-- KEYS[1] commands:snapshot:{channel} (hash)  KEYS[2] commands:revision:{channel} (string)
-- ARGV[1] the entry's field (c:{name})
-- Returns {revision or '0', mode or nil, entry or nil}.
local found = redis.call('hmget', KEYS[1], 'v', ARGV[1])
return {redis.call('get', KEYS[2]) or '0', found[1] or false, found[2] or false}
