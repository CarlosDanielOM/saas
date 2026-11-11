#!/usr/bin/env python3
"""Dragonfly/Redis contract ledger: scanner + hand-written contract knowledge.

Re-run from the repository root to regenerate the ledger and re-check coverage:

    python3 dima-rust/tools/ledger/dragonfly_ledger.py            # writes dima-rust/ledger/dragonfly.json
    python3 dima-rust/tools/ledger/dragonfly_ledger.py --check    # only prints coverage / unmatched call sites

Read-only against the source tree. It never connects to Redis/Dragonfly.

How it works
  1. Scans TypeScript/JS (dimabot/src, dima-analytics/src, dimadb/server) for node-redis client method
     calls and Rust (dima-rust/src) for redis-rs command construction.
  2. Maps every call site to a key pattern (KEYS below), a Lua script (LUA) or a non-key operation
     (pub/sub, connection lifecycle). Unmatched sites are printed: a non-zero unmatched count means the
     ledger is stale and must be extended before it can be called complete.
  3. Resolves the process(es) of every TypeScript file by static import reachability from the three
     dimabot entry points and every cron worker entry (an over-approximation: "can run in").
"""
import json, os, re, sys, collections, datetime
sys.dont_write_bytecode = True  # keep the tools folder free of __pycache__

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DB = os.path.join(ROOT, 'dimabot', 'src')

# ----------------------------------------------------------------------------------------------
# 1. Process reachability (dimabot)
# ----------------------------------------------------------------------------------------------
IMPORT_RE = re.compile(r'''(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]''', re.S)
CRON_WORKERS = {  # file stem -> supervisor name (dimabot/src/workers/cron.index.ts WORKERS)
    'goals': 'goals', 'duel': 'duel', 'widgets': 'widgets', 'credit_gifts': 'credit-gifts',
    'semantic_moderation': 'semantic-moderation', 'roulette-actions': 'roulette-actions',
    'follow_defense_actions': 'follow-defense-actions', 'follow_defense': 'follow-defense',
    'follow_ledger': 'follow-ledger', 'stream_analytics': 'stream-analytics', 'domain_events': 'domain-events',
    'eventsub_reconciliation': 'eventsub-reconciliation', 'free_credit_reset': 'free-credit-reset',
    'ai_usage_backfill': 'ai-usage-backfill', 'stream_memory': 'stream-memory', 'temporary_roles': 'temporary-roles',
    'timer': 'timer', 'activation-reminder': 'activation-reminder', 'vod_clip_recommender': 'vod-clip-recommender'}


def _resolve(base, spec):
    p = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    for c in (p, re.sub(r'\.js$', '.ts', p), p + '.ts', p + '/index.ts'):
        if os.path.isfile(c):
            return c
    return None


def process_map():
    graph = {}
    for dp, _, fn in os.walk(DB):
        for f in fn:
            if f.endswith(('.ts', '.mts', '.mjs', '.js')) and '.test.' not in f:
                p = os.path.join(dp, f)
                deps = set()
                for m in IMPORT_RE.finditer(open(p, encoding='utf8').read()):
                    r = _resolve(p, m.group(1) or m.group(2) or m.group(3))
                    if r:
                        deps.add(r)
                graph[p] = deps
    entries = {'api': f'{DB}/server/index.ts', 'bot': f'{DB}/bot/index.ts', 'cron:supervisor': f'{DB}/workers/cron.index.ts'}
    for stem, name in CRON_WORKERS.items():
        entries[f'cron:{name}'] = f'{DB}/workers/{stem}.worker.ts'
    for f in os.listdir(f'{DB}/scripts'):
        if f.endswith('.ts') and '.test.' not in f:
            entries['script:' + f.split('.')[0]] = f'{DB}/scripts/{f}'
    res = collections.defaultdict(set)
    for name, entry in entries.items():
        seen, stack = {entry}, [entry]
        while stack:
            for d in graph.get(stack.pop(), ()):
                if d not in seen:
                    seen.add(d); stack.append(d)
        for f in seen:
            res[os.path.relpath(f, ROOT)].add(name)
    return res


def procs_label(procs):
    procs = set(procs)
    crons = sorted(p for p in procs if p.startswith('cron:') and p != 'cron:supervisor')
    out = [p for p in ('api', 'bot') if p in procs]
    if len(crons) >= 15:
        out.append(f'cron:*({len(crons)} workers)')
    else:
        out += crons
    if 'cron:supervisor' in procs:
        out.append('cron:supervisor')
    scripts = sorted(p for p in procs if p.startswith('script:'))
    out += scripts
    return out


# ----------------------------------------------------------------------------------------------
# 2. Call-site scanners
# ----------------------------------------------------------------------------------------------
TS_METHODS = """get set setEx setNX pSetEx getDel getEx getSet mGet mSet del unlink exists expire pExpire expireAt pExpireAt ttl pTTL persist type keys scan scanIterator incr incrBy incrByFloat decr decrBy
hGet hSet hSetNX hGetAll hDel hIncrBy hIncrByFloat hExists hKeys hVals hLen hmGet
lPush rPush lPop rPop lPopCount rPopCount lRange lTrim lLen lRem lIndex lSet lMove blPop brPop rPopLPush brPopLPush blMove lPos
sAdd sRem sMembers sIsMember smIsMember sCard sPop sRandMember
zAdd zRem zRange zRangeWithScores zRangeByScore zRevRange zCard zScore zIncrBy zRank zPopMin zPopMax zRemRangeByScore zRemRangeByRank zCount
xAdd xRange xRevRange xRead xReadGroup xGroupCreate xAck xClaim xAutoClaim xPending xLen xTrim
eval evalSha sendCommand multi exec watch publish subscribe pSubscribe unsubscribe duplicate info quit destroy connect""".split()
TS_CALL = re.compile(r'([\w\]\)\?!]+)?\s*\??\.\s*(' + '|'.join(sorted(TS_METHODS, key=len, reverse=True)) + r')\s*(<[^>(]*>)?\(')
AMBIGUOUS = {'get', 'set', 'keys', 'type', 'connect', 'exec', 'multi', 'scan', 'info', 'destroy', 'quit', 'duplicate', 'subscribe',
             'publish', 'unsubscribe', 'del', 'exists', 'incr', 'expire', 'ttl', 'eval', 'lRange', 'lIndex', 'lLen', 'zRange', 'hGet',
             'sMembers', 'unlink', 'lSet', 'persist'}
RECEIVERS = {'cache', 'cacheClient', 'client', 'redis', 'multi', 'tx', 'transaction', 'pubSubManager', 'subscriber', 'publisher',
             'creditsCache', 'fresh', '))', ')', 'this', 'pipeline', 'r'}
TS_ROOTS = ['dimabot/src', 'dima-analytics/src', 'dimadb/server', 'dimafx/server/src', 'dima-hoststats/src']


def scan_ts():
    sites = []
    for root in TS_ROOTS:
        for dp, _, fn in os.walk(os.path.join(ROOT, root)):
            if 'node_modules' in dp or '/dist' in dp:
                continue
            for f in fn:
                if not re.search(r'\.(ts|mts|js|mjs)$', f) or re.search(r'\.test\.|testutil|test-helper', f):
                    continue
                p = os.path.join(dp, f)
                txt = open(p, encoding='utf8').read()
                if not re.search(r'getDragonflyClient|createClient|redis|Redis', txt):
                    continue
                lines = txt.split('\n')
                for i, l in enumerate(lines):
                    s = l.strip()
                    if s.startswith('//') or s.startswith('*'):
                        continue
                    for m in TS_CALL.finditer(l):
                        rcv, meth = (m.group(1) or '').rstrip('!?'), m.group(2)
                        if meth in AMBIGUOUS:
                            ok = rcv in RECEIVERS or rcv.lower().endswith(('cache', 'redis', 'client'))
                            if rcv == '':
                                ok = bool(re.search(r'\)\)\s*\.\s*' + meth + r'|^\s*\.' + meth, l))
                            if not ok:
                                continue
                        ctx = ' '.join(x.strip() for x in lines[i:i + 4])
                        sites.append(dict(file=os.path.relpath(p, ROOT), line=i + 1, method=meth, recv=rcv, text=s, ctx=ctx, lang='ts'))
    return sites


RS_CMD = re.compile(r'redis::cmd\("([A-Z]+)"\)|\.cmd\("([A-Z]+)"\)|\b(\w+)\.invoke_async\(|\.key\(self\.key\(|^\s*(eval)(?:::<\w+>)?\(')


def scan_rs():
    sites = []
    for dp, _, fn in os.walk(os.path.join(ROOT, 'dima-rust', 'src')):
        for f in fn:
            if not f.endswith('.rs') or f == 'tests.rs' or f == 'test_http.rs':
                continue
            p = os.path.join(dp, f)
            lines = open(p, encoding='utf8').read().split('\n')
            # stop at the unit-test module
            end = next((i for i, l in enumerate(lines) if l.strip() == '#[cfg(test)]'), len(lines))
            for i, l in enumerate(lines[:end]):
                for m in RS_CMD.finditer(l):
                    meth = m.group(1) or m.group(2) or ('invoke' if m.group(3) else ('EVAL' if m.group(4) else 'script-key'))
                    ctx = ' '.join(x.strip() for x in lines[i:i + 8])
                    sites.append(dict(file=os.path.relpath(p, ROOT), line=i + 1, method=meth, recv='', text=l.strip(), ctx=ctx, lang='rs'))
    return sites


# Process labels for files outside dimabot.
def file_procs(f, pmap):
    if f.startswith('dimabot/'):
        return procs_label(pmap.get(f, set())) or ['unreachable (no entry point imports it)']
    if f.startswith('dima-analytics/'):
        return ['dima-analytics']
    if f.startswith('dimadb/'):
        return ['dimadb (operator console, arbitrary keys)']
    rust_bins = {
        'dima-rust/src/workers/ai_usage_receipts': 'rust:ai-usage-receipts',
        'dima-rust/src/bin/ai_usage_receipts.rs': 'rust:ai-usage-receipts',
        'dima-rust/src/workers/follow_defense_baseline.rs': 'rust:follow-defense-baseline',
        'dima-rust/src/workers/raid_sessions': 'rust:raid-sessions',
        'dima-rust/src/bin/raid_sessions.rs': 'rust:raid-sessions',
        'dima-rust/src/workers/dashboard_emote_catalog.rs': 'rust:dashboard-activity',
        'dima-rust/src/supervisor/telemetry.rs': 'rust:cron-index (supervisor telemetry)',
        'dima-rust/src/utils/redis.rs': 'rust:all redis-feature workers (connection bootstrap)',
    }
    for prefix, label in rust_bins.items():
        if f.startswith(prefix):
            return [label]
    if f.startswith('dima-rust/src/utils/'):
        mod = f.split('/')[3].replace('.rs', '')
        return [f'rust-lib:{mod} (library only, not wired into any deployed binary)']
    return ['?']


WRITE_METHODS = {'set', 'setEx', 'getDel', 'del', 'unlink', 'expire', 'pExpire', 'persist', 'incr', 'incrBy', 'hSet', 'hSetNX', 'hDel',
                 'hIncrBy', 'lPush', 'rPush', 'lTrim', 'lRem', 'lPop', 'lPopCount', 'rPopLPush', 'blPop', 'lMove', 'sAdd', 'sRem', 'zAdd',
                 'zRem', 'zPopMin', 'zRemRangeByScore', 'xAdd', 'lSet',
                 'SET', 'DEL', 'RPUSH', 'INCR', 'HSET', 'ZADD'}
READ_METHODS = {'get', 'mGet', 'exists', 'ttl', 'pTTL', 'type', 'keys', 'scan', 'scanIterator', 'hGet', 'hGetAll', 'lRange', 'lLen',
                'lIndex', 'sMembers', 'sIsMember', 'zRange', 'zRangeWithScores', 'zRangeByScore', 'zCard', 'zRank', 'xRange', 'xRevRange',
                'GET', 'LLEN', 'LINDEX', 'HGETALL', 'HMGET', 'EXISTS', 'ZRANGE', 'BLPOP'}
BOTH = {'getDel', 'blPop', 'lMove', 'lPopCount', 'lPop', 'rPopLPush', 'zPopMin', 'BLPOP'}


# ----------------------------------------------------------------------------------------------
# 3. Contract knowledge: key patterns
# ----------------------------------------------------------------------------------------------
# K(id, pattern, type, value encoding, ttl, match-regexes, files=None, notes='')
# A site is assigned to the first key whose regex matches the call line (or, failing that, its 4-line context)
# and whose `files` filter (substring list) contains the file.
KEYS = []


def K(id, pattern, type, value, ttl, match, files=None, notes='', byte=None, shared_hint=None):
    KEYS.append(dict(id=id, pattern=pattern, type=type, value=value, ttl=ttl, match=match, files=files, notes=notes,
                     byteSensitive=byte))


JSON_NOTE = 'JSON.stringify output (UTF-8, no whitespace, insertion-ordered keys, undefined fields omitted)'

# --- accounts / tokens / plan fence ------------------------------------------------------------
K('accounts.data', 'accounts:{platform}:{channelId}:data', 'hash',
  'Hash of strings (IUsersCache): id, name, email, plan_tier (free|premium|pro), plan_tier_until (JS Date.toDateString(), e.g. "Wed Nov 11 2026", or ""), '
  'polar_sh_customer_id, refresh_token / access_token (decrypted plaintext Twitch tokens), expires_at (unix seconds as decimal string), '
  'actived / chat_enabled / has_permissions / up_to_date_permissions ("true"|"false"), __polar_plan_version (plan fence version, see byteSensitive). '
  'platform is "twitch" except the legacy read in getAccountRefreshTokenById(account_type="kick"). Only string-valued fields are written (sanitizeCachePayload).',
  'none',
  [r'accounts:\$\{(account_type|twitchAccount)', r'accounts:twitch:', r'\b(dataKey)\b', r'hGet\(cacheKey, .expires_at', r'cache\.del\(batch\)',
   r'hGetAll\(key\) as unknown as VersionedAccount'],
  files=['twitch_streamers.class.ts', 'tokens.ts', 'auth.route.ts', 'user.route.ts', 'revocation.handler.ts', 'channel-names.mjs',
         'invalidate_all_user_permissions', 'twitch_tokens/adapters.rs', 'twitch_streamers/adapters.rs', 'polar_billing_events.ts'],
  notes='Writers: TwitchStreamers WRITE_PLAN_ACCOUNT_SCRIPT (fenced HSET), tokens.ts (HSET token fields), auth/user routes, revocation handler. '
        'Readers: every process that needs a channel token or plan (TwitchStreamers.getTwitchAccountById/getAccountTokenById), dima-analytics (name field, MULTI pipeline). '
        'INVALIDATE_PLAN_SCRIPT deletes it. Also enumerated with KEYS accounts:twitch:*:data.')
K('twitch.accounts', 'twitch:accounts', 'string', 'JSON array of VersionedAccount objects (each is an HGETALL object of accounts:twitch:{id}:data, so field order = server HGETALL order) — published by CHECK_PLAN_ACCOUNTS_SCRIPT', 'EX 3600 (set inside CHECK_PLAN_ACCOUNTS_SCRIPT)',
  [r"'twitch:accounts'", r'"twitch:accounts"', r'ACCOUNTS_CACHE_KEY'])
K('streamers.by.id', 'streamers:by:id', 'set', 'members = Twitch channel IDs (decimal strings)', 'none', [r'streamers:by:id', r'\bMEMBERS\b'])
K('streamers.by.name', 'streamers:by:name', 'set', 'legacy: members = account names; no current SADD writer (only SREM/DEL)', 'none', [r'streamers:by:name'])
K('locks.refresh', 'locks:refresh:{platform}:{channelId}', 'string', 'lock owner = randomUUID()', 'PX 5000 (SET NX PX)', [r'lockKey', r'locks:refresh'],
  files=['twitch_streamers.class.ts', 'twitch_tokens'])
K('plan.fence', 'twitch:{channelId}:ai:credits:plan-version', 'string',
  'plan version = String(polar_plan_event_at ms).padStart(13,"0") + ":" + polar_plan_event_key; compared with Lua string ">"', 'none (persistent monotonic fence)',
  [r'planCacheFenceKey', r'ai:credits:plan-version'])
K('app.token', 'app:{platform}:token', 'string', 'Twitch app access token (plain)', 'EX expires_in from Twitch (Number(...))',
  [r'app:\$\{platform\}:token', r'app:twitch:token'])
K('app.bot', 'app:twitch:bot', 'hash', 'field access_token = bot user access token', 'none', [r"app:twitch:bot"])
K('auth.token', 'token:{twitchUserAccessToken}', 'hash', 'fields id, login, display_name, profile_image_url (Twitch /users)', 'EX 14000 (separate EXPIRE after HSET)',
  [r'CACHE_KEY_PREFIX', r'cacheKey', r'token:\$\{token\}'], files=['auth.middleware.ts:12', 'auth.middleware.ts:13', 'auth.middleware.ts:16', 'auth.middleware.ts:17', 'validation.route.ts', 'dima-analytics/src/index.mjs'],
  notes='Key embeds the raw user OAuth token (secret). Shared: api writes, dima-analytics reads.')
K('auth.activity', 'twitch:{twitchUserId}:last_app_activity_touch', 'string', '"1"', 'EX 86400 (separate EXPIRE)', [r'last_app_activity_touch', r'cacheKey'], files=['auth.middleware.ts'])

# --- credits / billing -------------------------------------------------------------------------
K('ai.credits', 'twitch:{channelId}:ai:credits', 'string',
  'JSON AiCreditsData {version:3, used, limit, balance, meterId, updatedAt (ISO), available, status ("available"|"exhausted"|"unavailable"), __polar_plan_version?}. '
  'Re-encoded by Lua cjson.encode in APPLY_AI_CREDIT_USAGE_SCRIPT (key order not preserved, "/" escaped as "\\/", numbers via %.14g).',
  'EX 300 (ACCEPT_PLAN_CREDITS_SCRIPT, SYNC_CREDITS_SCRIPT, admin_site.route) or EX 2678400 (31 d, APPLY_AI_CREDIT_USAGE_SCRIPT rewrite)',
  [r'ai:credits`', r"ai:credits'", r'\bcacheKey\b'], files=['billing.ts', 'admin_site.route.ts', 'credit_gifts.ts', 'free_credit_reset.worker.ts'])
K('ai.exhaust', 'twitch:{channelId}:ai:exhaust', 'string', '"true"', 'none', [r'twitch:\$\{\w+(\.id)?\}:ai:exhaust', r'exhaustKeys', r'keys\.map\(\(key\) => cache\.(set|del)'])
K('ai.exhaust.legacy', '{channelId}:ai:exhaust', 'string', '"true" (legacy mirror kept in sync with twitch:{id}:ai:exhaust)', 'none', [r'`\$\{\w+(\.id)?\}:ai:exhaust'])
K('ai.usage.local', 'twitch:{channelId}:ai:usage-local:{sha256hex(externalId)|"untracked"}', 'string', '"1" idempotency marker', 'EX 2678400 (SET NX EX in APPLY_AI_CREDIT_USAGE_SCRIPT)', [r'ai:usage-local'])
K('ai.credits.polar', 'twitch:{channelId}:ai:credits:polar-version', 'string', 'String(occurredAt ms).padStart(13,"0") + ":" + eventKey; Lua string ">" ordering', 'none', [r'polar-version'])
K('billing.packctx', 'billing:credit-packs:context:v1:{sha256hex(customerId)[0:20]}', 'string', 'JSON {planTier, expiresAt, version:1}', 'EX max(1, min(120, seconds until expiresAt))',
  [r'creditPackBillingContextCacheKey'])
K('ai.polarshevent', 'twitch:{channelId}:ai:polarshevent', 'list', 'elements = JSON Polar ingest events (legacy: a single JSON-array string, migrated on access via TYPE check)', 'none',
  [r'cacheKey'], files=['polarsh.ts'])
K('locks.polar', 'locks:polar-ingest:{channelId}', 'string', 'lock owner randomUUID()', 'PX 8000 (SET NX PX)', [r'lockKey'], files=['polarsh.ts'])
K('ai.receipts.generation', 'twitch:{channelId}:ai:usage-receipts:generation', 'string', 'integer counter (INCR), "0" assumed when absent', 'none',
  [r'usage-receipts:generation', r'"INCR"'])
K('ai.receipts.cache', 'twitch:{channelId}:ai:usage-receipts:v2:{generation}:{sha256hex(customerId)[0:16]}:{sha256hex(timeZone)[0:12]}:{sha256hex(startISO|endISO)[0:12]}:{from}:{to}',
  'string', 'JSON array of AI usage transactions', 'EX 120', [r'\bcacheKey\b'], files=['ai_usage_receipts.ts'])
K('locks.aiusage', 'locks:ai-usage-write:{sha256hex(JSON.stringify([channelId, customerId]))}', 'string', 'lock owner (TS randomUUID(); Rust "{pid}-{ms}-{objectid}")', 'EX 120, renewed every 30 s',
  [r'\bkey\b'], files=['ai_usage_lock.ts'])

# --- AI usage queues ---------------------------------------------------------------------------
K('q.receipts', 'cron:ai-usage-receipts:queue', 'list', 'JSON AI usage receipt + enqueuedAt (ISO) appended last', 'none', [r'AI_USAGE_RECEIPT_QUEUE_KEY', r'cron:ai-usage-receipts:queue\b'])
K('q.receipts.processing', 'cron:ai-usage-receipts:processing', 'list', 'raw queue elements (byte-identical copies)', 'none', [r'cron:ai-usage-receipts:processing'])
K('q.receipts.dead', 'cron:ai-usage-receipts:queue:dead', 'list', 'raw queue elements', 'none', [r'cron:ai-usage-receipts:queue:dead'])
K('q.receipts.attempts', 'cron:ai-usage-receipts:queue:attempts:{sha256hex(raw element)}', 'string', 'integer attempt counter', 'EX 604800 (inside Lua)', [r'NEVER'])
K('q.backfills', 'cron:ai-usage-backfills:queue', 'list', 'JSON AiUsageBackfillJob {id, channelID, customerId, planTier, coverageStart, requestedAt, reason, attempts, dedupeKey}', 'none',
  [r'AI_USAGE_BACKFILL_QUEUE_KEY', r'cron:ai-usage-backfills:queue"'])
K('q.backfills.processing', 'cron:ai-usage-backfills:processing', 'list', 'raw queue elements', 'none', [r'AI_USAGE_BACKFILL_PROCESSING_KEY', r'cron:ai-usage-backfills:processing'])
K('q.backfills.dead', 'cron:ai-usage-backfills:dead', 'list', 'raw queue elements', 'none', [r'AI_USAGE_BACKFILL_DEAD_KEY', r'cron:ai-usage-backfills:dead'])
K('q.backfills.attempts', 'cron:ai-usage-backfills:queue:attempts:{sha256hex(raw element)}', 'string', 'integer attempt counter', 'EX 604800 (inside Lua)', [r'NEVER'])
K('q.backfills.dedupe', 'cron:ai-usage-backfills:dedupe:v{AI_USAGE_REPORT_VERSION}:{channelId}:{customerId}', 'string', 'job.id (owner token, released by owner-checked Lua DEL)',
  'EX AI_USAGE_BACKFILL_DEDUPE_SECONDS (default 172800, min 300)', [r'job\.dedupeKey'], files=['ai_usage_backfill.worker.ts'])
K('aiusage.health', 'ai-usage:queue-health:{receipts|backfills}', 'hash', 'fields processingSince (ms), failures (int, HINCRBY), pendingSince (ms), observedFailures (int). '
  'Rust writes pendingSince/observedFailures with f64 Display (integral → no ".0")', 'none', [r'\(key[,)]', r'"HGETALL"', r'"HSET"'], files=['ai_usage_queue_health.ts', 'ai_usage_receipts/queue.rs'])
K('aiusage.health.snapshot', 'ai-usage:queue-health:{name}:snapshot', 'string', 'JSON status {queue,pending,processing,dead,oldestAgeSeconds,processingAgeSeconds,failures,reasons,checkedAt}', 'EX 300',
  [r':snapshot'])
K('aiusage.health.alert', 'ai-usage:queue-health:{name}:alert', 'string', '"1"', 'EX 300 (SET NX)', [r':alert'])
K('lock.backfill.consumer', 'worker:ai-usage-backfill:consumer', 'string', 'owner "{pid}-{ms}"', 'EX 120, renewed 30 s', [r'consumerKey'])
K('lock.backfill.sweep', 'worker:ai-usage-backfill:daily-sweep', 'string', 'owner "{pid}-{ms}"', 'EX AI_USAGE_BACKFILL_SWEEP_LOCK_SECONDS (default 86400)', [r'SWEEP_LOCK_KEY'])
K('lock.receipts', 'worker:ai-usage-receipts:lock (env AI_USAGE_RECEIPTS_LOCK_KEY)', 'string', 'owner "{pid}-{ms}-{objectid}"', 'EX lock_ttl_seconds (default 300), renewed', [r'NEVER'])

# --- cron job queues ---------------------------------------------------------------------------
K('q.cronjobs', 'cron:jobs:queue', 'list', 'JSON CronQueueJob {id, job, requestedAt, requestedBy?, userID?, accountID?, channelID?, data?, dedupeKey?} (serializeCronQueueJob = JSON.stringify)', 'none',
  [r'CRON_JOBS_QUEUE_KEY', r'\bqueueKey\b'], files=['cron_jobs_queue.ts', 'follow_ledger.worker.ts', 'cron_queue.rs'])
K('q.cronjobs.dead', 'cron:jobs:dead-letter', 'list', 'JSON CronQueueJob', 'none', [r'CRON_JOBS_DEAD_LETTER_KEY'])
K('cronjobs.dedupe', 'cron:jobs:dedupe:{dedupeToken}', 'string', '"1"', 'EX dedupeSeconds (default CRON_JOBS_DEDUPE_SECONDS=900, min 60)', [r'clearCronJobDedupeByKey|client\.del\(key\)'], files=['cron_jobs_queue.ts'])
K('cronjobs.accepted', 'cron:jobs:accepted:{job}:{channelId}:{sessionId}', 'string', '"1" permanent one-shot acceptance marker', 'none',
  [r'cron:jobs:accepted', r'acceptanceKey'])
K('q.memory', 'cron:stream-memory:queue', 'list', 'JSON CronQueueJob (from Mongo intent payload when republished)', 'none', [r'STREAM_MEMORY_QUEUE_KEY'])
K('q.memory.processing', 'cron:stream-memory:processing', 'list', 'raw queue elements', 'none', [r'MEMORY_PROCESSING_KEY'])
K('q.memory.dead', 'cron:stream-memory:dead-letter', 'list', 'JSON CronQueueJob', 'none', [r'STREAM_MEMORY_DEAD_LETTER_KEY'])
K('q.clips', 'cron:clip-recommendations:queue', 'list', 'JSON CronQueueJob', 'none', [r'CLIP_RECOMMENDATIONS_QUEUE_KEY'])
K('q.clips.processing', 'cron:clip-recommendations:processing', 'list', 'raw queue elements', 'none', [r'CLIP_RECOMMENDATIONS_PROCESSING_KEY'])
K('q.clips.dead', 'cron:clip-recommendations:dead-letter', 'list', 'JSON dead-letter payload', 'none', [r'CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY'])
K('lock.memory', 'worker:stream-memory:lock (env STREAM_MEMORY_WORKER_LOCK_KEY)', 'string', 'owner id', 'EX 900 default (min 120)', [r'LOCK_KEY'], files=['stream_memory.worker.ts'])
K('lock.memory.channel', 'cron:stream-memory:running:{channelId} (prefix env STREAM_MEMORY_CHANNEL_LOCK_PREFIX)', 'string', '"{workerOwner}:{claimToken}"', 'EX 1200 default (min 60), renewed by Lua',
  [r'lockKey|getChannelLockKey'], files=['stream_memory.worker.ts'])
K('lock.clips', 'worker:clip-recommendations:lock (env CLIP_RECOMMENDATIONS_WORKER_LOCK_KEY)', 'string', 'owner id', 'EX 1800 default (min 120), renewed by Lua', [r'LOCK_KEY'], files=['vod_clip_recommender.worker.ts'])
K('lock.ledger', 'worker:follow-ledger:daily:lock', 'string', 'runId', 'EX FOLLOW_LEDGER_LOCK_TTL_SECONDS (default 86400)', [r'LOCK_KEY'], files=['follow_ledger.worker.ts'])
K('lock.ledger.channel', 'cron:follow-ledger:running:{channelId}', 'string', 'JSON {reason, at(ISO)}', 'EX FOLLOW_LEDGER_CHANNEL_LOCK_SECONDS (default 3600, min 300)', [r'lockKey|getChannelLockKey'], files=['follow_ledger.worker.ts'])
for stem, name, ttl in [('activation-reminder', 'activation-reminder', '3600'), ('eventsub_reconciliation', 'eventsub-reconciliation', '10800'),
                        ('follow_defense', 'follow-defense', '120'), ('free_credit_reset', 'free-credit-reset', '1800'),
                        ('stream_analytics', 'stream-analytics', '900'), ('temporary_roles', 'temporary-roles', '900'), ('timer', 'timer', '900')]:
    K(f'lock.{name}', f'worker:{name}:lock (env override)', 'string', 'owner id', f'EX {ttl} default (SET NX EX; refreshed by GET+EXPIRE or Lua)', [r'LOCK_KEY'], files=[f'workers/{stem}.worker.ts'])

# --- observability -----------------------------------------------------------------------------
K('obs.inbox', 'observability:v1:inbox', 'list', 'JSON telemetry batch {version:1,id,service,instance,at,metrics[],spans[],logs[]} ≤256000 bytes', 'EXPIRE 3600 on every push; LTRIM 0 99',
  [r'TELEMETRY_INBOX', r"observability:v1:inbox"])
K('obs.overflow', 'observability:v1:overflow', 'string', 'integer count of dropped batches (INCRBY)', 'none', [r'observability:v1:overflow'])
K('obs.processing', 'observability:v1:processing', 'list', 'raw inbox batch being ingested (one consumer)', 'none', [r'observability:v1:processing'])
K('obs.identity', 'observability:v1:identity:{sha256hex(bearer token)}', 'string', 'JSON {id, login}', 'EX clamp(expires_in,1,60)', [r'observability:v1:identity'])
K('obs.infra', 'observability:v1:infra:latest', 'string', 'JSON {receivedAt, snapshot}', 'EX 300', [r'INFRA_KEY'])
K('logger', 'logger:{platform}:{channelId|"global"}:{level}:{epochMs}-{suffix}', 'string',
  'JSON {data, timestamp (toLocaleString en-US UTC), level, platform, channelId?}; suffix: TS 4 base36 chars, Rust 24-hex ObjectId', 'EX 604800 (TS: separate EXPIRE after SET; Rust: SET EX)',
  [r'client\.(set|expire)\(key', r'"SET"'], files=['utils/logger.ts', 'logger/redis.rs', 'ai_usage_receipts/queue.rs:22'])
for k, pat in [('runtime:latest', 'KEY_RUNTIME_LATEST'), ('runtime:history', 'KEY_RUNTIME_HISTORY')]:
    pass
K('metrics.runtime.latest', '{BOT_METRICS_PREFIX=metrics:bot}:runtime:latest', 'string', 'JSON runtime snapshot', 'EX BOT_METRICS_TTL_SECONDS (default 172800)', [r'KEY_RUNTIME_LATEST'])
K('metrics.runtime.history', 'metrics:bot:runtime:history', 'list', 'JSON runtime snapshots, newest first', 'LTRIM 0 HISTORY_LIMIT-1 (default 5760); EX 172800', [r'KEY_RUNTIME_HISTORY'])
K('metrics.runtime.cumulative.bytype', 'metrics:bot:runtime:cumulative:eventsubByType', 'hash', 'field = EventSub type, value = integer (HINCRBY)', 'EX 172800', [r'KEY_RUNTIME_CUMULATIVE\}:eventsubByType'])
K('metrics.runtime.cumulative', 'metrics:bot:runtime:cumulative', 'hash', 'integer counters (HINCRBY) + updatedAt ISO + max* gauges as decimal strings', 'EX 172800', [r'KEY_RUNTIME_CUMULATIVE'])
K('metrics.eventsub.minute', 'metrics:bot:eventsub:minute:{yyyyMMddHHmm UTC}', 'hash', 'total + per-type integer counters', 'EX 172800', [r'\bminuteKey\b'], files=['bot_runtime_metrics.ts:54', 'bot_runtime_metrics.ts:55'])
K('metrics.runtime.minute', 'metrics:bot:runtime:minute:{yyyyMMddHHmm UTC}', 'hash', 'integer counters (messageHandlersStarted, ..., redisOpsEstimated)', 'EX 172800', [r'minuteMetaKey'])
K('metrics.family', 'metrics:bot:{semantic|threading|stream_memory:job|stream_memory:action}:{minute:{bucket} | channel:{channelId}:minute:{bucket} | cumulative}', 'hash',
  'integer counters via HINCRBY (fields e.g. requests, errors, latencyMsTotal, pass:{n}, job:{type}, source:{s}, status:{s}, action:{a}); cumulative also updatedAt ISO',
  'EX 86400 (SEMANTIC_METRICS_TTL_SECONDS)', [r'\b(minuteKey|channelMinuteKey|cumulativeKey|key)\b'], files=['bot_runtime_metrics.ts'])
K('perf.metrics', 'performance:{operation}:metrics[:count|:success|:error|:totalDuration|:minDuration|:maxDuration|:lastUpdated]', 'string', 'integers as decimal strings',
  'EX 86400', [r'.'], files=['utils/performance/metrics.ts'], notes='Dead code: PerformanceMonitor is exported but not imported by any entry point.')
K('oauth.failures', 'oauth:failures:{api|token_refresh}:{epochMs}', 'string', 'JSON sanitized failure record', 'EX 86400', [r'\bkey\b'], files=['oauth_debug_cache.ts'])

# --- site analytics ----------------------------------------------------------------------------
K('site.analytics', 'site:analytics:channels', 'hash', 'fields registered_users, live_users, authorized_accounts, total_messages, total_commands, total_live_viewers, legacy registered/live/active: integers as decimal strings (HSET String(n) / HINCRBY)', 'none', [r'SITE_ANALYTICS_KEY\b'])
K('site.live', 'site:analytics:live:channels', 'string', 'JSON array of live channel summaries', 'EX SITE_ANALYTICS_LIVE_CHANNELS_CACHE_TTL_SECONDS (default 60, min 30)', [r'SITE_ANALYTICS_LIVE_CHANNELS_KEY'])
K('site.profile', 'site:analytics:profile:{channelId}', 'string', 'profile image URL', 'EX 86400', [r'SITE_ANALYTICS_PROFILE_CACHE_PREFIX', r'cacheKeys'], files=['siteanalytics.ts'])
K('site.start', 'site:analytics:start', 'string', '"1" (first-run marker)', 'none', [r'site:analytics:start'])

# --- commands / keywords / variables / timers ---------------------------------------------------
K('cmd.cache', '{channelId}:commands:{cmd}', 'string', 'JSON command document (lean Mongo doc, ObjectIds as hex strings)', 'EX 3600',
  [r'`\$\{\w+(\.\w+)?\}:commands:', r'\bcacheKey\b'], files=['command.class.ts', 'command_manager.command.ts', 'command_mutations.service.ts', 'availability/service.ts',
                                                           'migrate_shoutout_defaults', 'migrate_speech_ast'])
K('cmd.legacy.list', '{channelId}:commands', 'string', 'legacy (DEL only)', '-', [r'`\$\{channelID\}:commands`'])
K('cmd.legacy.twitch', 'twitch:{channelId}:commands:{cmd}', 'string', 'legacy (DEL only)', '-', [r'twitch:\$\{channelID\}:commands:'])
K('cmd.cooldown', 'command:execution:cooldown:{channelId}:{executionName}', 'string', '"1"', 'PX ceil(cooldown*1000) (SET NX PX)', [r'command:execution:cooldown'])
K('cmd.cooldown.write', 'command-cooldown-write:{channelId}', 'string', 'lock token randomUUID()', 'EX 60 (SET NX)', [r'\bkey\b'], files=['command_cooldown_write.ts'])
K('kw.index', 'keywords:index:{channelId}', 'string', 'JSON KeywordEntry[] {id, text, matchMode}', 'EX 86400 (revision-fenced Lua SET)', [r'\bkey\(channelID\)'], files=['keyword_cache.ts'])
K('kw.revision', 'keywords:revision:{channelId}', 'string', 'integer counter (INCR); "0" when absent', 'none', [r'revisionKey\(channelID\)'], files=['keyword_cache.ts'])
K('kw.body', 'keywords:body:{channelId}:{commandId}', 'string', 'JSON keyword command body', 'EX 30 (revision-fenced Lua SET)', [r'keywordBodyKey'])
K('chat.history', '{platform}:{channelId}:chat:history', 'list', 'JSON {username, message, timestamp, messageID, badges}, newest first', 'none; LTRIM 0 99', [r'\bkey\b'], files=['chat_history.ts'])
K('ast.variable', '{platform}:{channelId}:variable:{name}[:id:{userId} | :login:{lowercased login}]', 'string', 'variable value as the evaluator\'s string (arrays as JSON)', 'EX 86400 (separate EXPIRE after SET)',
  [r'\bkey\b'], files=['ast_parser/evaluator.ts'])
K('ast.timer.index', 'ast:timers:pending', 'zset', 'member = timer job id (UUID), score = dueAt epoch ms', 'none', [r'AST_TIMER_INDEX'])
K('ast.timer.job', 'ast:timers:job:{id}', 'string', 'JSON AstTimerJob {version:1,id,dueAt,expiresAt,body,context} ≤64 KiB', 'PXAT expiresAt', [r'JOB_PREFIX'])
K('ast.timer.channel', 'ast:timers:channel:{channelId}', 'zset', 'member = job id, score = expiresAt ms', 'PEXPIREAT max score', [r'CHANNEL_PREFIX'])
K('timer.active', 'timer:active', 'set', 'members = channel IDs with live timers', 'none', [r"timer:active", r'TIMER_ACTIVE_KEY'])
K('timer.timers', 'timer:channel:{channelId}:timers', 'hash', 'field = timer _id (hex), value = JSON timer document (timer.toObject())', 'none', [r'timer:channel:\$\{\w+\}:timers', r'getTimerChannelKey'])
K('timer.heartbeat', 'timer:channel:{channelId}:heartbeat:{timerId}', 'string', 'integer as decimal string', 'none', [r':heartbeat:', r'heartbeatKey\b'])
K('timer.heartbeat.unit', 'timer:channel:{channelId}:heartbeat-unit:{timerId}', 'string', 'TIMER_FREQUENCY_UNIT constant', 'none', [r'heartbeat-unit', r'heartbeatUnitKey'])

# --- chat / eventsub / misc bot state -------------------------------------------------------------
K('follows.count', '{channelId}:follows:count', 'string', 'integer counter (INCR; legacy follow.handler GET/SET)', 'none', [r'follows:count', r'cacheKey'], files=['follow.handler.ts', 'cache.ts', 'chat_announcement'])
K('follows.event', '{channelId}:follows:event:{eventKey}', 'string', 'assigned count (tostring)', 'EX 172800', [r'NEVER'])
K('eventsub.dedupe', 'twitch:eventsub:message:{messageId}', 'string', 'ISO timestamp', 'EX TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS (default 600, min 300) (SET NX)', [r'dedupeKey'], files=['eventsub.twitch.ts'])
K('stream.online.dedupe', 'twitch:{channelId}:stream.online:{streamId}', 'string', 'started_at ISO', 'EX STREAM_ONLINE_DEDUPE_TTL_SECONDS (default 86400) (SET NX)', [r'dedupeKey'], files=['stream_online.handler.ts'])
K('onlyemotes', '{channelId}:chat:onlyemotes', 'string', 'status value (number/bool as string)', 'EX 3600', [r'chat:onlyemotes'])
K('sumimetro.user', '{channelId}:sumimetro:{lowercased login}', 'string', 'number as string', 'EX 72000', [r'sumimetro:\$\{lowerCase', r'sumimetro:\*', r'cache\.del\(key\)'], files=['sumimetro.command.ts', 'utils/cache.ts'])
K('sumimetro.rank', '{channelId}:sumimetro:{dominant|submissive}', 'hash', 'fields user, value', 'none', [r'sumimetro:(dominant|submissive)'])
K('roulette', '{channelId}:roulette:{userId}', 'string', 'integer counter', 'none', [r'roulette:\$\{userData\.id\}`'])
K('roulette.died', '{channelId}:roulette:{userId}:died', 'string', 'integer counter', 'EX 600', [r'roulette:\$\{userData\.id\}:died'])
K('promo.legacy', '{channelId}:clip:connected | {channelId}:clips:queue | {channelId}:clip:playing | {channelId}:clips:queue:first', 'mixed',
  'legacy promo command keys: clip:connected read only, clips:queue list RPUSH (no consumer found), clip:playing "true", clips:queue:first login', 'none', [r'`\$\{channelID\}:clip'])
K('clips.connected', 'twitch:{channelId}:clips:connected', 'string', '"true"', 'none', [r'clips:connected'])
K('clips.lastactivity', 'twitch:{channelId}:clips:last_activity', 'string', 'epoch ms (Date.now())', 'none', [r'clips:last_activity'])
K('clips.queue.data', 'twitch:{channelId}:clips:queue:data:{clipId}', 'string', 'JSON ClipRequestData', 'none', [r'clips:queue:data'])
K('clips.queue', 'twitch:{channelId}:clips:queue', 'zset', 'member = clipID, score = enqueue time ms', 'none', [r'clips:queue`'])
K('clips.processing', 'twitch:{channelId}:clip:processing', 'string', '"true"', 'none', [r'clip:processing', r'clips:processing'])
K('clips.timeout', 'twitch:{channelId}:clips:timeouts:default', 'string', 'timeout seconds from overlay query param', 'none', [r'clips:timeouts:default'])
K('clips.cache', 'twitch:{channelId}:clips', 'string', 'JSON Twitch clips array', 'EX 18000 (CLIP_CACHE_TTL_HOURS=5)', [r'\bcacheKey\b'], files=['get_clips.clip.ts'])
K('clips.shown', 'twitch:{channelId}:clips:shown', 'set', 'shown clip IDs', 'EX 86400', [r'shownKey'])
K('triggers.connected', 'twitch:{channelId}:triggers:connected', 'string', '"true"', 'none', [r'triggers:connected'])
K('triggers.activity', 'twitch:{channelId}:triggers:last_activity', 'string', 'epoch ms', 'none', [r'triggers:last_activity'])
K('tts.queue', 'twitch:{channelId}:tts:queue', 'zset', 'member = speechID, score = item.timestamp (ms)', 'none', [r'tts:queue`', r"tts:queue'", r'\bkey\b'],
  files=['tts_queue.handler.ts', 'tts_lane.ts', 'tts_session.util.ts', 'collectors.mjs'])
K('tts.queue.data', 'twitch:{channelId}:tts:queue:data:{speechId}', 'string', 'JSON TTS queue item + queueSession (re-encoded by Lua cjson in ENQUEUE)', 'none', [r'tts:queue:data'])
K('tts.processing', 'twitch:{channelId}:tts:processing', 'string', 'speechID or "pending"', 'EX 150 (TTS_PROCESSING_TTL_SECONDS)', [r'tts:processing', r'processingKey'])
K('tts.session', 'twitch:{channelId}:tts:session', 'string', 'session UUID', 'none', [r'tts:session'])
K('tts.connected', 'twitch:{channelId}:tts:connected', 'string', '"true"', 'none', [r'tts:connected'])
K('tts.lastcleanup', 'twitch:{channelId}:tts:last_cleanup', 'string', 'epoch ms', 'none', [r'speechKey'])
K('tts.usage', '{channelId}:tts:usage', 'hash', 'fields {provider}_characters/_credits/_cost (cost = round(usd*1e5)), total_characters, total_credits (HINCRBY integers)', 'EXPIRE seconds to next month', [r'tts:usage'])
K('chatbot.usage', '{channelId}:chatbot:usage', 'hash', 'total_tokens, prompt_tokens, completion_tokens (HINCRBY)', 'EXPIRE seconds to next month', [r'chatbot:usage'])
K('chatbot.last', '{channelId}:chatbot:response:last', 'string', 'JSON {messageData:{content}, usageData, model, timestamp}', 'none', [r'chatbot:response:last'])
K('chatbot.personality', 'twitch:{channelId}:chatbot:personality', 'string', 'JSON personality document', 'EX 10800 (SETEX)', [r'chatbot:personality'])
K('mods.json', 'twitch:{channelId}:moderators', 'string', 'JSON moderators response', 'EX 7200', [r'jsonCacheKey', r'\bcacheKey\b'], files=['moderator', 'add_moderator', 'remove_moderator'])
K('mods.ids', 'twitch:{channelId}:moderators:ids', 'set', 'moderator user IDs', 'EX 7200', [r'idsCacheKey'])
K('mods.logins', 'twitch:{channelId}:moderators:logins', 'set', 'moderator logins', 'EX 7200', [r'loginsCacheKey'])
K('mods.mapping', 'twitch:{channelId}:moderators:mapping', 'hash', 'login → user ID', 'EX 7200', [r'mappingCacheKey'])
K('channel.data', 'channel:data:{channelId}', 'string', 'JSON Twitch channel information', 'EX 10800', [r'channel:data:'])
K('polls', 'twitch:{channelId}:polls', 'string', 'JSON poll data', 'none', [r':polls`', r'cacheKey'], files=['poll'])
K('predictions', 'twitch:{channelId}:predictions', 'string', 'JSON prediction data', 'none', [r':predictions`', r'cacheKey'], files=['prediction'])
K('roles.editors', 'twitch:{channelId}:editors', 'set', 'lowercased editor logins', 'EX 86400', [r'editorsKey\(channelID\)'])
K('roles.editors.ids', 'twitch:{channelId}:editors:ids', 'set', 'editor user IDs', 'EX 86400', [r'editorsIdsKey'])
K('roles.editors.legacy', '{channelId}:channel:editors', 'set', 'legacy (DEL only)', '-', [r'NEVER'])
K('roles.admins', 'twitch:{channelId}:admins', 'set', 'lowercased admin logins', 'none', [r'adminsKey\(channelID\)', r'twitch:\$\{channelID\}:admins`', r"loginKey"])
K('roles.admins.ids', 'twitch:{channelId}:admins:ids', 'set', 'admin user IDs', 'none', [r'adminsIdsKey', r'idsKey'])
K('roles.admins.detail', 'twitch:{channelId}:admins:{adminId}', 'hash', 'fields adminID, adminName (lowercased), channelID, channelName, permissions (JSON array), actived ("true"|"false")', 'none',
  [r'adminDetailKey', r'admins:\$\{(adminIdStr|userCacheID)\}', r'keysToDelete|client\.del\(keys\)|client\.keys\('], files=['roles.ts', 'admin.route.ts', 'validation.route.ts'],
  notes='Also matched: KEYS twitch:{c}:admins* / {c}:admins* sweeps that delete every admin key (incl. legacy {c}:admins*).')

# --- moderation ----------------------------------------------------------------------------------
K('mod.settings', 'moderation:{channelId}:settings', 'string', 'JSON moderation settings doc or sentinel {"none":true}', 'EX 300', [r'moderationSettingsCacheKey', r'\bkey\b'], files=['moderation.handler.ts'])
K('mod.message', 'moderation:{channelId}:message:{messageId}', 'string', '"1" receipt', 'EX 86400 (SET NX)', [r'moderation:\$\{channelID\}:message'])
K('mod.offenses', 'moderation:{channelId}:offenses:{ruleId}:{userId}', 'string', 'integer counter', 'EXPIRE max(60, windowSeconds) on first increment', [r'\bkey\b'], files=['offenses.ts'])
K('mod.offense.receipt', 'moderation:offense-receipt:{decisionId}', 'string', 'assigned count', 'EX 86400', [r'NEVER'])
K('mod.permit', 'moderation:{channelId}:permit:{user:{lowercased login} | channel}', 'string', 'expiry epoch ms as string', 'EX seconds', [r'permit(User|Channel)Key', r'\bkey\b'], files=['permit.ts'])
K('mod.notice', 'moderation:{channelId}:notice:{userId}', 'string', '"1"', 'EX 60 (SET NX)', [r'noticeCooldownKey'])
K('mod.seen', 'moderation:seen:{sha256hex(JSON.stringify([channelId, userId]))}', 'string', '"1"', 'EX 86400', [r'\bkey\b'], files=['spam.ts'])
K('mod.spam.budget', 'moderation:spam-budget:{channel:{channelId} | global}', 'hash', 'fields window (unix minute), count', 'EX 120', [r'NEVER'])
K('mod.variation', 'moderation:{channelId}:{variation-words|variation-jobs}', 'string', 'integer counters', 'EX 86400 on first increment', [r'NEVER'])
K('mod.remod.queue', 'twitch:moderation:banmod:restore:queue', 'zset', 'member = jobId, score = due epoch ms', 'none', [r'REMOD_QUEUE_KEY'])
K('mod.remod.data', 'twitch:moderation:banmod:restore:data:{jobId}', 'string', 'JSON restore job payload', 'EX 691200 (MAX_TIMEOUT_SECONDS+86400)', [r'dataKey'], files=['moderation.functions.ts'])

# --- follow defense ----------------------------------------------------------------------------
FD = 'twitch:{channelId}:follow-defense:'
K('fd.settings', FD + 'settings', 'string', 'JSON FollowDefenseRuntimeSettings', 'none', [r'\.settings\b', r'keys\.settings'])
K('fd.state', FD + 'state', 'string', 'JSON FollowDefenseState {mode, channelID, channelLogin, channelName, modeStartedAt, burstStartedAt, expiresAt, version, ...} (re-encoded by Lua cjson)', 'none',
  [r'\.state\b', r'follow-defense:state'])
K('fd.recent', FD + 'recent', 'zset', 'member = follow eventID, score = followedAt ms', 'none (ZREMRANGEBYSCORE retention 300 s)', [r'keys\.recent'])
K('fd.zhelpers', '(generic ZCOUNT / ZREMRANGEBYSCORE helpers via sendCommand; called with fd.recent and fd.tracked)', 'zset', 'see fd.recent / fd.tracked', '-', [r"sendCommand\(\['Z"], files=['utils/follow_defense.ts'],
  notes='Raw sendCommand: replies are RESP integers (ZCOUNT) converted with Number(); a Rust port must issue the same commands on the same keys (callers: follow_defense.ts:389, 406, 410).')
K('fd.tracked', FD + 'tracked', 'zset', 'member = eventID, score = ms', 'none', [r'\.tracked\b'])
K('fd.follow', FD + 'follow:{eventId}', 'string', 'JSON FollowDefenseFollowPayload', 'EX FOLLOW_DEFENSE_FOLLOW_DATA_TTL_SECONDS (default 86400)', [r'followDataPrefix'])
K('fd.ban', FD + 'ban:{eventId}', 'string', 'JSON BanCacheResult (read only; no current writer found)', 'unknown', [r'banDataPrefix'])
K('fd.completed', FD + 'completed:{eventId}', 'string', '"1" receipt', 'EX 86400', [r'receiptKey'], files=['follow_defense.ts'])
K('fd.summary', FD + 'summary', 'string', 'JSON {id, count, notBefore, startedAt, lastAt, attack} (cjson)', 'EX 172800', [r'keys\.summary\b'])
K('fd.summary.lock', FD + 'summary-lock', 'string', 'token UUID', 'EX 120', [r'summaryLock'])
K('fd.suppressed', FD + 'suppressed:{sha256hex(eventId)}', 'string', '"1"', 'EX 172800', [r'NEVER'])
K('fd.raid', FD + 'raid', 'string', 'JSON FollowDefenseRaidMarker', 'PXAT marker.expiresAt', [r'\.raid\b'])
K('fd.raidprojection', FD + 'raid-projection', 'string', 'last raidStartedAt (ms) as string', 'EX 259200', [r'NEVER'])
K('fd.summaries', 'twitch:follow-defense:summaries', 'zset', 'member = channelId, score = notBefore ms', 'none', [r'\.summaries\b'])
K('fd.active', 'twitch:follow-defense:active-channels', 'zset', 'member = channelId, score = state.expiresAt ms', 'none', [r'activeChannels', r'activeKey'], files=['follow_defense'])
K('fd.queue', 'twitch:follow-defense:queue', 'zset', 'member = eventID, score = due ms', 'none', [r'FOLLOW_DEFENSE_QUEUE_KEY'])
K('fd.queue.data', 'twitch:follow-defense:queue:data:{eventId}', 'string', 'JSON FollowDefenseQueueEvent {type:"follow"|"manual_attack", payload}', 'EX 86400',
  [r'followDefenseQueueDataKey', r'dataKey'], files=['follow_defense'])
K('fd.baseline', 'follow:defense:baseline:{channelId}', 'string', 'JSON DefenseBaseline {calculatedAt, averageDaily, averageStream, sampleDays, streamCount, excludedDays, attackThreshold}', 'EX 604800',
  [r'[^{]key\(channelID\)(?!\})', r'follow:defense:baseline:\{channel\}'], files=['follow_defense_baseline'])
K('fd.baseline.requested', 'follow:defense:baseline:{channelId}:requested', 'string', '"1"', 'EX 60 (SET NX)', [r':requested'])
K('fd.baseline.due', 'follow:defense:baseline:due', 'zset', 'member = channelId, score = due epoch ms (ZADD LT on request)', 'none', [r'\bDUE\b'])

# --- AI/thread/docs/site agent ----------------------------------------------------------------
K('ai.emotes', 'twitch:{channelId}:ai:emotes', 'string', 'JSON string[]', 'EX 3600', [r'cacheKey\(channelID\)'])
K('tts.global.emotes', 'twitch:global:tts:emotes', 'string', 'JSON string[]', 'EX 3600 (success) / 60 (failure)', [r'\bkey\b'], files=['emote_names.util.ts'])
K('emote.catalog', 'twitch:{channelId}:emote-catalog:v1', 'string', 'JSON CachedCatalog {emotes:[{id,name}], checkedAt (ISO|null), retryAt (ms)}', 'EX 86400', [r'\bkey\b'], files=['twitch_emotes.ts', 'dashboard_emote_catalog.rs'])
K('ast.catalog.vectors', 'ast_catalog:vectors:v1:{sha256hex(JSON.stringify([model, dim, texts]))[0:24]}', 'string', 'serialized Float32 vectors', 'EX 2592000', [r'\bkey\b'], files=['ast_catalog/index.ts'])
K('docs.vectors', 'site_agent:docs:vec:{lang}:{hashText(model|format|text, 24)}', 'string', 'base64 of little-endian Float32Array (LFM2_EMBEDDING_DIM*4 bytes)', 'EX 2592000', [r'client\.(mGet|set)\('], files=['docs/vectors.ts'])
K('thread.active', 'twitch:{channelId}:ai:threads:active', 'zset', 'member = threadID, score = last activity ms', 'EX 86400', [r'channelThreadsKey', r'channelKey'])
K('thread.user', 'twitch:{channelId}:ai:user:{userId}:threads', 'zset', 'member = threadID, score = ms', 'EX 86400', [r'userThreadsKey', r'userKey'])
K('thread.meta', 'twitch:{channelId}:ai:thread:{threadId}:meta', 'string', 'JSON thread meta', 'EX 86400', [r'threadMetaKey', r'metaKey'])
K('thread.turns', 'twitch:{channelId}:ai:thread:{threadId}:turns', 'list', 'JSON turns, newest first', 'EX 86400; LTRIM maxTurnsStored', [r'threadTurnsKey', r'turnsKey'])
K('docs.stats', 'docs_assistant:stats:{YYYY-MM-DD UTC}', 'hash', 'HINCRBY integers asked, answered, tool_calls, input_tokens, cache_read_tokens, output_tokens, cost_micro_usd, failed, failed_{kind}, helpful, unhelpful', 'EX 10368000 (120 d)',
  [r'\b(key|stats)\b'], files=['docs_assistant.ts'])
K('docs.answer', 'docs_assistant:answer:{uuid}', 'hash', 'fields at, lang, page, turn, question, answer, sources (JSON), duration_ms, input_tokens, output_tokens, cost_usd (toFixed(6)), stop_reason, rounds, tool_calls (JSON), feedback (HSETNX)', 'EX 2592000', [r'answerKey'])
K('docs.recent', 'docs_assistant:recent', 'list', 'answer IDs, newest first', 'none; LTRIM 0 999', [r'docs_assistant:recent'])
SA = 'site_agent:'
K('sa.session', SA + 's:{sessionId}', 'string', 'JSON SessionMeta', 'EX 259200', [r'K\.session\(', r'sessionKeys'])
K('sa.items', SA + 's:{sessionId}:items', 'hash', 'field = itemId, value = JSON item', 'EX 259200', [r'K\.sessionItems\((sessionId|id)\)(?!\}:order)'])
K('sa.items.order', SA + 's:{sessionId}:items:order', 'list', 'item IDs in order', 'EX 259200', [r':order`'])
K('sa.ctx', SA + 's:{sessionId}:ctx', 'string', 'JSON context array ("[]" initially)', 'EX 259200', [r'sessionContext'])
K('sa.queue', SA + 's:{sessionId}:queue', 'list', 'JSON queued user inputs', 'EX 259200', [r'sessionQueue'])
K('sa.usersessions', SA + 'sessions:{channelId}:{userId}', 'zset', 'member = sessionId, score = last activity ms', 'EX 259200', [r'userSessions', r'\blist\b'])
K('sa.turn', SA + 't:{turnId}', 'hash', 'fields rev (integer string), json (JSON TurnRecord)', 'EX 259200', [r'K\.turn\('])
K('sa.events', SA + 't:{turnId}:ev', 'stream', 'entries with single field e = JSON AgentEvent', 'EX 7200 after each XADD; MAXLEN ~ 4000', [r'turnEvents'])
K('sa.lease', SA + 'lease:{sessionId}', 'string', 'fencing token', 'PX 60000 (SET NX PX; renewed by Lua PEXPIRE)', [r'K\.lease\('])
K('sa.active', SA + 'active', 'set', 'active turn IDs', 'none', [r'activeTurns'])
K('sa.daily', SA + 'daily:{channelId}:{YYYY-MM-DD UTC}', 'string', 'integer counter', 'EX 172800 (inside TAKE Lua)', [r'dailyCount', r'\bdaily\b'])
K('sa.stats', SA + 'stats:{YYYY-MM-DD UTC}', 'hash', 'HINCRBY integers (steps, compactions, plan_{tier}_steps, *_tokens, cost_micro_usd, turns, turns_{status}, tool_calls, duration_ms_total, messages, helpful, unhelpful, ...)', 'EX 10368000',
  [r'\b(key|stats)\b'], files=['site_agent/usage.ts'])
K('sa.feedback', SA + 'feedback:{turnId}', 'hash', 'fields rating (HSETNX), at', 'EX 2592000', [r'\bkey\b'], files=['site_agent/usage.ts'])
K('sa.polar.retry', SA + 'polar:retry', 'list', 'JSON Polar events awaiting retry', 'EX 604800; LTRIM -5000 -1', [r'POLAR_RETRY_KEY'])
K('sa.reconcile', SA + 'reconcile', 'list', 'JSON reconcile items', 'EX 86400; LTRIM -5000 -1', [r'reconcileQueue'])
K('sa.prefs', SA + 'prefs:{channelId}:{userId}', 'hash', 'field persona = "1"|"0"', 'none', [r'K\.prefs', r'\bprefs\b'])
K('sa.request', SA + 'req:{userId}:{requestId}', 'string', 'JSON {fingerprint, state:"pending"|"done", result?}', 'EX 600', [r'\bkey\b'], files=['site_agent/store.ts'])

# --- desktop / oauth / pets / overlays / widgets ------------------------------------------------
K('desk.slot', 'desktop:speech:slot:{channelId}', 'string', 'JSON Stored speech activity {channelId, playbackId, outputGeneration, source, expiresAt, fence, phase, retiredProof?} (re-encoded by Lua cjson)', 'PX duration+30000 (Lua)',
  [r'slotKey'])
K('desk.revision', 'desktop:speech:revision:{channelId}', 'string', 'integer counter', 'EXPIRE 86400 (Lua)', [r'revisionKey'], files=['desktop_ai'])
K('desk.queue', 'desktop-ai:queue:{ownerUserId}', 'zset', 'member = "{clientId}:{requestId}", score = expiry ms', 'PX 7200000', [r'ownerQueue'])
K('desk.owner', 'desktop-ai:owner:{ownerUserId}', 'string', 'lease token UUID', 'PX RUN_TIMEOUT+30000 (330000)', [r'ownerLease', r'leaseKey'])
K('desk.ticket', 'desktop-ai:ticket:{turnId}', 'string', 'audio ticket (base64url 32 bytes)', 'PX 20000', [r'ticketKey'])
K('oauth.rate', 'oauth:rate:{sha256 base64url(bucket)}', 'string', 'integer counter', 'EX 60 on first INCR', [r'NEVER'])
K('oauth.request', 'oauth:request:{sha256 base64url(requestId)}', 'string', 'JSON AuthorizationRequest', 'EX 600', [r'oauth:request:'])
K('oauth.code', 'oauth:code:{sha256 base64url(code)}', 'string', 'JSON AuthorizationCode', 'EX 60', [r'oauth:code:', r'\bkey\b'], files=['oauth/service.ts:95', 'oauth/service.ts:112', 'oauth/service.ts:119'])
K('oauth.access', 'oauth:access:{sha256 base64url(accessToken)}', 'string', 'JSON AccessIdentity {session_id, user_id, client_id, channel_id, scopes}', 'EX 600', [r'oauth:access:', r'\bkey\b'], files=['oauth/service.ts', 'pets/socket.ts'])
K('pet.audio', 'pet:audio:{sha256hex(ticket)}', 'string', 'JSON {ownerId, peerId, requestId, generation, leaseId, tokenHash, sessionId, expiresAt}', 'EX 5', [r'pet:audio:'])
K('overlay.test', 'overlay:test:{channelId}', 'string', 'owner UUID', 'EX 120 (SET NX), shortened to 3 s on release', [r'\bkey\b'], files=['test-playback.ts'])
K('tts.preview.ticket', 'tts:preview:ticket:{ticket}', 'string', 'channelID', 'EX 30 (GETDEL consumer)', [r'tts:preview:ticket'])
K('tts.preview.lock', 'tts:preview:lock:{channelId}', 'string', 'lock UUID', 'EX 120', [r'lockKey'], files=['voice_preview.service.ts'])
K('tts.preview.cooldown', 'tts:preview:cooldown:{channelId}', 'string', '"1"', 'EX 8 (SET NX)', [r'tts:preview:cooldown'])
K('widget.demand', 'widget-feed:demand:{channelId}', 'string', '"1"', 'EX 60 (DEMAND_TTL_SECONDS, overlays/live.ts:45)', [r'widgetFeedDemandKey', r'exists\(key\)'], files=['overlays/live.ts', 'widget_feed/publisher.ts'])
K('widget.signal.rate', 'widget-signal:rate:{channelId}', 'string', 'integer counter', 'EX 10 (repaired if TTL<0)', [r'widgetSignalRateKey'])
K('widget.signal.skipped', 'widget-signal:skipped:{channelId}', 'string', 'integer counter', 'EX 600', [r'widgetSignalSkippedKey'])
K('widget.signal.seen', 'widget-signal:seen:{actionKey = "signal:v1:" + sha256hex(JSON.stringify([originId, path, n]))}', 'string', '"1"', 'EX 86400 (SET NX)', [r'widget-signal:seen'])
K('duel.presence', 'widgets:duel:{channelId}:connected', 'string', 'JSON {hash (overlay token hash), at (ms)}', 'EX 5', [r'presenceKey'])
K('ratelimit', 'ratelimit:{scope}:{sha256 base64url(subject)}', 'string', 'integer counter', 'EX windowSeconds on first INCR', [r'NEVER'])
K('temproles.pending', 'twitch:temporary-roles:pending-announcements:{channelId}', 'list', 'JSON pending announcement payloads', 'EX 1209600', [r'\bkey\b'], files=['temporary_roles_announcements.ts'])
K('dimadb.any', '(any key — dimadb operator console)', 'any', 'generic SCAN/TYPE/TTL/GET/SET/DEL/HGETALL/LRANGE/XRANGE and raw sendCommand (dangerous commands need confirm)', '-', [r'.'], files=['dimadb/server'])
K('analytics.queue.scan', 'twitch:{channelId}:{tts|clips}:queue (SCAN MATCH twitch:*:*:queue)', 'zset', 'read-only depth sampling', '-', [r'.'], files=['collectors.mjs'])

# --- Rust library-only keys (not deployed; listed so a port does not invent incompatible state) ---
K('rs.directory.revision', 'streamers:directory:revision', 'string', 'directory revision token (Rust library only; TS never writes or checks it)', 'none', [r'\bREVISION\b'])
K('rs.directory.generation', 'streamers:directory:generation:{channelId}', 'string', 'per-account generation fence (Rust library only; TS never maintains it)', 'none', [r'directory_generation_key|generation'],
  files=['twitch_tokens'])
K('rs.streamers.lease', 'locks:streamers:reconcile', 'string', 'reconcile lease owner (Rust library only)', 'set by library', [r'\bLEASE\b'])

# ----------------------------------------------------------------------------------------------
# Lua scripts
# ----------------------------------------------------------------------------------------------
LUA = []


def L(id, src, keys, argv, returns, callers_re, files, notes='', mode='EVAL (node-redis client.eval, script text sent every call)', site_keys=None):
    LUA.append(dict(id=id, source=src, keys=keys, argv=argv, returns=returns, callers_re=callers_re, files=files, notes=notes, mode=mode, site_keys=site_keys or {}))


L('WRITE_PLAN_ACCOUNT_SCRIPT', 'dimabot/src/utils/plan_cache_fence.ts:8 (Rust copy dima-rust/src/utils/plan_cache_fence.rs:35)',
  ['plan.fence', 'accounts.data', 'twitch.accounts'], ['1: plan version', '2..n: field, value pairs (sanitized string fields + __polar_plan_version)'],
  '0 = stale (fence > version), 1 = written', r'WRITE_PLAN_ACCOUNT_SCRIPT', ['twitch_streamers.class.ts'])
L('CHECK_PLAN_ACCOUNTS_SCRIPT', 'dimabot/src/utils/plan_cache_fence.ts:18 (Rust copy plan_cache_fence.rs:44)',
  ['plan.fence', 'twitch.accounts'], ['1..n-1: per-account __polar_plan_version', 'n: JSON array to publish or ""'],
  '1 = all fresh (and published when ARGV[n] ≠ ""), 0 = stale', r'CHECK_PLAN_ACCOUNTS_SCRIPT', ['twitch_streamers.class.ts'],
  notes='KEYS = one plan-version fence per account + "twitch:accounts" last.')
L('ACCEPT_PLAN_CREDITS_SCRIPT', 'dimabot/src/utils/plan_cache_fence.ts:29 (Rust copy plan_cache_fence.rs:56)',
  ['ai.credits', 'ai.exhaust', 'ai.exhaust.legacy', 'plan.fence'], ['1: plan version', '2: raw credits JSON', '3: "read"|"write"', '4: exhausted "1"|"0"', '5: TTL seconds (300)'],
  '1 accepted / 0 stale or changed', r'ACCEPT_PLAN_CREDITS_SCRIPT', ['billing.ts'], notes='read mode compares GET == ARGV[2] byte-for-byte.')
L('APPLY_AI_CREDIT_USAGE_SCRIPT', 'dimabot/src/utils/billing.ts:244', ['ai.credits', 'ai.exhaust', 'ai.exhaust.legacy', 'ai.usage.local'],
  ['1: credits consumed', '2: updatedAt ISO', '3: schema version "3"', '4: TTL "2678400"', '5: tracked "1"|"0"'], '2 = duplicate marker, 1 = now exhausted, 0 = otherwise',
  r'APPLY_AI_CREDIT_USAGE_SCRIPT', ['billing.ts'], notes='Decodes and re-encodes the credits JSON with cjson.')
L('INVALIDATE_PLAN_SCRIPT', 'dimabot/src/domain_events/polar_billing_events.ts:18 (Rust copy plan_cache_fence.rs:74)',
  ['plan.fence', 'ai.credits', 'accounts.data', 'twitch.accounts', 'billing.packctx'], ['1: new plan version'], '1 applied / 0 older', r'INVALIDATE_PLAN_SCRIPT', ['polar_billing_events.ts'])
L('SYNC_CREDITS_SCRIPT', 'dimabot/src/domain_events/polar_billing_events.ts:25 (Rust copy plan_cache_fence.rs:83)',
  ['ai.credits', 'ai.exhaust', 'ai.exhaust.legacy', 'ai.credits.polar', 'plan.fence'],
  ['1: polar version', '2: credits JSON or ""', '3: exhaustion "1"|"0"|""', '4: TTL', '5: plan version'], '1 applied / 0 stale', r'SYNC_CREDITS_SCRIPT', ['polar_billing_events.ts'])
L('INCREMENT_FOLLOW_COUNT_SCRIPT', 'dimabot/src/domain_events/chat_announcement_events.ts:52', ['follows.count', 'follows.event'], ['1: event TTL 172800'],
  'assigned follow count (integer)', r'INCREMENT_FOLLOW_COUNT_SCRIPT', ['chat_announcement_events.ts'])
for name, line, ret in [('reserveScript', 37, 'revision or 0'), ('startScript', 41, 'revision, 0 or -1'), ('finishScript', 49, '{revision, raw} or {0,""}'),
                        ('extendScript', 53, 'revision, 0 or -1'), ('retireScript', 59, '{revision, raw}'), ('expireScript', 67, '{revision, raw}'),
                        ('expireExpectedScript', 71, '{revision, raw}')]:
    L(f'desktop.{name}', f'dimabot/src/desktop_ai/activity.ts:{line}', ['desk.slot', 'desk.revision'], ['fence / stored JSON / now / ttl (see source)'], ret,
      r'\b' + name + r'\b', ['desktop_ai/activity.ts'])
L('desktop.readSlot', 'dimabot/src/desktop_ai/activity.ts:100 (inline)', ['desk.slot', 'desk.revision'], [], '{raw or "", revision or "0"}', r"return \{redis\.call\('GET',KEYS\[1\]\)", ['desktop_ai/activity.ts'])
L('desktop.reserveQueueScript', 'dimabot/src/desktop_ai/service.ts:27', ['desk.queue'], ['1: now ms', '2: member', '3: expiry score', '4: max outstanding', '5: PEXPIRE ms'],
  '2 existing / 1 reserved / 0 full', r'reserveQueueScript', ['desktop_ai/service.ts'])
L('desktop.releaseLeaseScript', 'dimabot/src/desktop_ai/service.ts:32', ['desk.owner'], ['1: token'], 'DEL result or 0', r'releaseLeaseScript', ['desktop_ai/service.ts'])
L('desktop.renewLeaseScript', 'dimabot/src/desktop_ai/service.ts:33', ['desk.owner'], ['1: token', '2: PEXPIRE ms'], '1 / 0', r'renewLeaseScript', ['desktop_ai/service.ts'])
L('oauth.rateLimit', 'dimabot/src/server/oauth/service.ts:47 (inline)', ['oauth.rate'], [], 'count', r"local n=redis\.call\('INCR',KEYS\[1\]\); if n==1 then redis\.call\('EXPIRE',KEYS\[1\],60\)", ['oauth/service.ts'])
L('site_agent.CAS', 'dimabot/src/site_agent/store.ts:86', ['sa.turn', 'sa.lease'], ['1: expected rev', '2: next rev', '3: JSON', '4: TTL', '5: fence token'], '1 / 0 conflict / -1 lease lost',
  r'\bCAS\b', ['site_agent/store.ts'], notes='KEYS[2] (lease) only when fenced.')
L('site_agent.SET_IF_SAME', 'dimabot/src/site_agent/store.ts:194', ['sa.session'], ['1: expected JSON', '2: new JSON', '3: TTL'], '1 / 0', r'SET_IF_SAME', ['site_agent/store.ts'],
  notes='Byte compare of the previously read JSON.')
L('site_agent.SET_IF_LEASE', 'dimabot/src/site_agent/store.ts:267', ['sa.ctx', 'sa.lease'], ['1: JSON', '2: token', '3: TTL'], '1 / 0', r'SET_IF_LEASE', ['site_agent/store.ts'])
L('site_agent.RENEW', 'dimabot/src/site_agent/store.ts:363', ['sa.lease'], ['1: token', '2: PEXPIRE ms'], '1 / 0', r'\bRENEW\b', ['site_agent/store.ts'])
L('site_agent.RELEASE', 'dimabot/src/site_agent/store.ts:364', ['sa.lease'], ['1: token'], '1 / 0', r'\bRELEASE\b', ['site_agent/store.ts'])
L('site_agent.TAKE', 'dimabot/src/site_agent/limits.ts:15', ['sa.daily'], ['1: limit', '2: TTL 172800'], '{allowed 0|1, used}', r'\bTAKE\b', ['site_agent/limits.ts'])
L('site_agent.refund', 'dimabot/src/site_agent/limits.ts:42 (inline)', ['sa.daily'], [], 'new value or 0', r"local v = tonumber\(redis\.call\('GET', KEYS\[1\]\)", ['site_agent/limits.ts'])
L('ownerExpire', 'inline "if GET==ARGV[1] then EXPIRE KEYS[1] <n|ARGV[2]>": overlays/test-playback.ts:75, voice_preview.service.ts:96, ai_usage_lock.ts:14, ai_usage_backfill.worker.ts:87, stream_memory.worker.ts:289',
  ['overlay.test', 'tts.preview.lock', 'locks.aiusage', 'lock.backfill.consumer', 'lock.memory.channel'], ['1: owner', '2: seconds (where parameterized)'], 'EXPIRE result or 0',
  r"if redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\] then return redis\.call\('EXPIRE'", ['test-playback.ts', 'voice_preview', 'ai_usage_lock.ts', 'ai_usage_backfill.worker.ts', 'stream_memory.worker.ts'],
  site_keys={'test-playback.ts': ['overlay.test'], 'voice_preview': ['tts.preview.lock'], 'ai_usage_lock.ts': ['locks.aiusage'], 'ai_usage_backfill.worker.ts': ['lock.backfill.consumer'],
             'stream_memory.worker.ts': ['lock.memory.channel']})
L('ownerDelete', 'inline "if GET==ARGV[1] then DEL": voice_preview.service.ts:146, ai_usage_lock.ts:24, command_cooldown_write.ts:42, stream_memory.worker.ts:192, and RELEASE_LOCK_SCRIPT constants '
  'in workers/{eventsub_reconciliation:26, free_credit_reset:19, ai_usage_backfill:28, vod_clip_recommender:34}.worker.ts; Rust copies ai_usage_receipts/queue.rs:20, command_cooldown.rs:18, twitch_tokens/adapters.rs:205, twitch_streamers/adapters.rs RELEASE',
  ['tts.preview.lock', 'locks.aiusage', 'cmd.cooldown.write', 'lock.memory.channel', 'lock.eventsub-reconciliation', 'lock.free-credit-reset', 'lock.backfill.consumer', 'lock.backfill.sweep',
   'q.backfills.dedupe', 'lock.clips', 'lock.receipts'], ['1: owner'], 'DEL count or 0',
  r"RELEASE_LOCK_SCRIPT|if redis\.call\('(GET|get)', KEYS\[1\]\) == ARGV\[1\] then return redis\.call\('(DEL|del)'", ['voice_preview', 'ai_usage_lock.ts', 'command_cooldown_write.ts', 'stream_memory.worker.ts',
                                                                                                                       'eventsub_reconciliation', 'free_credit_reset', 'ai_usage_backfill.worker', 'vod_clip'],
  site_keys={'voice_preview': ['tts.preview.lock'], 'ai_usage_lock.ts': ['locks.aiusage'], 'command_cooldown_write.ts': ['cmd.cooldown.write'], 'stream_memory.worker.ts': ['lock.memory.channel'],
             'eventsub_reconciliation': ['lock.eventsub-reconciliation'], 'free_credit_reset': ['lock.free-credit-reset'], 'vod_clip': ['lock.clips'],
             'ai_usage_backfill.worker.ts:93': ['lock.backfill.consumer'], 'ai_usage_backfill.worker.ts:129': ['lock.backfill.sweep'],
             'ai_usage_backfill.worker.ts:15': ['q.backfills.dedupe'], 'ai_usage_backfill.worker.ts:16': ['q.backfills.dedupe'],
             'ai_usage_receipts/queue.rs': ['lock.receipts', 'locks.aiusage']})
L('EXTEND_LOCK_SCRIPT', 'workers/{eventsub_reconciliation:33, free_credit_reset:26, vod_clip_recommender:41}.worker.ts; Rust ai_usage_receipts/queue.rs:22 EXTEND',
  ['lock.eventsub-reconciliation', 'lock.free-credit-reset', 'lock.clips', 'lock.receipts'], ['1: owner', '2: TTL seconds'], '1 / 0', r'EXTEND_LOCK_SCRIPT', ['eventsub_reconciliation', 'free_credit_reset', 'vod_clip'],
  site_keys={'eventsub_reconciliation': ['lock.eventsub-reconciliation'], 'free_credit_reset': ['lock.free-credit-reset'], 'vod_clip': ['lock.clips'], 'ai_usage_receipts/queue.rs': ['lock.receipts', 'locks.aiusage']})
L('aiusage.claim', 'dimabot/src/utils/ai_usage_queue_health.ts:9 (Rust copy ai_usage_receipts/queue.rs:164)', ['q.receipts|q.backfills', 'q.*.processing', 'aiusage.health'],
  ['1: now ms'], 'element or nil (LPOP → RPUSH processing, HSET processingSince)', r'claimScript', ['ai_usage_queue_health.ts'],
  site_keys={'ai_usage_queue_health.ts': ['q.backfills', 'q.backfills.processing', 'aiusage.health'], 'ai_usage_receipts/queue.rs': ['q.receipts', 'q.receipts.processing', 'aiusage.health']},
  notes='TS helper is only called with the backfills queue (workers/ai_usage_backfill.worker.ts:134); the receipts queue is consumed by Rust.')
L('aiusage.complete', 'dimabot/src/utils/ai_usage_queue_health.ts:22 (Rust copy queue.rs:168)', ['q.*.processing', 'q.*.attempts'], ['1: raw element'], '1',
  r"redis\.call\('LREM', KEYS\[1\], 1, ARGV\[1\]\); redis\.call\('DEL', KEYS\[2\]\)", ['ai_usage_queue_health.ts'],
  site_keys={'ai_usage_queue_health.ts': ['q.backfills.processing', 'q.backfills.attempts'], 'ai_usage_receipts/queue.rs': ['q.receipts.processing', 'q.receipts.attempts']})
L('aiusage.fail', 'dimabot/src/utils/ai_usage_queue_health.ts:28 (Rust copy queue.rs:179)', ['q.*.processing', 'q.receipts|q.backfills', 'q.*.dead', 'q.*.attempts', 'aiusage.health'],
  ['1: raw element', '2: max attempts'], '0 not in processing / 1 requeued (RPUSH) / 2 dead-lettered', r'return Number\(await cache\.eval\(`', ['ai_usage_queue_health.ts'],
  site_keys={'ai_usage_queue_health.ts': ['q.backfills.processing', 'q.backfills', 'q.backfills.dead', 'q.backfills.attempts', 'aiusage.health'],
             'ai_usage_receipts/queue.rs': ['q.receipts.processing', 'q.receipts', 'q.receipts.dead', 'q.receipts.attempts', 'aiusage.health']})
L('ai_usage_backfill.ENQUEUE_SCRIPT', 'dimabot/src/utils/ai_usage_backfill_queue.ts:12', ['q.backfills.dedupe', 'q.backfills'], ['1: job.id', '2: dedupe seconds', '3: job JSON'], '1 enqueued / 0 duplicate',
  r'ENQUEUE_SCRIPT', ['ai_usage_backfill_queue.ts'])
L('ai_usage_backfill.RECLAIM_SCRIPT', 'dimabot/src/workers/ai_usage_backfill.worker.ts:19 (Rust receipts variant queue.rs:160 uses RPOP)', ['q.backfills.processing', 'q.backfills'], [],
  'moved count (LPOP processing → LPUSH queue: reverses order; Rust RPOP→LPUSH keeps order)', r'RECLAIM_SCRIPT', ['ai_usage_backfill.worker.ts'])
L('ENQUEUE_DEDUPLICATED_JOB', 'dimabot/src/utils/cron_jobs_queue.ts:10 (Rust copy cron_queue.rs:45, library only)', ['cronjobs.dedupe', 'q.cronjobs', 'cronjobs.accepted'],
  ['1: dedupe seconds', '2: job JSON'], '1 pushed / 0 duplicate or already accepted; error reply on push failure (markers rolled back)', r'ENQUEUE_DEDUPLICATED_JOB', ['cron_jobs_queue.ts'],
  notes='KEYS[2] is the caller-chosen queue (default cron:jobs:queue); KEYS[3] optional acceptance marker. Uses redis.pcall + redis.error_reply.')
L('PUBLISH_DURABLE_CRON_JOB', 'dimabot/src/utils/durable_cron_jobs.ts:14', ['q.memory|q.clips', 'cronjobs.accepted'], ['1: JSON.stringify(intent.payload)', '2: LPOS MAXLEN 1000'],
  '1 pushed / 0 already present (LPOS exact-bytes match)', r'PUBLISH_DURABLE_CRON_JOB', ['durable_cron_jobs.ts'],
  site_keys={'durable_cron_jobs.ts': ['q.memory', 'q.clips', 'cronjobs.accepted']})
L('stream_memory.requeueIfOwner', 'dimabot/src/workers/stream_memory.worker.ts:399 (inline)', ['lock.memory', 'q.memory.processing', 'q.memory'], ['1: owner', '2: raw'], '-1 lock lost / 0 / LPUSH length',
  r"if redis\.call\('GET', KEYS\[1\]\) ~= ARGV\[1\] then return -1 end if redis\.call\('LREM'", ['stream_memory.worker.ts'])
for name, line, ret in [('acknowledge', 3, '-1 lock lost / LREM count'), ('requeue', 9, '-1 / 0 / LREM count'), ('deadLetter', 16, '-1 / 0 / 1'), ('recover', 25, '-1 / RPOPLPUSH element')]:
    L(f'CLIP_CLAIM_SCRIPTS.{name}', f'dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:{line}', ['lock.clips', 'q.clips.processing', 'q.clips|q.clips.dead', 'cronjobs.dedupe'],
      ['1: owner', '2: raw', '3: replacement/dead payload'], ret, r'CLIP_CLAIM_SCRIPTS\.' + name, ['vod_clip_recommender.worker.ts'])
L('telemetry.ENQUEUE', 'dimabot/src/utils/observability/telemetry.ts:173 (Rust copy supervisor/telemetry.rs ENQUEUE)', ['obs.inbox', 'obs.overflow'], ['1: batch JSON'], 'dropped count',
  r'\bENQUEUE\b', ['observability/telemetry.ts'])
for name, line, keys, ret in [('ENQUEUE', 5, ['tts.queue', 'tts.queue.data', 'tts.session'], 'session or ""'), ('POP', 12, ['tts.queue', 'tts.session', 'tts.queue.data'], '{} | {"retry"} | {id, payload, session}'),
                              ('RESET', 20, ['tts.session', 'tts.queue', 'tts.processing', 'tts.connected', 'tts.lastcleanup', 'tts.queue.data'], '{previousSession, ...waiting ids, processing}'),
                              ('CLEAN_OLD', 29, ['tts.queue.data'], '1')]:
    L(f'tts.{name}', f'dimabot/src/utils/tts/tts_session.util.ts:{line}', keys, ['see source'], ret, r'\b' + name + r'\b', ['tts_session.util.ts'],
      notes='Scripts start with a "-- DIMA032_*" comment; every touched key is declared (Dragonfly atomic mode).')
L('follow_defense.projectState', 'dimabot/src/utils/follow_defense_queue.ts:111', ['fd.state', 'fd.active', 'fd.tracked', 'fd.raidprojection', 'fd.summary'],
  ['1: channelId', '2: mutation type', '3: state JSON | reset token | ""', '4: moderationExpiresAt', '5: preserveExpiry "1"|"0"'], '{changed 0|1, raw state JSON}',
  r'local stateType = redis\.call', ['follow_defense_queue.ts'], notes='Uses redis.call("TIME"); cjson re-encodes state.')
L('follow_defense.raidMarker', 'dimabot/src/utils/follow_defense_queue.ts:321', ['fd.raid'], ['1: marker JSON', '2: createdAt', '3: expiresAt (PXAT)', '4: eventID'], '1 / 0',
  r'if tonumber\(ARGV\[3\]\) <= now then return 0 end', ['follow_defense_queue.ts'])
L('follow_defense.suppress', 'dimabot/src/utils/follow_defense_summary.ts:13', ['fd.state', 'fd.settings', 'fd.suppressed', 'fd.summary', 'fd.summaries'], ['1: channelId', '2: new summary id', '3: retention 172800'],
  '{suppressed 0|1, ""}', r"if redis\.call\('GET', KEYS\[3\]\) then return \{1, ''\} end", ['follow_defense_summary.ts'])
L('follow_defense.claimSummary', 'dimabot/src/utils/follow_defense_summary.ts:105', ['fd.summary', 'fd.state', 'fd.summaries', 'fd.summary.lock'], ['1: channelId', '2: token', '3: retention'],
  '{claimed 0|1, summary JSON}', r'const claimed = await cache\.eval', ['follow_defense_summary.ts'])
L('follow_defense.finishSummary', 'dimabot/src/utils/follow_defense_summary.ts:140', ['fd.summary', 'fd.summaries', 'fd.summary.lock'],
  ['1: channelId', '2: token', '3: summary id', '4: delivered count', '5: completed "1"|"0"', '6: retention'], '{1, ""} / {0, ""}', r"await cache\.eval\(`\s*$|if redis\.call\('GET', KEYS\[3\]\) ~= ARGV\[2\]",
  ['follow_defense_summary.ts'])
L('moderation.recordOffense', 'dimabot/src/utils/moderation/offenses.ts:18', ['mod.offenses', 'mod.offense.receipt'], ['1: window seconds'], 'count', r'.', ['moderation/offenses.ts'])
L('moderation.spamBudget', 'dimabot/src/utils/moderation/spam.ts:115', ['mod.spam.budget'], ['1: per-channel limit', '2: global limit'], '1 / 0 (uses redis TIME)', r'.', ['moderation/spam.ts'])
L('moderation.variationBudget', 'dimabot/src/utils/moderation/variation_jobs.ts:58', ['mod.variation'], ['1: missing word count'], '1 / 0', r'.', ['variation_jobs.ts'])
L('keywords.setIfRevision', 'dimabot/src/utils/keyword_cache.ts:22 and :59 (Rust copy keywords.rs:34 SET_IF_REVISION_SCRIPT, library only)', ['kw.index|kw.body', 'kw.revision'],
  ['1: observed revision', '2: JSON'], '1 saved / 0 raced', r"if \(redis\.call\('get', KEYS\[2\]\) or '0'\) == ARGV\[1\]", ['keyword_cache.ts'], notes='TTL 86400 (index) or 30 (body) is a literal in the script text.')
L('rateLimit.hit', 'dimabot/src/utils/rate_limit.ts:18 (inline, text on :19)', ['ratelimit'], ['1: window seconds'], '{count, ttl}', r'.', ['rate_limit.ts'])
L('widget.COUNT_SCRIPT', 'dimabot/src/widget_feed/signals.ts:46', ['widget.signal.rate', 'widget.signal.skipped'], ['1: seconds'], 'count', r'COUNT_SCRIPT', ['widget_feed/signals.ts'])
L('ast_timer.ENQUEUE', 'dimabot/src/utils/ast_timer_runtime.ts:26', ['ast.timer.job', 'ast.timer.index', 'ast.timer.channel'],
  ['1: job JSON', '2: id', '3: dueAt', '4: expiresAt', '5: now', '6: grace ms', '7: max pending', '8: max per channel'], '1 accepted / 0 limit', r'\bENQUEUE\b', ['ast_timer_runtime.ts'])
L('ast_timer.CLAIM', 'dimabot/src/utils/ast_timer_runtime.ts:39', ['ast.timer.job', 'ast.timer.index', 'ast.timer.channel'], ['1: id', '2: now'], 'raw job JSON or nil', r'\bCLAIM\b', ['ast_timer_runtime.ts'])
L('rust.follow_defense_baseline.BACKLOG_HEALTH', 'dima-rust/src/workers/follow_defense_baseline.rs:28', ['fd.baseline.due'], ['1: now ms'], '{count, oldest score string}', r'.', [], mode='EVAL (redis::cmd("EVAL"))')
L('rust.ai_usage_receipts.reclaim', 'dima-rust/src/workers/ai_usage_receipts/queue.rs:160', ['q.receipts.processing', 'q.receipts'], [], 'moved count', r'.', [], mode='EVAL (redis::cmd("EVAL"))')
L('rust-lib.READ_PLAN_ACCOUNT_SCRIPT', 'dima-rust/src/utils/plan_cache_fence.rs:102 (library only)', ['accounts.data', 'plan.fence'], ['1: max fields', '2: max bytes'], '{status, HGETALL array}', r'.', [],
  mode='EVALSHA via redis::Script::invoke_async (falls back to EVAL on NOSCRIPT) and explicit EVALSHA pipelines (plan_cache_fence.rs:535, twitch_streamers/adapters.rs:433)')
L('rust-lib.twitch_streamers.{OBSERVE,PUBLISH,EVICT,VALIDATE,VALIDATE_ACCOUNTS,VALIDATE_IDS,IDS,HASH_IDS,KICK,RELEASE}', 'dima-rust/src/utils/twitch_streamers/adapters.rs:177-266 (library only)',
  ['accounts.data', 'plan.fence', 'rs.directory.revision', 'rs.directory.generation', 'streamers.by.id', 'twitch.accounts', 'streamers.by.name', 'rs.streamers.lease'],
  ['see source'], 'see source', r'.', [], notes='IDS uses SSCAN and HASH_IDS uses SCAN inside Lua: SCAN touches undeclared keys and is not allowed/atomic under Dragonfly\'s default Lua flags. '
  'PUBLISH sets or HDELs the "id" field depending on completeness: TS readers treat a hash without id as "not cached".', mode='EVALSHA via Script::invoke_async / EVALSHA pipeline')
L('rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}', 'dima-rust/src/utils/twitch_tokens/adapters.rs:162-218 (library only)',
  ['accounts.data', 'streamers.by.id', 'twitch.accounts', 'app.bot', 'rs.directory.generation', 'locks.refresh'], ['see source'], '1 / 0', r'.', [], mode='EVAL (redis::cmd("EVAL"))')

# ----------------------------------------------------------------------------------------------
# Non-key operations (pub/sub, lifecycle, multi) — matched so coverage is exact
# ----------------------------------------------------------------------------------------------
NONKEY = [
    (r'\.(connect|destroy|quit|duplicate|on)\(|isOpen|unref', 'connection lifecycle'),
    (r'\.multi\(\)|\.exec\(\)', 'MULTI/EXEC wrapper (keys recorded on the queued commands)'),
    (r'\.publish\(|\.subscribe\(|\.unsubscribe\(', 'pub/sub (see pubsub section)'),
    (r'sendCommand\(args', 'dimadb raw command passthrough'),
    (r'\.info\(\)', 'INFO (dima-analytics collectors)'),
    (r'fs\.unlink|\.unlink\(outputPath|\.unlink\(filePath', 'not Redis (filesystem)'),
    (r'"PING"', 'PING on connect (utils/redis.rs)'),
]
# In-memory Map/LRU caches that the scanner sees because their receiver is named *cache*: not Redis.
INMEMORY = [r'keywordIndexCache\.get', r'queryCache\.', r'^\s*(const saved = )?cache\.(get|set)\(id', r'cache\.keys\(\)\.next', r'cache\.set\(key, \{ value, until', r'const hit = cache\.get\(key\)']
# TS call sites touching several key patterns at once (or a pattern variable).
TS_MULTI = {
    'dimabot/src/site_agent/cleanup.ts:13': ['sa.usersessions', 'sa.daily', 'sa.prefs'],
    'dimabot/src/site_agent/cleanup.ts:24': ['sa.usersessions'],
    'dimabot/src/site_agent/cleanup.ts:26': ['sa.session', 'sa.items', 'sa.items.order', 'sa.ctx', 'sa.queue'],
    'dimabot/src/site_agent/store.ts:154': ['sa.session', 'sa.items', 'sa.items.order', 'sa.ctx', 'sa.queue'],
    'dimabot/src/site_agent/store.ts:225': ['sa.session', 'sa.items', 'sa.items.order', 'sa.ctx', 'sa.queue', 'sa.usersessions'],
    'dimabot/src/server/routes/follow_defense.route.ts:256': ['fd.state', 'fd.tracked', 'fd.recent', 'fd.summary', 'fd.summary.lock'],
    'dimabot/src/utils/permissions/roles.ts:212': ['roles.editors', 'roles.editors.ids', 'roles.editors.legacy'],
    'dimabot/src/utils/billing.ts:312': ['ai.exhaust', 'ai.exhaust.legacy'], 'dimabot/src/utils/billing.ts:314': ['ai.exhaust', 'ai.exhaust.legacy'],
    'dimabot/src/server/routes/admin_site.route.ts:956': ['ai.exhaust', 'ai.exhaust.legacy'],
    'dimabot/src/handlers/tts_queue.handler.ts:1152': ['tts.queue'], 'dimabot/src/handlers/tts_queue.handler.ts:1153': ['tts.queue.data'],
    'dimabot/src/utils/ai/threading/thread_store.ts:85': ['thread.active', 'thread.user'], 'dimabot/src/utils/ai/threading/thread_store.ts:91': ['thread.active', 'thread.user'],
    'dimabot/src/utils/ai/threading/thread_store.ts:104': ['thread.active', 'thread.user'],
    'dimabot/src/handlers/clip_queue.handler.ts:293': ['clips.queue.data'], 'dimabot/src/handlers/clip_queue.handler.ts:296': ['clips.queue.data'],
    'dimabot/src/utils/follow_defense.ts:506': ['fd.queue', 'fd.queue.data'],
    'dimabot/src/utils/permissions/roles.ts:411': ['roles.editors.ids', 'roles.admins.ids'], 'dimabot/src/utils/permissions/roles.ts:418': ['roles.editors', 'roles.admins'],
    'dimabot/src/site_agent/usage.ts:245': ['sa.feedback'], 'dimabot/src/site_agent/usage.ts:249': ['sa.feedback'], 'dimabot/src/site_agent/usage.ts:250': ['sa.feedback'],
    'dimabot/src/utils/ai/docs_assistant/docs_assistant.ts:213': ['docs.answer'], 'dimabot/src/utils/ai/docs_assistant/docs_assistant.ts:216': ['docs.answer'],
}

PUBSUB = [
    dict(channel='twitch:{channelId}:clip:request', payload='JSON ClipRequestData {clipID, streamerLogin, duration, clipUrl, title, game, streamer, profileImage, description, streamerColor, timestamp} + timestamp added by PubSubManager.publish',
         publishers=['dimabot/src/functions/clips/queue.clip.ts:81 (PubSubManager.publishClipRequest)'], subscribers=['dimabot/src/handlers/clip_queue.handler.ts:41 (PubSubManager.subscribeToClipRequests, per channel)'],
         client='PubSubManager dedicated publisher/subscriber connections (client.duplicate())'),
    dict(channel='tts:session-ended:v1', payload='JSON {channelID, session, timestamp}', publishers=['dimabot/src/utils/speech.ts:29 (clearSpeechFiles; called by domain_events/stream_operations_events.ts:143)'],
         subscribers=['dimabot/src/server/index.ts:99 (api; validates /^\\d{1,30}$/ channelID, session ≤64 chars)'], client='PubSubManager'),
    dict(channel='widget-feed', payload='JSON WidgetFeedMessage {channel, type: "chat"|"chat.delete"|"chat.clear"|"signal"|session refresh types, data} + timestamp',
         publishers=['dimabot/src/widget_feed/publisher.ts:49/66 (chat events, gated by widget-feed:demand:{c})', 'dimabot/src/widget_feed/signals.ts:64 (signals)', 'dimabot/src/widget_feed/session-refresh.ts:9'],
         subscribers=['dimabot/src/overlays/live.ts:278 (api overlay sockets)'], client='PubSubManager'),
    dict(channel='keywords:changed', payload='JSON {channelID} (published raw on the shared command client — no timestamp field)', publishers=['dimabot/src/utils/keyword_cache.ts:47 (refreshKeywordIndex)'],
         subscribers=['dimabot/src/utils/keyword_cache.ts:32 (PubSubManager.subscribe; invalidates in-memory index)'], client='publish: getDragonflyClient main connection; subscribe: PubSubManager'),
    dict(channel='domain-events:wakeup:v1', payload='"1" (hint only; Mongo polling is the fallback)', publishers=['dimabot/src/utils/domain_event_wakeups.ts:100 (domainEventWakeups.publish(), called from utils/domain_events.ts:143)'],
         subscribers=['dimabot/src/workers/domain_events.worker.ts:117 (DomainEventWakeups with onWake)'],
         client='Dedicated short-lived client per DomainEventWakeups: disableOfflineQueue, reconnectStrategy false, commandsQueueMaxLength 4, idle close after 30 s; DOMAIN_EVENTS_WAKEUPS_ENABLED=false disables'),
    dict(channel='pet:runtime:wake:v1', payload='JSON array of owner ObjectId hex strings (≤64)', publishers=['dimabot/src/pets/wakeups.ts:24 (PetWakeupPublisher.notify)'],
         subscribers=['dimabot/src/pets/runtime.ts:420 (subscribePetWakeups)', 'dimabot/src/desktop_ai/activity.ts:322 (subscribePetWakeups)'], client='DomainEventWakeups machinery with the PET_WAKE topic'),
]

STREAMS = [dict(stream='site_agent:t:{turnId}:ev', xadd='XADD key MAXLEN ~ 4000 * e <JSON AgentEvent> (node-redis TRIM {strategy:MAXLEN, strategyModifier:"~", threshold:4000}); EXPIRE 7200 after each add',
                writer='dimabot/src/site_agent/store.ts:329 (appendEvent, api)', readers=['dimabot/src/site_agent/store.ts:349,353 XRANGE (eventsAfter: cursor-exclusive replay, gap detection by first id)',
                                                                                          'dimabot/src/site_agent/store.ts:252 XREVRANGE + - COUNT 1 inside MULTI (snapshot last event id)'],
                consumerGroups='none (no XREADGROUP/XACK/XCLAIM anywhere); readers poll XRANGE plus an in-process EventEmitter bus', deadLetter='none',
                notes='Stream ids compared numerically by compareIds (ms-seq). Only stream in the system.')]

QUEUES = [
    dict(name='cron:jobs:queue (+ cron:jobs:dead-letter, cron:jobs:dedupe:*, cron:jobs:accepted:*)', kind='list',
         producers=['api/bot/cron via utils/cron_jobs_queue.ts enqueueCronJob: Lua ENQUEUE_DEDUPLICATED_JOB (LPUSH) or plain LPUSH (:170)', 'follow_ledger.worker.ts:158 RPUSH (requeue)'],
         consumer='cron:follow-ledger (workers/follow_ledger.worker.ts:165) BLPOP cron:jobs:queue 5 s on the shared command connection; only job "follow-ledger-sync" is processed, others RPUSHed to cron:jobs:dead-letter',
         semantics='LPUSH + BLPOP = LIFO for fresh jobs; requeues go to the tail (RPUSH). No processing list: a crash after BLPOP loses the job (dedupe marker expires). Channel lock cron:follow-ledger:running:{c}.'),
    dict(name='cron:stream-memory:queue → cron:stream-memory:processing (dead: cron:stream-memory:dead-letter)', kind='list + processing list + Mongo CronJobIntent',
         producers=['enqueueCronJob durable path → durable_cron_jobs.ts PUBLISH_DURABLE_CRON_JOB (LPUSH if LPOS miss)', 'stream_memory.worker.ts:200 RPUSH requeue'],
         consumer='cron:stream-memory (workers/stream_memory.worker.ts:372) BLMOVE queue processing LEFT RIGHT 5 s via sendCommand on the shared connection, then LREM processing 1 raw on success',
         semantics='Head pop after LPUSH = LIFO. Recovery RPOPLPUSH processing → queue (≤100) between jobs while holding worker:stream-memory:lock. Mongo intent claim is authoritative; Redis is transport.'),
    dict(name='cron:clip-recommendations:queue → :processing (dead: :dead-letter)', kind='list + processing list + Mongo CronJobIntent',
         producers=['enqueueCronJob durable path → PUBLISH_DURABLE_CRON_JOB (LPUSH)', 'CLIP_CLAIM_SCRIPTS.requeue (LPUSH)'],
         consumer='cron:vod-clip-recommender (workers/vod_clip_recommender.worker.ts:296) BLMOVE queue processing RIGHT LEFT (FIFO), ack/requeue/dead-letter via owner-fenced Lua (CLIP_CLAIM_SCRIPTS)',
         semantics='Every transition is fenced by worker:clip-recommendations:lock value; recover = RPOPLPUSH processing → queue.'),
    dict(name='cron:ai-usage-receipts:queue → :processing (dead: :queue:dead, attempts: :queue:attempts:{sha256})', kind='list + processing list',
         producers=['dimabot/src/utils/ai_usage_ledger.ts:115 RPUSH (api/bot/cron)', 'fail Lua RPUSH requeue'],
         consumer='rust:ai-usage-receipts (dima-rust/src/workers/ai_usage_receipts/queue.rs:164 claim Lua LPOP→RPUSH processing; complete/fail Lua). TypeScript consumer code still exists in ai_usage_queue_health.ts helpers.',
         semantics='FIFO. Poll (no blocking op). Max 3 attempts (1 for invalid JSON). Startup reclaim RPOP processing → LPUSH queue. Single consumer guarded by worker:ai-usage-receipts:lock.'),
    dict(name='cron:ai-usage-backfills:queue → :processing (dead: :dead, dedupe: :dedupe:v{n}:{c}:{cust})', kind='list + processing list',
         producers=['utils/ai_usage_backfill_queue.ts ENQUEUE_SCRIPT (SET NX dedupe + RPUSH)'], consumer='cron:ai-usage-backfill (claimUsageJob → LPOP/RPUSH Lua, poll loop) guarded by worker:ai-usage-backfill:consumer',
         semantics='FIFO; startup RECLAIM LPOP processing → LPUSH queue; dedupe key released by owner-checked DEL with value job.id.'),
    dict(name='observability:v1:inbox → observability:v1:processing', kind='list', producers=['every TS process telemetry.ts flushTelemetry (Lua ENQUEUE: LPUSH, LTRIM 0 99, overflow INCRBY)', 'rust cron-index supervisor telemetry (same Lua)'],
         consumer='dima-analytics/src/index.mjs:142 LINDEX processing 0 else LMOVE inbox processing RIGHT LEFT; LREM processing 1 raw after ingest', semantics='FIFO, bounded to 100 batches, single consumer.'),
    dict(name='twitch:follow-defense:queue (+ :queue:data:{eventId})', kind='zset delay queue', producers=['utils/follow_defense_queue.ts:232 ZADD score now (api/bot)'],
         consumer='cron:follow-defense processFollowDefenseQueue (utils/follow_defense.ts:497) ZRANGEBYSCORE 0 now, first 50; ZREM+DEL on success, ZADD now+5000 on failure', semantics='at-least-once; no lease (single worker lock worker:follow-defense:lock).'),
    dict(name='twitch:moderation:banmod:restore:queue (+ :data:{jobId})', kind='zset delay queue', producers=['utils/ast_parser/functions/moderation.functions.ts:86/168 ZADD'],
         consumer='same file :114 ZRANGEBYSCORE 0 now; claim by ZREM result == 1', semantics='ZREM-as-claim gives single delivery across processes.'),
    dict(name='follow:defense:baseline:due', kind='zset schedule', producers=['utils/follow_defense_baseline.ts:34 ZADD LT score now (request)'],
         consumer='rust:follow-defense-baseline (workers/follow_defense_baseline.rs:285 ZRANGE 0 0 WITHSCORES; rescore +60 s before work, +3600 s after)', semantics='TS processDefenseBaseline is dead code; Rust owns consumption.'),
    dict(name='ast:timers:pending (+ ast:timers:job:{id}, ast:timers:channel:{c})', kind='zset schedule', producers=['utils/ast_timer_runtime.ts ENQUEUE Lua'],
         consumer='AstTimerScheduler (bot) reconcile every 2 s + CLAIM Lua (at-most-once)', semantics='Claim deletes before execution.'),
    dict(name='twitch:{c}:tts:queue (+ :queue:data:{id}, :processing, :session)', kind='zset per channel', producers=['tts_queue.handler.ts:250 / pets/tts_lane.ts:43 → tts ENQUEUE Lua'],
         consumer='api TtsQueueHandler (POP Lua; processing marker SET EX 150)', semantics='Session-fenced; RESET from cron:domain-events then pub/sub tts:session-ended:v1.'),
    dict(name='twitch:{c}:clips:queue (+ :queue:data:{clipID})', kind='zset per channel', producers=['functions/clips/queue.clip.ts:76 (bot command) and clip_queue.handler.ts:67'],
         consumer='api ClipQueueHandler ZPOPMIN', semantics='Wake-up via pub/sub twitch:{c}:clip:request.'),
    dict(name='desktop-ai:queue:{owner}', kind='zset slot reservation', producers=['desktop_ai/service.ts reserveQueueScript'], consumer='same (ZREM on finish)', semantics='bounded outstanding requests (20) per owner.'),
    dict(name='site_agent:s:{id}:queue, site_agent:polar:retry, site_agent:reconcile', kind='list', producers=['site_agent/store.ts:297 RPUSH', 'site_agent/usage.ts:139/262/325 RPUSH (MULTI with LTRIM, EXPIRE)'],
         consumer='site_agent/store.ts:307 LPOP / :313 MULTI LRANGE+DEL; usage.ts:198/289 LPOP count', semantics='api-internal.'),
    dict(name='twitch:temporary-roles:pending-announcements:{c}', kind='list', producers=['utils/temporary_roles_announcements.ts:53 RPUSH'], consumer=':93 LRANGE then DEL', semantics='read-all-then-delete (not atomic).'),
]

TRANSACTIONS = [
    ('dimabot/src/handlers/tts_queue.handler.ts:1152', 'MULTI ZREM tts:queue <waiting ids> + DEL tts:queue:data:{id}... EXEC'),
    ('dimabot/src/site_agent/store.ts:101', 'MULTI HSET site_agent:t:{id} rev json, EXPIRE, SADD site_agent:active EXEC'),
    ('dimabot/src/site_agent/store.ts:153', 'MULTI EXPIRE session keys + ZADD/EXPIRE site_agent:sessions:{c}:{u} EXEC'),
    ('dimabot/src/site_agent/store.ts:164', 'MULTI SET session EX, SET ctx "[]" EX EXEC'),
    ('dimabot/src/site_agent/store.ts:225', 'MULTI DEL session keys, ZREM user sessions EXEC'),
    ('dimabot/src/site_agent/store.ts:234', 'MULTI HSET items, EXPIRE, [RPUSH :order, EXPIRE] EXEC'),
    ('dimabot/src/site_agent/store.ts:249', 'MULTI LRANGE :order, HGETALL items, [XREVRANGE ev + - COUNT 1] EXEC — results consumed positionally'),
    ('dimabot/src/site_agent/store.ts:313', 'MULTI LRANGE queue 0 -1, DEL queue EXEC (atomic drain)'),
    ('dimabot/src/site_agent/usage.ts:139,155,225,248,262,325', 'MULTI HINCRBY.../RPUSH+LTRIM+EXPIRE EXEC'),
    ('dimabot/src/utils/ai/docs_assistant/docs_assistant.ts:158,167,202,219', 'MULTI HINCRBY + EXPIRE (+HSET answer, LPUSH/LTRIM recent) EXEC; :158 reads HINCRBY result [0]'),
    ('dimabot/src/utils/keyword_cache.ts:43', 'MULTI INCR keywords:revision:{c}, DEL keywords:index:{c}, [DEL keywords:body:{c}:{id}] EXEC'),
    ('dima-analytics/src/channel-names.mjs:26', 'MULTI of up to 50 HGET accounts:twitch:{id}:data name (used as a pipeline)'),
]


# ----------------------------------------------------------------------------------------------
# 4. Matching
# ----------------------------------------------------------------------------------------------
def file_ok(entry_files, f, line=None):
    if not entry_files:
        return True
    tag = f'{f}:{line}'
    return any((x in f) or (x in tag) for x in entry_files)


def delegating_files(ts_sites):
    """Files that reference a Redis client type/factory but issue no command themselves (they pass the client to helpers)."""
    have = {s['file'] for s in ts_sites}
    out = []
    for root in TS_ROOTS:
        for dp, _, fn in os.walk(os.path.join(ROOT, root)):
            if 'node_modules' in dp or '/dist' in dp:
                continue
            for f in fn:
                if re.search(r'\.test\.|testutil|test-helper', f) or not re.search(r'\.(ts|mjs|js)$', f):
                    continue
                p = os.path.join(dp, f)
                if re.search(r"getDragonflyClient|from ['\"]redis['\"]|RedisClientType|RoleCacheClient|SignalRedis", open(p, encoding='utf8').read()):
                    rel = os.path.relpath(p, ROOT)
                    if rel not in have:
                        out.append(rel)
    return sorted(out)


def classify(site):
    text, ctx, f = site['text'], site['ctx'], site['file']
    if any(re.search(rx, text) for rx in INMEMORY):
        return ('nonkey', 'not Redis (in-process Map/LRU cache)')
    tag = f"{f}:{site['line']}"
    if tag in TS_MULTI:
        return ('multi', TS_MULTI[tag])
    for rx, what in NONKEY:
        if re.search(rx, text) and site['method'] in ('connect', 'destroy', 'quit', 'duplicate', 'multi', 'exec', 'publish', 'subscribe', 'unsubscribe',
                                                       'sendCommand', 'info', 'unlink', 'PING', 'lSet', 'persist', 'on'):
            return ('nonkey', what)
    if site['method'] in ('eval', 'EVAL', 'invoke', 'EVALSHA') or (site['method'] == 'script-key'):
        for lua in LUA:
            if lua['files'] and not file_ok(lua['files'], f):
                continue
            if not lua['files']:
                continue
            if re.search(lua['callers_re'], text) or re.search(lua['callers_re'], ctx):
                return ('lua', lua['id'])
    for scope in ('text', 'ctx'):
        s = text if scope == 'text' else ctx
        for k in KEYS:
            if not file_ok(k['files'], f, site['line']):
                continue
            for rx in k['match']:
                if re.search(rx, s):
                    return ('key', k['id'])
    return (None, None)


# Rust deployed/lib manual mapping (file:line → key ids) for redis::cmd sites whose key arg is on a later line.
RUST_MAP = {
    'dima-rust/src/workers/dashboard_emote_catalog.rs:96': ['emote.catalog'], 'dima-rust/src/workers/dashboard_emote_catalog.rs:186': ['app.token'],
    'dima-rust/src/workers/dashboard_emote_catalog.rs:238': ['app.token'], 'dima-rust/src/workers/dashboard_emote_catalog.rs:260': ['emote.catalog'],
    'dima-rust/src/workers/raid_sessions.rs:208': ['fd.state'],
    'dima-rust/src/workers/follow_defense_baseline.rs:98': ['lua:rust.follow_defense_baseline.BACKLOG_HEALTH'],
    'dima-rust/src/workers/follow_defense_baseline.rs:285': ['fd.baseline.due'], 'dima-rust/src/workers/follow_defense_baseline.rs:308': ['fd.baseline'],
    'dima-rust/src/workers/follow_defense_baseline.rs:388': ['fd.baseline.due'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:38': ['nonkey:EVAL helper (scripts recorded at their call lines 92, 125, 160, 164, 168, 179)'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:92': ['lua:EXTEND_LOCK_SCRIPT'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:125': ['lua:ownerDelete'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:160': ['lua:rust.ai_usage_receipts.reclaim'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:164': ['lua:aiusage.claim'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:168': ['lua:aiusage.complete'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:179': ['lua:aiusage.fail'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:70': ['lock.receipts', 'locks.aiusage'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:188': ['ai.receipts.generation'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:221': ['logger'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:251': ['q.receipts', 'q.backfills'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:256': ['q.receipts.processing', 'q.backfills.processing'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:261': ['q.receipts.dead', 'q.backfills.dead'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:266': ['q.receipts', 'q.backfills'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:272': ['aiusage.health'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:327': ['aiusage.health.snapshot'], 'dima-rust/src/workers/ai_usage_receipts/queue.rs:335': ['aiusage.health'],
    'dima-rust/src/workers/ai_usage_receipts/queue.rs:345': ['aiusage.health.alert'],
    'dima-rust/src/supervisor/telemetry.rs:517': ['lua:telemetry.ENQUEUE'], 'dima-rust/src/utils/redis.rs:128': ['nonkey:PING'],
    'dima-rust/src/utils/logger/redis.rs:30': ['logger'],
    'dima-rust/src/utils/cron_queue.rs:413': ['lua:ENQUEUE_DEDUPLICATED_JOB'], 'dima-rust/src/utils/cron_queue.rs:475': ['cronjobs.dedupe'],
    'dima-rust/src/utils/cron_queue.rs:489': ['q.cronjobs'], 'dima-rust/src/utils/cron_queue.rs:506': ['q.cronjobs', 'q.cronjobs.dead'],
    'dima-rust/src/utils/plan_cache_fence.rs:514': ['lua:WRITE_PLAN_ACCOUNT_SCRIPT', 'lua:CHECK_PLAN_ACCOUNTS_SCRIPT', 'lua:ACCEPT_PLAN_CREDITS_SCRIPT', 'lua:INVALIDATE_PLAN_SCRIPT', 'lua:SYNC_CREDITS_SCRIPT'],
    'dima-rust/src/utils/plan_cache_fence.rs:535': ['lua:rust-lib.READ_PLAN_ACCOUNT_SCRIPT'], 'dima-rust/src/utils/plan_cache_fence.rs:578': ['lua:rust-lib.READ_PLAN_ACCOUNT_SCRIPT'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:155': ['accounts.data'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:158': ['locks.refresh'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:227': ['rs.directory.generation'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:241': ['accounts.data'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:297': ['lua:rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:302': ['streamers.by.id'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:303': ['twitch.accounts'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:363': ['lua:rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:368': ['twitch.accounts'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:369': ['app.bot'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:410': ['locks.refresh'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:425': ['locks.refresh'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:440': ['lua:rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:454': ['app.token'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:455': ['app.token'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:471': ['app.token'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:472': ['app.token'],
    'dima-rust/src/utils/twitch_tokens/adapters.rs:485': ['lua:rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}'], 'dima-rust/src/utils/twitch_tokens/adapters.rs:489': ['app.bot'],
}
for ln in (382, 403, 433, 495, 496, 511, 542, 543, 557, 579, 599, 619, 636, 689, 719, 770, 788, 809, 823, 824):
    RUST_MAP[f'dima-rust/src/utils/twitch_streamers/adapters.rs:{ln}'] = ['lua:rust-lib.twitch_streamers.{OBSERVE,PUBLISH,EVICT,VALIDATE,VALIDATE_ACCOUNTS,VALIDATE_IDS,IDS,HASH_IDS,KICK,RELEASE}']


def role(method):
    if method in BOTH:
        return 'readwrite'
    if method in WRITE_METHODS:
        return 'write'
    if method in READ_METHODS:
        return 'read'
    return 'readwrite'


def build(check_only=False):
    pmap = process_map()
    ts_sites = scan_ts()
    rs_sites = scan_rs()
    keyidx = {k['id']: k for k in KEYS}
    luaidx = {l['id']: l for l in LUA}
    for k in KEYS:
        k['writers'], k['readers'], k['luaRefs'], k['_procs'] = [], [], [], set()
    for l in LUA:
        l['callSites'] = []
    unmatched, nonkey = [], []
    counts = collections.Counter()

    def ref(site):
        return dict(at=f"{site['file']}:{site['line']}", op=site['method'], process=file_procs(site['file'], pmap))

    def attach_key(kid, site, r=None):
        k = keyidx[kid]
        entry = ref(site)
        rr = r or role(site['method'])
        if site['method'] in ('set', 'SET') and re.search(r'\bNX\b|"NX"', site['ctx']):
            rr = 'readwrite'  # SET NX: the reply tells the caller whether the key existed
        if rr in ('write', 'readwrite'):
            k['writers'].append(entry)
        if rr in ('read', 'readwrite'):
            k['readers'].append(entry)
        k['_procs'].update(entry['process'])

    def attach_lua(lid, site):
        l = luaidx[lid]
        entry = ref(site)
        l['callSites'].append(entry)
        tag = f"{site['file']}:{site['line']}"
        chosen = None
        for frag, ks in sorted(l['site_keys'].items(), key=lambda kv: -len(kv[0])):
            if frag in tag:
                chosen = ks; break
        for kid in (chosen if chosen is not None else l['keys']):
            for part in kid.split('|'):
                part = part.replace('q.*.', 'q.receipts.') if part.startswith('q.*.') else part
                if part in keyidx:
                    keyidx[part]['luaRefs'].append(dict(script=lid, **entry))
                    keyidx[part]['_procs'].update(entry['process'])

    for site in ts_sites:
        kind, val = classify(site)
        counts[kind] += 1
        if kind == 'key':
            attach_key(val, site)
        elif kind == 'multi':
            for kid in val:
                attach_key(kid, site)
        elif kind == 'lua':
            attach_lua(val, site)
        elif kind == 'nonkey':
            nonkey.append(dict(at=f"{site['file']}:{site['line']}", op=site['method'], what=val))
        else:
            unmatched.append(site)
    for site in rs_sites:
        tag = f"{site['file']}:{site['line']}"
        if site['method'] == 'script-key' and tag not in RUST_MAP:
            continue
        targets = RUST_MAP.get(tag)
        if not targets:
            unmatched.append(site)
            counts[None] += 1
            continue
        counts['rust'] += 1
        for t in targets:
            if t.startswith('lua:'):
                attach_lua(t[4:], site)
            elif t.startswith('nonkey:'):
                nonkey.append(dict(at=tag, op=site['method'], what=t[7:]))
            else:
                attach_key(t, site)
    return pmap, ts_sites, rs_sites, unmatched, nonkey, counts


if __name__ == '__main__':
    check = '--check' in sys.argv
    pmap, ts_sites, rs_sites, unmatched, nonkey, counts = build()
    print(f'TS/JS call sites: {len(ts_sites)}  Rust command sites: {len(rs_sites)}  classified: {dict(counts)}  unmatched: {len(unmatched)}')
    for u in unmatched:
        print(f"UNMATCHED {u['file']}:{u['line']} {u['method']}: {u['text'][:150]}")
    if check:
        sys.exit(1 if unmatched else 0)
    from dragonfly_ledger_out import write_outputs  # noqa: E402  (kept separate to keep this file readable)
    write_outputs(pmap, ts_sites, rs_sites, unmatched, nonkey, counts, KEYS, LUA, PUBSUB, STREAMS, QUEUES, TRANSACTIONS)
