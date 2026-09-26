import { randomUUID } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import type { ExecutionContext, RootNode } from './ast_parser/types.js';
import { snapshotTimerContext, TIMER_GRACE_MS, type TimerContext } from './ast_parser/timer.js';

export const AST_TIMER_INDEX = 'ast:timers:pending';
const JOB_PREFIX = 'ast:timers:job:';
const CHANNEL_PREFIX = 'ast:timers:channel:';
const MAX_CHANNEL_TIMERS = 100;
const MAX_PENDING_TIMERS = 10000;
const MAX_JOB_BYTES = 64 * 1024;
const RECONCILE_MS = 2000;
type Redis = Awaited<ReturnType<typeof getDragonflyClient>>;

export interface AstTimerJob {
    version: 1;
    id: string;
    dueAt: number;
    expiresAt: number;
    body: RootNode;
    context: TimerContext;
}

// Store the job and both indexes together. Index scores allow stale entries
// to be pruned even if the bot was offline when Redis expired the payload.
const ENQUEUE = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5] - ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[5])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) or redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[8]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
redis.call('PEXPIREAT', KEYS[3], redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')[2])
return 1`;

// Consume before executing: at most once, including across overlapping bot
// instances. A crash after claiming can lose an action; we never blindly retry
// an external side effect whose outcome cannot be determined.
const CLAIM = `
local raw = redis.call('GET', KEYS[1])
if not raw then redis.call('ZREM', KEYS[2], ARGV[1]); return nil end
local job = cjson.decode(raw)
if job.dueAt > tonumber(ARGV[2]) then return nil end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if job.expiresAt <= tonumber(ARGV[2]) then return nil end
return raw`;

let activeScheduler: AstTimerScheduler | undefined;

export async function scheduleAstTimer(seconds: number, body: RootNode, context: ExecutionContext): Promise<void> {
    const now = Date.now();
    const job: AstTimerJob = {
        version: 1, id: randomUUID(), dueAt: now + Math.round(seconds * 1000),
        expiresAt: now + Math.round(seconds * 1000) + TIMER_GRACE_MS,
        body, context: snapshotTimerContext(context)
    };
    const payload = JSON.stringify(job);
    if (Buffer.byteLength(payload) > MAX_JOB_BYTES) throw new Error('Timer context exceeds 64 KiB');
    const redis = await getDragonflyClient('AstTimer');
    const accepted = await redis.eval(ENQUEUE, {
        keys: [JOB_PREFIX + job.id, AST_TIMER_INDEX, CHANNEL_PREFIX + context.broadcasterId],
        arguments: [payload, job.id, String(job.dueAt), String(job.expiresAt), String(now),
            String(TIMER_GRACE_MS), String(MAX_PENDING_TIMERS), String(MAX_CHANNEL_TIMERS)]
    });
    if (accepted !== 1) throw new Error('Pending timer limit reached');
    activeScheduler?.arm(job.id, job.dueAt);
}

/** Runs inside the bot. Other parser consumers only enqueue cache jobs. */
export class AstTimerScheduler {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private interval?: ReturnType<typeof setInterval>;
    private stopped = true;
    private reconciling = false;

    constructor(
        private redis: Redis,
        private execute: (job: AstTimerJob) => Promise<void> = executeAstTimerJob
    ) {}

    async start(): Promise<void> {
        if (!this.stopped) return;
        this.stopped = false;
        await this.reconcile();
        this.interval = setInterval(() => { void this.reconcile(); }, RECONCILE_MS);
        this.interval.unref();
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.interval);
        for (const timeout of this.timers.values()) clearTimeout(timeout);
        this.timers.clear();
    }

    arm(id: string, dueAt: number): void {
        if (this.stopped || this.timers.has(id)) return;
        const timeout = setTimeout(() => { void this.fire(id); }, Math.max(0, dueAt - Date.now()));
        timeout.unref();
        this.timers.set(id, timeout);
    }

    async reconcile(): Promise<void> {
        if (this.stopped || this.reconciling) return;
        this.reconciling = true;
        try {
            await this.redis.zRemRangeByScore(AST_TIMER_INDEX, '-inf', Date.now() - TIMER_GRACE_MS);
            const pending = await this.redis.zRangeWithScores(AST_TIMER_INDEX, 0, MAX_PENDING_TIMERS - 1);
            const ids = new Set(pending.map(({ value }) => value));
            for (const [id, timeout] of this.timers) {
                if (!ids.has(id)) { clearTimeout(timeout); this.timers.delete(id); }
            }
            for (const { value: id, score: dueAt } of pending) this.arm(id, dueAt);
        } catch (error) {
            console.error('AST timer recovery failed; will retry', error);
        } finally {
            this.reconciling = false;
        }
    }

    private async fire(id: string): Promise<void> {
        try {
            if (this.stopped) return;
            // Dragonfly requires every Lua key to be declared. Read the immutable
            // envelope first to identify its channel index; CLAIM still decides
            // atomically whether this instance owns execution.
            const pending = await this.redis.get(JOB_PREFIX + id);
            if (!pending) {
                await this.redis.zRem(AST_TIMER_INDEX, id);
                return;
            }
            const channelID = (JSON.parse(pending) as AstTimerJob).context.broadcasterId;
            const raw = await this.redis.eval(CLAIM, {
                keys: [JOB_PREFIX + id, AST_TIMER_INDEX, CHANNEL_PREFIX + channelID],
                arguments: [id, String(Date.now())]
            });
            if (typeof raw !== 'string') return;
            const job = JSON.parse(raw) as AstTimerJob;
            if (job.version !== 1) throw new Error('Unsupported AST timer job version');
            await this.execute(job);
        } catch (error) {
            console.error('AST timer execution failed', { timerId: id, error });
        } finally {
            this.timers.delete(id);
        }
    }
}

export async function executeAstTimerJob(job: AstTimerJob): Promise<void> {
    const { createSpecialExecutionContext } = await import('../handlers/special_parser.handler.js');
    const { evaluate } = await import('./ast_parser/evaluator.js');
    const { deliverAstMessage } = await import('./ast_command_delivery.js');
    const saved = job.context;
    const base = await createSpecialExecutionContext({
        channelID: saved.broadcasterId, scopeType: saved.scopeType, scopeName: saved.scopeName,
        scopeAliases: saved.scopeAliases, eventData: {
            ...saved.eventData, chatter_user_id: saved.userId,
            chatter_user_login: saved.userLogin, chatter_user_name: saved.userDisplayName
        }, eventsubData: saved.eventsubData, userPlan: saved.userPlan, userLevel: saved.userLevel,
        argument: saved.argument, count: saved.count, extraContext: saved.extraContext
    });
    const context: ExecutionContext = {
        ...base, ...saved, variables: new Map(saved.variables), arrays: new Map(saved.arrays),
        loopVars: new Map(saved.loopVars), visitedCommands: new Set(saved.visitedCommands)
    };
    const result = await evaluate(job.body, context);
    const sent = await deliverAstMessage(saved.broadcasterId, {
        parsedText: String(result.value ?? ''), commandReferences: result.context.commandReferences
    });
    if (sent.error) throw new Error(sent.message);
}

export async function startAstTimerScheduler(): Promise<void> {
    if (activeScheduler) return;
    activeScheduler = new AstTimerScheduler(await getDragonflyClient('AstTimerScheduler'));
    await activeScheduler.start();
    console.log('AST timer scheduler started (cache recovery, 10-minute grace)');
}
