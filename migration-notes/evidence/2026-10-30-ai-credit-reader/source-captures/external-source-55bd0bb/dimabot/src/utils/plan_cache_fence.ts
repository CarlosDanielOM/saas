/** Internal cache metadata; never part of returned account/credit API payloads. */
export const PLAN_CACHE_VERSION_FIELD = '__polar_plan_version';
export const planCacheFenceKey = (id: string) => `twitch:${id}:ai:credits:plan-version`;
export function planCacheVersion(at?: Date, key?: string): string {
    return at && key ? `${String(at.getTime()).padStart(13, '0')}:${key}` : '';
}

export const WRITE_PLAN_ACCOUNT_SCRIPT = `
local fence = redis.call('GET', KEYS[1])
if fence and fence > ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV, 2))
redis.call('DEL', KEYS[3])
return 1
`;

// Both cached-list reads and list publication validate every included account.
// This also fences an aggregate assembled before a concurrent plan invalidation.
export const CHECK_PLAN_ACCOUNTS_SCRIPT = `
for index = 1, #ARGV - 1 do
    local fence = redis.call('GET', KEYS[index])
    if fence and fence > ARGV[index] then return 0 end
end
if ARGV[#ARGV] ~= '' then
    redis.call('SET', KEYS[#KEYS], ARGV[#ARGV], 'EX', 3600)
end
return 1
`;

export const ACCEPT_PLAN_CREDITS_SCRIPT = `
local fence = redis.call('GET', KEYS[4])
if fence and fence > ARGV[1] then return 0 end
if ARGV[3] == 'read' then
    if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
else
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
end
if ARGV[4] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
else
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
`;
