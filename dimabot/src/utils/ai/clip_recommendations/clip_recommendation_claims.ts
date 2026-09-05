// KEYS start with the worker lock and processing list; ARGV start with owner and raw claim.
export const CLIP_CLAIM_SCRIPTS = {
    acknowledge: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local removed = redis.call('LREM', KEYS[2], 1, ARGV[2])
if removed > 0 and #KEYS > 2 then redis.call('DEL', KEYS[3]) end
return removed
`,
    requeue: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if not redis.call('LPOS', KEYS[2], ARGV[2]) then return 0 end
local pushed = redis.pcall('LPUSH', KEYS[3], ARGV[3])
if type(pushed) == 'table' and pushed.err then return redis.error_reply(pushed.err) end
return redis.call('LREM', KEYS[2], 1, ARGV[2])
`,
    deadLetter: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if not redis.call('LPOS', KEYS[2], ARGV[2]) then return 0 end
local pushed = redis.pcall('RPUSH', KEYS[3], ARGV[3])
if type(pushed) == 'table' and pushed.err then return redis.error_reply(pushed.err) end
redis.call('LREM', KEYS[2], 1, ARGV[2])
if #KEYS > 3 then redis.call('DEL', KEYS[4]) end
return 1
`,
    recover: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
return redis.call('RPOPLPUSH', KEYS[2], KEYS[3])
`
} as const;
