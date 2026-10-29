
interface FixtureCache {
 eval(lua: string, options: {keys: string[], arguments: string[]}): Promise<number>;
 exists(key: string): Promise<number>; get(key: string): Promise<string|null>;
 set(key: string, value: string): Promise<unknown>; del(key: string): Promise<number>;
}
declare function getDragonflyClient(context: string): Promise<FixtureCache>;
declare function createHash(name: string): { update(value: string): {digest(encoding: string): string} };
type PlanTier = 'free' | 'premium' | 'pro';
export const AI_CREDITS_METER_ID = '5103e79b-fd74-4ba8-a287-f95574f9addf';
export const AI_CREDIT_LIMITS = {
  free: 25000,
  premium: 200000,
  pro: 800000
} as const;
export const AI_CREDITS_CACHE_TTL_SECONDS = 5 * 60;
export const AI_CREDITS_CACHE_SCHEMA_VERSION = 3;
export type AiCreditStatus = 'unavailable' | 'available' | 'exhausted';
export interface AiCreditsData {
  version: number;
  used: number;
  limit: number;
  balance: number; // remaining credits
  meterId: string;
  updatedAt: string;
  available: boolean;
  status: AiCreditStatus;
}
export interface PolarAiCreditsMeterLike {
    meter_id?: string;
    consumed_units?: number | string | null;
    credited_units?: number | string | null;
    balance?: number | string | null;
    limit?: number | string | null;
}
function toFiniteNumber(value: unknown, fallback = 0): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}
export function getAiCreditLimitForPlan(planTier: PlanTier | null | undefined): number {
    const safeTier = planTier && planTier in AI_CREDIT_LIMITS ? planTier : 'free';
    return AI_CREDIT_LIMITS[safeTier];
}
export function buildAiCreditsDataFromMeter(
    meter: PolarAiCreditsMeterLike | null | undefined,
    planTier: PlanTier | null | undefined,
    updatedAt = new Date().toISOString()
): AiCreditsData {
    const polarLimit = toFiniteNumber(meter?.limit, 0);
    const creditedUnits = toFiniteNumber(meter?.credited_units, 0);
    const planLimit = getAiCreditLimitForPlan(planTier);

    // Polar active_meters payload for the current credit meter exposes:
    // - consumed_units: total credits spent in the period
    // - balance: negative of consumed units when no explicit credits are loaded in Polar
    // For the dashboard, source-of-truth usage is consumed_units, not balance.
    const consumedUnits = toFiniteNumber(meter?.consumed_units, Number.NaN);
    const balanceValue = toFiniteNumber(meter?.balance, Number.NaN);

    let used = 0;
    if (Number.isFinite(consumedUnits) && consumedUnits > 0) {
        used = consumedUnits;
    } else if (creditedUnits > 0 && Number.isFinite(balanceValue)) {
        // If credits were granted, Polar can report negative consumed_units for grants.
        // In that case, derive usage from granted credits minus current balance.
        used = Math.max(0, creditedUnits - balanceValue);
    } else if (Number.isFinite(balanceValue) && balanceValue < 0) {
        used = Math.abs(balanceValue);
    } else if (Number.isFinite(consumedUnits)) {
        used = Math.max(0, consumedUnits);
    }

    const roundedUsed = Math.max(0, Math.round(used));
    const remainingFromPolar = Number.isFinite(balanceValue) ? Math.max(0, Math.round(balanceValue)) : 0;
    const limit = Math.max(
        0,
        Math.round(Math.max(planLimit, polarLimit, creditedUnits, remainingFromPolar))
    );
    const remaining = balanceValue > 0 ? Math.max(limit - roundedUsed, remainingFromPolar) : limit - roundedUsed;

    return {
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: roundedUsed,
        limit,
        balance: remaining,
        meterId: AI_CREDITS_METER_ID,
        updatedAt,
        available: true,
        status: remaining <= 0 ? 'exhausted' : 'available'
    };
}
export function applyAiCreditUsageToSnapshot(
    snapshot: AiCreditsData,
    credits: number,
    updatedAt = new Date().toISOString()
): AiCreditsData {
    const consumed = Math.max(0, Math.ceil(toFiniteNumber(credits, 0)));
    if (!snapshot.available || consumed === 0) return { ...snapshot };

    const balance = snapshot.balance - consumed;
    return {
        ...snapshot,
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: snapshot.used + consumed,
        balance,
        updatedAt,
        status: balance <= 0 ? 'exhausted' : 'available'
    };
}
const APPLY_AI_CREDIT_USAGE_SCRIPT = `
if ARGV[5] == '1' then
    local marked = redis.call('SET', KEYS[4], '1', 'NX', 'EX', ARGV[4])
    if not marked then return 2 end
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, data = pcall(cjson.decode, raw)
if not ok or tonumber(data.version) ~= tonumber(ARGV[3]) or data.available == false then return 0 end
local consumed = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
if consumed == 0 then return 0 end
data.used = math.max(0, (tonumber(data.used) or 0) + consumed)
data.balance = (tonumber(data.balance) or 0) - consumed
data.updatedAt = ARGV[2]
data.status = data.balance <= 0 and 'exhausted' or 'available'
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ARGV[4])
if data.balance <= 0 then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
end
return data.balance <= 0 and 1 or 0
`;
export async function recordAiCreditUsage(
    channelID: string,
    credits: number,
    externalId?: string,
    cacheOverride?: Awaited<ReturnType<typeof getDragonflyClient>>
): Promise<void> {
    if (!channelID || !Number.isFinite(credits) || credits <= 0) return;

    try {
        const cache = cacheOverride || await getDragonflyClient('recordAiCreditUsage');
        const markerSuffix = externalId
            ? createHash('sha256').update(externalId).digest('hex')
            : 'untracked';
        await cache.eval(APPLY_AI_CREDIT_USAGE_SCRIPT, {
            keys: [
                `twitch:${channelID}:ai:credits`,
                `twitch:${channelID}:ai:exhaust`,
                `${channelID}:ai:exhaust`,
                `twitch:${channelID}:ai:usage-local:${markerSuffix}`
            ],
            arguments: [
                String(credits),
                new Date().toISOString(),
                String(AI_CREDITS_CACHE_SCHEMA_VERSION),
                String(31 * 24 * 60 * 60),
                externalId ? '1' : '0'
            ]
        });
    } catch (err) {
        // Polar remains the source of truth and its webhook will reconcile this
        // best-effort local projection if Dragonfly is temporarily unavailable.
        console.error('recordAiCreditUsage: local credit projection failed', {
            channelID,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}
async function syncAiCreditExhaustionStatus(
    cache: Awaited<ReturnType<typeof getDragonflyClient>>,
    channelID: string,
    exhausted: boolean
): Promise<void> {
    const keys = [`twitch:${channelID}:ai:exhaust`, `${channelID}:ai:exhaust`];
    if (exhausted) {
        await Promise.all(keys.map((key) => cache.set(key, 'true')));
    } else {
        await Promise.all(keys.map((key) => cache.del(key)));
    }
}
export async function isAiCreditsExhausted(
    channelID: string,
    cacheOverride?: Awaited<ReturnType<typeof getDragonflyClient>>
): Promise<boolean> {
    if (!channelID) return false;
    const cache = cacheOverride || await getDragonflyClient('isAiCreditsExhausted');
    const [canonical, legacy] = await Promise.all([
        cache.exists(`twitch:${channelID}:ai:exhaust`),
        cache.exists(`${channelID}:ai:exhaust`)
    ]);
    if (canonical === 1 || legacy === 1) {
        if (canonical !== 1 || legacy !== 1) {
            await syncAiCreditExhaustionStatus(cache, channelID, true);
        }
        return true;
    }

    const cached = await cache.get(`twitch:${channelID}:ai:credits`);
    if (!cached) return false;
    try {
        const parsed = JSON.parse(cached) as Partial<AiCreditsData>;
        const exhausted = parsed.status === 'exhausted'
            || (parsed.available === true && typeof parsed.balance === 'number' && parsed.balance <= 0);
        if (exhausted) await syncAiCreditExhaustionStatus(cache, channelID, true);
        return exhausted;
    } catch {
        return false;
    }
}