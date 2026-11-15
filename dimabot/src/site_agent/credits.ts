/**
 * AI-credit pricing and charging for tool calls (site assistant and MCP share the tool registry).
 *
 * Flow for a priced call (MCP `executeMcpToolCall`): `reserveToolCredits` before running the tool,
 * `settleToolCredits` on billable success, `releaseToolCredits` otherwise.
 * - Reserve: one Lua script holds the price against the cached balance (`twitch:<ch>:ai:credits`, the same
 *   snapshot every AI feature reads) minus this channel's pending holds (`mcp:credits:holds:<ch>`, a hash of
 *   operationId → "<credits>:<expiresAtMs>"; expired holds are pruned in the script, so a crashed call frees
 *   itself after TOOL_CREDIT_HOLD_TTL_MS).
 * - Settle: charges through `ingestPolarSHEvent` (event `ai_usage`, reason `mcp_tool`, externalId
 *   `mcp_tool:<operationId>`), which also debits the local projection, writes the usage receipt and sets the
 *   exhaustion markers, exactly as every other AI feature. The hold is dropped only once Polar accepted the
 *   event or it is in the durable queue; otherwise it stays until it expires and the failure is logged.
 * 1 credit = $0.00001 = 0.001 cents.
 */
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { AI_CREDITS_CACHE_SCHEMA_VERSION, getAiCredits } from '../utils/billing.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { error, warn } from '../utils/logger.js';
import { ingestPolarSHEvent } from '../utils/polarsh.js';
import type { ToolKind } from './types.js';

export type ToolSurface = 'site' | 'mcp';

/** MCP price per tool kind. Docs/knowledge and UI tools are free; anything that reads channel data, writes or acts costs. */
export const TOOL_KIND_PRICES: Readonly<Record<ToolKind, number>> = Object.freeze({ knowledge: 0, ui: 0, read: 1, write: 1, stream: 1 });

/** MCP prices by tool name that differ from the kind price. The ONE place to change a single tool's price. */
export const PRICE_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
    // OWNER QUESTION (open, 2026-11-14): is undoing a change free or 1 credit? Free until the owner decides.
    undo_change: 0,
    // Reading the balance is free so a channel that is out of credits can still see that (lead decision 2026-11-14; owner may change).
    get_ai_credits: 0,
});

for (const [name, price] of Object.entries({ ...TOOL_KIND_PRICES, ...PRICE_OVERRIDES })) {
    if (!Number.isSafeInteger(price) || price < 0) throw new Error(`credits: price of ${name} must be an integer >= 0`);
}

/** Credits one successful call costs on a surface. 0 = free (no reservation, no charge). The site assistant is always free. */
export function toolPrice(tool: { name: string; kind: ToolKind }, surface: ToolSurface): number {
    if (surface === 'site') return 0;
    if (Object.hasOwn(PRICE_OVERRIDES, tool.name)) return PRICE_OVERRIDES[tool.name];
    // An unknown kind (a newer registry than this table) is treated as an acting tool, never as free.
    return TOOL_KIND_PRICES[tool.kind] ?? 1;
}

/**
 * `credits_exhausted`: out of credits. `credits_busy`: too many priced calls in flight on the channel (they waited
 * TOOL_CREDIT_BUSY_WAIT_MS). `credits_not_set_up`: the channel has no billing customer yet. `credits_unavailable`:
 * the balance could not be read (Dragonfly/Polar trouble, a duplicate operation id).
 */
export type CreditErrorCode = 'credits_exhausted' | 'credits_busy' | 'credits_not_set_up' | 'credits_unavailable';

export class CreditError extends Error {
    constructor(public readonly code: CreditErrorCode) { super(code); }
}

export interface CreditReservation {
    channelId: string;
    credits: number;
    /** Server-generated id of this one tool call; the billing idempotency key. */
    operationId: string;
}

export const TOOL_CREDIT_HOLD_TTL_MS = 10 * 60_000;
/** Priced calls in flight per channel. AI apps run tool calls in parallel; past this they wait, then get `credits_busy`. */
export const TOOL_CREDIT_MAX_HOLDS = 24;
/** How long a reservation waits for a free hold slot when the channel is at TOOL_CREDIT_MAX_HOLDS. */
export const TOOL_CREDIT_BUSY_WAIT_MS = 5000;
const BUSY_RETRY_MS = 150;
const BALANCE_LOAD_TIMEOUT_MS = 3000;
const CACHE_CALLER = 'site-agent-credits';

export const toolCreditHoldsKey = (channelId: string) => `mcp:credits:holds:${channelId}`;
export const toolCreditExternalId = (operationId: string) => `mcp_tool:${operationId}`;

type HoldResult = 'ok' | 'duplicate' | 'exhausted' | 'unknown' | 'busy';

/**
 * KEYS: credits snapshot, canonical exhaust marker, legacy exhaust marker, holds hash.
 * ARGV: operationId, credits, nowMs, expiresAtMs, cache schema version, max holds, hold ttl ms.
 * Order: duplicate → exhaustion markers → unknown snapshot → hold cap → balance minus holds.
 */
export const RESERVE_TOOL_CREDITS_SCRIPT = `
local now = tonumber(ARGV[3])
local entries = redis.call('HGETALL', KEYS[4])
local held, count, duplicate = 0, 0, false
for i = 1, #entries, 2 do
    local credits, expires = string.match(entries[i + 1], '^(%d+):(%d+)$')
    if not credits or tonumber(expires) <= now then
        redis.call('HDEL', KEYS[4], entries[i])
    else
        if entries[i] == ARGV[1] then duplicate = true end
        held = held + tonumber(credits)
        count = count + 1
    end
end
if duplicate then return 'duplicate' end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 'exhausted' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'unknown' end
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' or tonumber(data.version) ~= tonumber(ARGV[5]) or data.available ~= true then return 'unknown' end
local balance = tonumber(data.balance)
if not balance then return 'unknown' end
if count >= tonumber(ARGV[6]) then return 'busy' end
if data.status == 'exhausted' or balance - held < tonumber(ARGV[2]) then return 'exhausted' end
redis.call('HSET', KEYS[4], ARGV[1], ARGV[2] .. ':' .. ARGV[4])
redis.call('PEXPIRE', KEYS[4], ARGV[7])
return 'ok'
`;

/**
 * Price in cents for the generic `ai_usage` branch of `ingestPolarSHEvent`, which bills ceil(cost × 1000) credits.
 * credits / 1000 can land one ulp high (731 of the prices 1…100000, the first 2007, would bill one credit more), so
 * this steps down to the nearest double that bills exactly `credits`.
 */
export function polarCentsForCredits(credits: number): number {
    let cents = credits / 1000;
    const bits = new DataView(new ArrayBuffer(8));
    for (let step = 0; Math.ceil(cents * 1000) > credits; step++) {
        if (step === 8) throw new Error(`credits: no Polar cost bills exactly ${credits} credits`);
        bits.setFloat64(0, cents);
        bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
        cents = bits.getFloat64(0);
    }
    return cents;
}

function assertReservation(channelId: unknown, credits: unknown, operationId: unknown): void {
    if (typeof channelId !== 'string' || !/^[\w-]{1,64}$/.test(channelId)) throw new TypeError('credits: invalid channelId');
    if (typeof operationId !== 'string' || !/^[\w.:-]{1,128}$/.test(operationId)) throw new TypeError('credits: invalid operationId');
    if (!Number.isSafeInteger(credits) || (credits as number) < 0) throw new TypeError('credits: credits must be an integer >= 0');
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function log(level: 'warn' | 'error', fn: string, channelId: string, data: Record<string, unknown>): void {
    void (level === 'error' ? error : warn)({ function: `siteAgent.credits.${fn}`, ...data }, { channelId, destination: 'both' }).catch(() => undefined);
}

/** The paying user: the owner of the channel's Twitch account, found the way billing finds it. */
async function findChannelOwner(channelId: string): Promise<Pick<IUsers, 'plan_tier' | 'polar_sh_customer_id'> | null> {
    return UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelId } } })
        .select('plan_tier polar_sh_customer_id').maxTimeMS(2000).lean<Pick<IUsers, 'plan_tier' | 'polar_sh_customer_id'> | null>().exec();
}

async function tryHold(cache: Awaited<ReturnType<typeof getDragonflyClient>>, { channelId, credits, operationId }: CreditReservation): Promise<HoldResult> {
    const now = Date.now();
    return String(await cache.eval(RESERVE_TOOL_CREDITS_SCRIPT, {
        keys: [`twitch:${channelId}:ai:credits`, `twitch:${channelId}:ai:exhaust`, `${channelId}:ai:exhaust`, toolCreditHoldsKey(channelId)],
        arguments: [operationId, String(credits), String(now), String(now + TOOL_CREDIT_HOLD_TTL_MS),
            String(AI_CREDITS_CACHE_SCHEMA_VERSION), String(TOOL_CREDIT_MAX_HOLDS), String(TOOL_CREDIT_HOLD_TTL_MS)]
    })) as HoldResult;
}

/**
 * Atomically holds `credits` against the channel's balance. Throws CreditError when the balance is short or unknown
 * (codes: see CreditErrorCode). While TOOL_CREDIT_MAX_HOLDS calls are in flight it waits up to
 * TOOL_CREDIT_BUSY_WAIT_MS for one to finish (`signal` stops the wait). 0 credits returns a reservation without
 * holding anything.
 */
export async function reserveToolCredits(channelId: string, credits: number, operationId: string, signal?: AbortSignal): Promise<CreditReservation> {
    assertReservation(channelId, credits, operationId);
    const reservation: CreditReservation = { channelId, credits, operationId };
    if (credits === 0) return reservation;
    let result: HoldResult;
    let notSetUp = false;
    try {
        const cache = await getDragonflyClient(CACHE_CALLER);
        result = await tryHold(cache, reservation);
        if (result === 'unknown') {
            // No usable snapshot: load it once (Polar state → cache), then try again.
            const owner = await findChannelOwner(channelId);
            if (owner?.polar_sh_customer_id) {
                await getAiCredits(owner, channelId, { requireVerified: true, signal: AbortSignal.timeout(BALANCE_LOAD_TIMEOUT_MS) });
                result = await tryHold(cache, reservation);
            } else notSetUp = true;
        }
        const deadline = Date.now() + TOOL_CREDIT_BUSY_WAIT_MS;
        while (result === 'busy' && Date.now() < deadline && !signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
            result = await tryHold(cache, reservation);
        }
    } catch (err) {
        log('error', 'reserve', channelId, { operationId, credits, error: message(err) });
        throw new CreditError('credits_unavailable');
    }
    if (result === 'ok') return reservation;
    if (result === 'duplicate') log('error', 'reserve', channelId, { operationId, credits, error: 'duplicate operationId' });
    throw new CreditError(result === 'exhausted' ? 'credits_exhausted' : result === 'busy' ? 'credits_busy'
        : result === 'unknown' && notSetUp ? 'credits_not_set_up' : 'credits_unavailable');
}

async function dropHold({ channelId, operationId }: CreditReservation, fn: string): Promise<void> {
    try {
        await (await getDragonflyClient(CACHE_CALLER)).hDel(toolCreditHoldsKey(channelId), operationId);
    } catch (err) {
        log('warn', fn, channelId, { operationId, message: 'hold not removed; it expires by itself', error: message(err) });
    }
}

/**
 * The call succeeded: charge through the Polar AI-credit path (idempotent by operationId) and drop the hold.
 * The hold is dropped as soon as the charge is queued and projected on the local balance (before Polar is called),
 * so a call waiting on Polar never counts twice against the balance. Never throws (the tool already ran): when the
 * charge could not be accepted or durably queued, the failure is logged and the hold stays until it expires, so the
 * balance is never over-promised meanwhile.
 */
export async function settleToolCredits(reservation: CreditReservation, meta: { tool: string; surface: ToolSurface }): Promise<void> {
    const { channelId, credits, operationId } = reservation;
    if (!credits) return;
    const context = { operationId, credits, tool: meta.tool, surface: meta.surface };
    try {
        const customerId = (await findChannelOwner(channelId))?.polar_sh_customer_id;
        if (!customerId) {
            log('error', 'settle', channelId, { ...context, error: 'channel has no billing customer; call not charged' });
            return;
        }
        // `batch`: queued durably and projected locally before Polar is called, then flushed now. The local
        // projection (recordAiCreditUsage) runs inside this path; it must not be debited a second time here.
        const projected = { holdDropped: false };
        const result = await ingestPolarSHEvent({
            onProjected: async () => { projected.holdDropped = true; await dropHold(reservation, 'settle'); },
            customerId,
            channelID: channelId,
            externalId: toolCreditExternalId(operationId),
            cost: polarCentsForCredits(credits),
            reason: 'mcp_tool',
            mode: 'batch',
            usage: {
                requestId: operationId,
                category: 'ai_agent',
                operation: meta.tool,
                source: meta.surface,
                provider: 'dima',
                // A tool call has no provider bill; the credits are the price.
                receipt: { costUsd: 0 },
            },
        });
        if (result.error && !result.queued) {
            log('error', 'settle', channelId, { ...context, error: `charge failed: ${result.message ?? 'unknown'}` });
            return;
        }
        if (result.error) log('warn', 'settle', channelId, { ...context, message: `charge queued; Polar flush failed (${result.message ?? 'unknown'}), a later flush sends it` });
        if (projected.holdDropped) return;
    } catch (err) {
        log('error', 'settle', channelId, { ...context, error: `charge failed: ${message(err)}` });
        return;
    }
    await dropHold(reservation, 'settle');
}

/** The call definitely did not happen or was not billable: drop the hold without charging. Idempotent; never throws. */
export async function releaseToolCredits(reservation: CreditReservation): Promise<void> {
    if (!reservation.credits) return;
    await dropHold(reservation, 'release');
}
