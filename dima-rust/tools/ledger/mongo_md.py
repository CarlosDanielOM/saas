#!/usr/bin/env python3
"""Render dima-rust/ledger/mongo.md from dima-rust/ledger/mongo.json. usage: python3 mongo_md.py <repo-root>"""
import json, os, sys, collections
root = sys.argv[1]
d = json.load(open(os.path.join(root, 'dima-rust/ledger/mongo.json'))); C = d['collections']; M = d['_meta']; G = M['globalPatterns']
out = []; w = out.append
def ts(o):
    t = o.get('timestamps')
    if not t: return '-'
    if t is True: return 'createdAt/updatedAt'
    return f"{t.get('createdAt')}/{t.get('updatedAt')}"
def flagcount(e, f): return sum(1 for u in e['codeUsage'] if f in u['flags'] and 'test' not in u['flags'])
def opcount(e, *ops): return sum(1 for u in e['codeUsage'] if u['op'] in ops and 'test' not in u['flags'])

c = M['counts']
w('# MongoDB contract ledger (`domdimabot`)\n')
w('Machine-readable source: [`mongo.json`](mongo.json) (keyed by collection). Regenerate with the scripts in `dima-rust/tools/ledger/` (see "How this was produced" at the end).\n')
w('## Headline counts\n')
w('| What | Count | How it was verified |\n|---|---|---|')
w(f"| Collections in DB | **{c['collectionsInDb']}** | `db.getCollectionInfos()` in `mongo_census.js`; every one is a key in `mongo.json` (110 + 2 schema-only = {len(C)} keys) |")
w(f"| Documents in DB | **{c['documentsInDb']:,}** | sum of exact `countDocuments({{}})` per collection (collStats said 1,269,408; the 2-doc gap is stale fast-count metadata) |")
w(f"| Mongoose models | **{c['models']}** in **{c['modelFiles']}** files | runtime introspection: every file in `dimabot/src` that calls `model(` and imports mongoose (90 files, no import errors) was imported with tsx; `mongoose.models` then held 104 models. Cross-checked against `grep model(` (77 files in `src/schemas/` incl. 1 test + `dimafx_retention.ts` helper with no model, and 15 files outside it) |")
w(f"| Collections with a model and data | {c['collectionsModeled']} | |")
w(f"| Collections in DB with no model | {c['schemaless']} | set difference of the two lists above |")
w(f"| Models whose collection does not exist | {c['schemaWithoutCollection']} | `channelconfigs` (ChannelConfig), `chat_logs` (Chat_Log); both models are dead code: no reference outside their schema file |")
w(f"| Model calls mapped to a collection | {c['modelCalls']} | `mongo_code_usage.py` resolves imports/aliases to models and records op + flags per call |")
w('| DB indexes | 398 (110 `_id_`, 4 GridFS, 284 declared) | all 284 declared indexes exist by key; 1 option conflict (below) |\n')

w('## Collections by size, with schema options matrix\n')
w('`_id`: type of the top-level `_id`. `ts`: Mongoose timestamps field names. `__v`: versionKey. `min`: `minimize` (Mongoose default true). `idx`: declared/DB non-`_id` indexes. `calls`: model calls in non-test code (`ups` upserts, `lean`, `agg` aggregates, `new/create` = `new Model()`, `create`, `insertMany`). `rust`: already touched by `dima-rust/src`.\n')
w('| collection | docs | avg B | model (file) | _id | ts | __v | min | idx | calls | ups | lean | agg | new/create | rust |')
w('|---|--:|--:|---|---|---|---|---|---|--:|--:|--:|--:|--:|---|')
for name, e in sorted(C.items(), key=lambda kv: -(kv[1].get('db') or {}).get('count', -1)):
    db = e.get('db') or {}
    if e['models']:
        m = e['models'][0]; o = m['schema']['options']
        model = f"`{m['modelName']}` ({m['definedAt'].replace('dimabot/src/', '')})"
        idt = m['schema']['paths'].get('_id', {}).get('instance', '?')
        idx = f"{len(m['declaredIndexes'])}/{len([i for i in db.get('indexes', []) if i['name'] != '_id_'])}" if db else f"{len(m['declaredIndexes'])}/-"
        row = [model, idt, ts(o), ('-' if o.get('versionKey') is False else str(o.get('versionKey'))), 'false' if o.get('minimize') is False else 'true', idx]
    else:
        row = ['*none* (' + e['status'] + ')', '', '', '', '', f"0/{len([i for i in db.get('indexes', []) if i['name'] != '_id_'])}"]
    calls = len([u for u in e['codeUsage'] if 'test' not in u['flags']])
    w(f"| `{name}` | {db.get('count', '-') if db else 'missing'} | {db.get('avgObjSize', '')} | " + ' | '.join(row) +
      f" | {calls} | {flagcount(e, 'upsert')} | {flagcount(e, 'lean')} | {opcount(e, 'aggregate')} | {opcount(e, 'new', 'create', 'insertMany')} | {'yes' if e['rustUsage'] else ''} |")
w('')

w('## Hooks (user-defined; Mongoose built-ins excluded)\n')
w('| at | hook | what it does | Rust must |\n|---|---|---|---|')
must = {
 'src/schemas/admin.schema.ts:28': 'set `updatedAt` on every full-document write of `admins`',
 'src/schemas/app_config.schema.ts:19': 'set `refreshed_at` (model unused today)',
 'src/schemas/channel_ai_personality.schema.ts:342': 'run the same `ensureProfiles` normalisation before validating',
 'src/schemas/channel_ai_personality.schema.ts:347': 'reproduce tier checks + `contextWindow` + per-profile timestamps in the service layer (the hook only runs on `save()`/`create()`, not on `updateOne`)',
 'src/schemas/clip_design.schema.ts:51': 'set `updatedAt` (collection empty)',
 'src/schemas/clip_design.schema.ts:56': 'clear other defaults for the channel when `isDefault` is saved',
 'src/schemas/event.schema.ts:203': 'set `updatedAt` on save',
 'src/utils/availability/schema.ts:31': 'on every non-internal update of `commands`/`redemptionrewards` that sets `enabled`/`isEnabled`, write the same `availability` object, and never let callers set `availability*` directly (registered by `commands.schema.ts:92`, `redemption_reward.schema.ts:47`)',
 'src/utils/availability/schema.ts:48': 'same on full-document saves when the enabled flag changed',
 'src/schemas/referral_code.schema.ts:64': 'lower-case `code` before writing (and `findByCode` statics lower-cases on read, referral_code.schema.ts:60)',
}
for h in M['userHooks']:
    w(f"| `{h['at']}` | `{h['kind']}('{h['event']}')` | {h['does']} | {must.get(h['at'], '')} |")
w('\nThe only query middleware is the availability hook above; everything else is document `save`/`validate` middleware, which `updateOne`-style writes skip. No `post` hooks, plugins, discriminators, virtuals with setters, or custom getters exist. Statics: `ReferralCode.findByCode` (referral_code.schema.ts:60). Two `save()` helpers live inside `channel_tts_settings.schema.ts:190,193`.\n')

w('## Index diffs (code vs DB)\n')
w('- Declared but missing in DB: **none**. In DB but not declared: **none** except GridFS bucket indexes (`private_assets.*`, `overlay_media.*`, created by the driver) and `_id_`.')
for name, e in C.items():
    for x in (e.get('diffs') or {}).get('indexOptionMismatch', []):
        w(f"- **Option conflict** `{name}` key `{x['key']}`: declared `{json.dumps(x['declared'])}` but DB has `{json.dumps(x['db'])}` (plain non-unique `twitchTransactionID_1`). Mongoose `autoIndex` cannot fix this (same name, different options → IndexOptionsConflict, logged and ignored), so uniqueness of Twitch transaction IDs is **not enforced** in this copy. Rust must not rely on a duplicate-key error here; decide whether to migrate the index (`extension_wallet_transaction.schema.ts:53-56`).")
w('- `users` declares no index at all; DB has only `_id_`, while code queries `accounts.type`+`accounts.id` constantly (and `dima-analytics/src/channel-names.mjs:35` does `$elemMatch`). Performance note, not a compatibility issue.')
w('- TTL indexes (31, all from code): `expireAfterSeconds: 0` on a per-document date (`expiresAt`, `purgeAt`, `expires_at`) everywhere except `moderation_action_logs.createdAt` (30 d), `extensionwallettransactions.createdAt` and `dimafxplaybacks.createdAt` (365 d). Writers must store real BSON dates in these fields or documents never expire.')
w('- Partial unique indexes whose filter a writer must match exactly: `credittransactions.idempotencyKey` (`$type: string`), `pet_runtimes.tokenHash` (`$type: string`), `follow_relationship_ledgers` and `stream_subscription_ledgers` (`status: "active"`), `streamsessions` (`channelID, ended_at` where `ended_at: null`), `usermedialibraryitems` (`isActive: true`), `domain_events` (`dispatchPending: true`; `metadata.durableChatHandled: true`). Sparse: 8 (see `mongo.json`). No collation or text indexes anywhere.\n')

w('## Data vs schema diffs\n')
w('### Fields in data that the schema does not declare\n')
w('Mongoose (`strict: true` everywhere) ignores these on read and drops them from its own writes; they survive only because updates use `$set`.\n')
w('| collection | fields | origin |\n|---|---|---|')
origin = {'channel_tts_settings': 'removed AI-TTS provider feature; legacy', 'channelaipersonalities': 'older documents created before `knownUsers` got `_id: false`',
          'raid_analytics_summaries': '**written by the Rust raid_analytics worker** (`dima-rust/src/workers/raid_analytics.rs`); TS never sees them, and `dashboard.route.ts:81` returns them to the browser via `.lean()`'}
for name, e in sorted(C.items()):
    f = (e.get('diffs') or {}).get('dataFieldsNotInSchema')
    if f: w(f"| `{name}` | {', '.join('`'+x+'`' for x in f)} | {origin.get(name, '')} |")
w('\nAlso: `users.accounts[].access_token` / `refresh_token` are declared as nested `{iv, content}` objects (encrypted, `src/utils/crypto.ts`), present in data as objects.\n')
w('### Schema fields never seen in the sample (top level exact; depth 2 from up to 300 sampled docs)\n')
w('These are optional fields the Rust structs must still model as `Option`/default; they appear only in certain states (leases, pending availability, etc.).\n')
w('| collection | fields |\n|---|---|')
for name, e in sorted(C.items()):
    f = (e.get('diffs') or {}).get('schemaFieldsNeverSeen')
    if isinstance(f, list) and f: w(f"| `{name}` | {', '.join('`'+x+'`' for x in f)} |")
w('\nEmpty collections (no data to compare): ' + ', '.join(f'`{n}`' for n, e in sorted(C.items()) if e.get('db') and e['db']['count'] == 0) + '.\n')

w('### BSON type variance\n')
w('No field holds a type that contradicts its schema type (no string-in-Number, no string dates, no string ObjectIds) in the exact top-level census or the deep sample. All variance is numeric width, apart from the `Mixed` field `events.config[].value`:\n')
w('| collection.field | schema | BSON types seen (count) | source |\n|---|---|---|---|')
for name, e in sorted(C.items()):
    for v in (e.get('diffs') or {}).get('typeVariance', []):
        w(f"| `{name}.{v['path']}` | {v['schemaType'] or ''} | {', '.join(f'{k} {n}' for k, n in v['types'].items())} | {v['source']} |")
w('\n`long` values in `stream_activity_aggregates.bucket` (165,973 docs, including small values such as -1) come from the Rust stream_activity worker writing `i64`; Node never writes `long`. Integral `double` values (e.g. `firstSeq: 27724`) come from writers that store `f64`. `stream_activities.offset` is genuinely fractional (387,304 doubles).\n')

w('## Collections with no Mongoose model\n')
w('| collection | docs | who reads/writes it |\n|---|--:|---|')
for name, e in sorted(C.items()):
    if e['status'] == 'schemaless':
        w(f"| `{name}` | {e['db']['count']} | {e['schemalessNote']} |")
w('\nModels without a collection: `channelconfigs` (`src/schemas/channel_config.schema.ts:28`) and `chat_logs` (`src/schemas/chat_logs.schema.ts:18`). Two more models are unused although their collection exists: `Account` → `accounts` (2 docs) and `app_config` → `app_configs` (1 doc). All four can be dropped from the migration scope after the lead confirms.\n')

w('## Raw driver and non-dimabot access\n')
for name, e in sorted(C.items()):
    for r in e['rawAccess']: w(f'- `{name}`: {r}')
for r in M['rawAccessAnyCollection']: w(f'- any collection: {r}')
w('- `dimafx/server/src`: no MongoDB access (verified by grep for `mongo`).')
w('- Existing Rust (`dima-rust/src`) touches: ' + ', '.join(f'`{n}`' for n, e in sorted(C.items()) if e['rustUsage']) + ' (file:line per collection in `mongo.json` → `rustUsage`).\n')

w('## Usage patterns that need a Rust equivalent\n')
w('Full file:line lists are in `mongo.json` → `_meta.globalPatterns` (tests excluded) and per collection in `codeUsage` (with flags `upsert`, `setOnInsert`, `lean`, `session`, `arrayFilters`, `updatePipeline`, `returnNew`, `select`, …).\n')
w('| pattern | count | where |\n|---|--:|---|')
def top(k, n=12):
    cnt = collections.Counter(a.rsplit(':', 1)[0] for a in G[k]['at'])
    return ', '.join(f'`{f.replace("src/", "")}`×{x}' for f, x in cnt.most_common(n))
for k, label in [('transactions_sessions', 'Transactions / sessions'), ('aggregate', 'Aggregation pipelines'), ('bulkWrite', '`bulkWrite`'), ('upsert_true', 'Upserts (`upsert: true`)'),
                 ('setOnInsert', '`$setOnInsert`'), ('save_calls', '`.save()` on documents (dirty tracking)'), ('lean', '`.lean()`'), ('lean_near_http_response', '`.lean()` result sent to HTTP (heuristic)'),
                 ('findById', '`findById*`'), ('objectid_construct_or_check', 'explicit ObjectId construct/validate'), ('toObject_toJSON', '`toObject()/toJSON()`'),
                 ('native_insert_bypasses_defaults', 'Native `Model.collection.*` writes (bypass casting/defaults/timestamps)'), ('raw_db_access', 'Raw `connection.db` / `MongoClient` / GridFS'), ('where_js', '`$where`')]:
    w(f"| {label} | {G[k]['count']} | {top(k)} |")
w('| `Decimal128` / `Long` / `Int32` / `BigInt` | 0 | none in code; `long` only appears in data written by Rust |')
w('| `populate`, change streams, `$text`, discriminators, `markModified`, `timestamps:false` / `strict:false` query options | 0 | none |\n')
w('Notable specifics:')
w('- **Transaction**: `src/utils/follow_ledger.ts:379-381` (`startSession` + `withTransaction` on `follow_relationship_ledgers`), with a non-transactional fallback when the server is not a replica set (`follow_ledger.ts:388`). The local copy is a standalone `mongod` 8.2.6, so the fallback path is what runs here.')
w('- **Optimistic concurrency via `doc.$where`**: `src/server/services/ai_personality.service.ts:414` sets `$where = {updatedAt, __v}` so the following `save()` only matches an unchanged document. Rust equivalent: `update_one({_id, updatedAt, __v}, …)` and treat `matched_count == 0` as a conflict.')
w('- **Native insert**: `src/utils/domain_events.ts:124` validates a Mongoose doc, then `DomainEventSchema.collection.insertOne(doc.toObject(), {writeConcern: {w: 1, j: true}})`; duplicate key on `eventKey` is the idempotency signal (`domain_events.ts:132`).')
w('- **Number-typed epoch-millisecond times** (not BSON dates): `duel_moderator_restores.dueAt/leaseUntil`, `roulette_channels.dueAt/actionDueAt`, `widget_channels.dueAt`, queried with `Date.now()` (`src/duel/completion.ts:109,111`, `src/roulette/service.ts:173`, `src/roulette/actions.ts:40`, `src/widgets/service.ts:182`). Keep them numbers.')
def features():
    f = collections.defaultdict(list)
    def walk(c, paths, pre=''):
        for p, v in paths.items():
            fp = pre + p
            dft = v.get('default')
            if isinstance(dft, dict) and dft.get('computed'): f['computedDefault'].append(f'{c}.{fp}')
            for k in ('trim', 'immutable', 'required'):
                if v.get(k): f[k].append(f'{c}.{fp}')
            if v.get('select') is False: f['selectFalse'].append(f'{c}.{fp}')
            if v.get('customValidators'): f['customValidators'].append(f'{c}.{fp}')
            if v['instance'] == 'Map': f['Map'].append(f'{c}.{fp}')
            if v['instance'] == 'Mixed' or (v['instance'] == 'Array' and (v.get('items') or {}).get('instance') == 'Mixed'): f['Mixed'].append(f'{c}.{fp}')
            if v.get('enum'): f['enum'].append(f'{c}.{fp}')
            for key, sub in (('itemsSubdocument', '[]'), ('subdocument', '')):
                if key in v:
                    (f['subdocWithId'] if v[key].get('subdocHasId') else f['subdocNoId']).append(f'{c}.{fp}{sub}')
                    walk(c, v[key]['paths'], fp + sub + '.')
    for c, e in C.items():
        for m in e['models']: walk(c, m['schema']['paths'])
    return f
F = features()
w('- **`select: false` fields** (%d) must be excluded from default reads and from HTTP payloads (Mongoose drops them unless a query asks for `+field`): ' % len(F['selectFalse']) + ', '.join(f'`{x}`' for x in F['selectFalse']) + '.')
w('- **Map fields** (%d, keys may not contain `.` or start with `$`): ' % len(F['Map']) + ', '.join(f'`{x}`' for x in F['Map']) + '. **Mixed fields**: %d (list in `mongo.json`; search `\"instance\": \"Mixed\"`).' % len(F['Mixed']))
w('- **Array sub-documents that get an auto `_id`**: ' + ', '.join(f'`{x}`' for x in F['subdocWithId']) + f'. The other {len(F["subdocNoId"])} sub-document paths are declared `_id: false`.')
w('- **Computed defaults** (%d) such as `Date.now`, `() => new Date(0)` for lease fields, `() => ({})`: listed with source in `mongo.json` (`default.computed`). `trim` setters: %d paths (`events.*`, `custom_timers.name/message`, `channelextensionitems.*`). Custom validators: ' % (len(F['computedDefault']), len(F['trim'])) + ', '.join(f'`{x}`' for x in F['customValidators']) + f'. Enums: {len(F["enum"])} paths; `required`: {len(F["required"])} paths.\n')

w('''## Rules a Rust data layer must follow to stay compatible

Mongoose version in use: 8.24.3 with driver 6.21.0 (`dimabot/node_modules`). The connection is opened once in `dimabot/src/utils/databases/mongodb.database.ts:30` as `mongoose.connect(MONGO_URI, { monitorCommands: true })` with no global `mongoose.set(...)` and no plugins, so every Mongoose default applies (`autoIndex: true`, `autoCreate: true`, `strictQuery: false`, `setDefaultsOnInsert: true`, `bufferCommands: true`). Only `src/scripts/reconcile_stream_offline.script.ts:37-38` turns `autoIndex`/`autoCreate` off.

### Collection names and ids
1. Use the exact collection names in the table above. They come from Mongoose's legacy pluraliser (`Countdowntimer` → `countdowntimers`, `ai_usage_daily` → `ai_usage_dailies`, `pet_readiness` stays `pet_readiness`, `ChannelAIMemory` → `channelaimemories`); only `oauth_*` and `site_agent_changes` pass an explicit name. Never derive names in Rust.
2. `_id` type is per collection: 41 collections use **string** `_id` (column `_id`), the rest use **ObjectId**. A Rust struct must use `String` or `ObjectId` accordingly; mixing them breaks `findById` lookups silently (no match, no error).
3. Mongoose casts filter values to the schema type. TS code relies on this in 35 `findById*` calls on ObjectId collections (string from a route param or Redis → ObjectId, e.g. `src/server/routes/site.route.ts:245`, `src/utils/timer_cache.ts:91`, `src/utils/domain_event_consumer.ts:530`) and in `{_id: string}` / `{$in: [strings]}` filters. Rust must parse to `ObjectId` before querying and decide what an invalid hex string does (Mongoose throws `CastError`; the HTTP layer usually turns that into 400/500).
4. Sub-documents in arrays get their own ObjectId `_id` only in `users.accounts[]`, `events.config[]` and `cliprecommendations.candidates[]`; Rust must generate one when it appends to these arrays. Every other sub-document is `_id: false` (but old `channelaipersonalities.knownUsers[]` items still carry an `_id`: tolerate it on read).

### Timestamps (`ts` column)
5. Mongoose maintains timestamps on: `create`/`save` of a new doc (both fields = now); `save()` of a loaded doc **only if something changed** (updatedAt = now); every `updateOne`/`updateMany`/`findOneAndUpdate`/`replaceOne`/`bulkWrite` update op (adds `$set: {updatedAt: now}` even if nothing else changes; for a pipeline update it appends a `{$set: {updatedAt}}` stage) — `mongoose/lib/helpers/update/applyTimestampsToUpdate.js:44-74`.
6. On upserts the creation field goes in `$setOnInsert: {createdAt: now}`; a `createdAt` that the caller put in `$set` or at top level is **deleted** from the update (same file, lines 82-121), because the timestamp path is `immutable`. Rust must do the same: never overwrite the creation field of an existing doc.
7. Field names differ per collection: `created_at`/`updated_at` (13 collections), `createdAt`/`updatedAt` (others). Several collections without the option keep **hand-written** time fields instead: `createdAt` with `default: Date.now` and an `updatedAt` set by a `pre('save')` hook (`admins`, `events`, `clipdesigns`), or nothing at all. Those hand-written `updatedAt` fields are **not** touched by `updateOne`; match TS behaviour per call site, not per collection.
8. No call site disables timestamps (`timestamps: false` appears 0 times), so every TS update bumps `updatedAt`; Rust updates on timestamped collections must too, or TS code that sorts or polls by `updatedAt`/`updated_at` will miss Rust's writes.

### Version key `__v`
9. Collections with `__v` in the matrix get `__v: 0` on create **and on every upsert** (`$setOnInsert: {__v: 0}` added by `mongoose/lib/helpers/update/decorateUpdateWithVersionKey.js:8-26`, called from `model.js:2417,4172`). Plain updates never touch `__v`. `save()` increments it only after array modifications (versioned saves). The existing Rust worker already writes `"__v": 0` on insert (`dima-rust/src/workers/ai_usage_receipts/ledger.rs:116,160`); follow that. Data today: `__v` missing in only 12 docs total (`astvariables` 8, `credittransactions` 2, `titleconfigs` 1, `app_configs` 1).
10. `ai_personality.service.ts:414` uses `__v` + `updatedAt` as an optimistic-concurrency guard, so Rust writers of `channelaipersonalities` must keep `__v` stable on unrelated updates and bump `updatedAt`.
11. The 47 collections with `versionKey: false` (39 of the 41 `_id: String` collections — not `creditgifts` and `dimafxplaybacks`, which keep `__v` — plus `domain_events`, `domain_event_checkpoints`, `domain_event_deliveries`, `cron_job_intents`, `pet_settings`, `site_agent_changes`, `stream_markers`, `stream_participants`) must **not** receive `__v`. Note `follow_defense_settings` and `moderation_action_logs` do keep `__v`.

### Defaults, `minimize` and missing fields
12. `create`/`new` writes every schema default (including computed ones such as `Date.now`, `() => new Date(0)` lease fields, nested defaults) into the document. Upserts write defaults for every path that is not in the filter or update, through `$setOnInsert` (`setDefaultsOnInsert` is on by default: `mongoose/lib/helpers/setDefaultsOnInsert.js:18-24`). A Rust insert or upsert must produce the same fields, or later TS `lean()` readers (which apply no defaults) see `undefined`.
13. Hydrated (non-lean) reads fill missing paths with their defaults in memory, and a later `save()` of that doc **persists** those defaults (`document.js:3633-3650`, gh-2558). So a Rust-written document missing defaulted fields will gain them the next time TS saves it. Rust readers must accept both shapes (`#[serde(default = …)]` with the same default value).
14. `minimize: true` (default; off only for `custom_widgets`, `custom_widget_store`, `site_agent_changes`) removes empty objects when a document is created or saved, and turns an empty object in a `save()` delta into `$unset` (`model.js:421-437`). Empty objects written through `updateOne` are stored as `{}`. Result: e.g. `commands.permissions` (default `{}`) is missing in 5,328 of 5,333 docs. Treat "missing" and `{}` as equal on read; empty arrays are always stored (`[]`).
15. `required`/`enum`/`min`/`max`/custom validators run on `create`/`save` and **not** on `updateOne`/`findOneAndUpdate` (no call site sets `runValidators`). Rust may validate more strictly on new writes but must accept every value those update paths could have stored.
16. `trim` setters (events, custom timers, extension items) apply on Mongoose writes, including `$set` casts. Rust must trim the same fields before writing.

### Unknown fields and strictness
17. Every schema is `strict: true`: Mongoose silently drops paths it does not know from `create`, `save` and update operators. A field written only by Rust (today `raid_analytics_summaries.rustPending` / `rustRefresh`) is invisible to hydrated TS reads, returned verbatim by `.lean()` reads, kept by `$set` updates and lost only if TS replaces the whole document. Add new fields to the Mongoose schema first if TS must keep or read them.
18. `strictQuery: false`: filters on undeclared paths are sent as-is, so TS queries on fields that are not in the schema still work. Rust needs no special handling.
19. Rust structs must **ignore unknown fields** (no `deny_unknown_fields`) because data carries legacy fields (`channel_tts_settings.aiProvider` …, see diffs) and other writers add fields.

### Numbers, dates and BSON types
20. Mongoose `Number` maps to whatever the Node driver produced: `int32` for integers that fit, `double` otherwise; Rust writers have also stored `int64` and integral doubles. **Every `Number` field must deserialize from int32, int64 and double** (see the type-variance table: 26 field paths already mixed). For writes, reuse the existing `js_number` helper (`dima-rust/src/utils/bson_compat.rs`, tested in `dima-rust/src/workers/dashboard_insights.rs:608`: integral values in i32 range → `Int32`, otherwise `Double`) to match Node. Values above 2^53 must not be written as `int64` if TS reads them (Node promotes `long` to a JS number and loses precision).
21. `Date` paths are always BSON dates in data (no string dates found). Mongoose casts numbers or ISO strings to dates in filters and updates; Rust must convert explicitly. Epoch-millisecond fields declared as `Number` (`dueAt`, `leaseUntil`, `actionDueAt` in duel/roulette/widget collections) must stay numbers.
22. TTL indexes only expire BSON dates: always write `expiresAt` / `purgeAt` / `expires_at` / TTL `createdAt` as dates.
23. No `Decimal128`, `Long`, `Int32` or `BigInt` types are used by TS code. `Buffer`/binary only appears in GridFS chunks.

### Reads returned to HTTP clients
24. About 84 `.lean()` reads in `src/server/**` feed `res.json` directly (heuristic list in `mongo.json`, `lean_near_http_response`). Express serialises ObjectId as a 24-hex **string**, dates as `toISOString()` (`2026-11-11T10:00:00.000Z`, millisecond precision, `Z`), and keeps `_id` and `__v` in the payload. No schema sets `toJSON`/`toObject` transforms or virtuals, and the `id` virtual is not serialised. Rust HTTP responses must not emit extended JSON (`{"$oid": …}`, `{"$date": …}`).
25. `select: false` fields are omitted by default from hydrated and lean reads alike; Rust must exclude them explicitly (most are secrets: `overlayToken`, `current_refresh_hash`, `checkoutUrl`, `polar_credit_snapshot`, …).

### Writes, atomicity and indexes
26. Index creation: on first use of each model Mongoose builds the declared indexes (`autoIndex`), and some code calls `Model.init()` explicitly before relying on unique indexes (`src/server/oauth/service.ts:27`, `src/utils/domain_events.ts:123`, `src/utils/domain_event_consumer.ts:474`, `src/utils/durable_cron_jobs.ts:93,146`, `src/utils/paid_order_reward.ts:22`, `src/pets/runtime.ts:411`, `src/pets/state.ts:18`, `src/desktop_ai/service.ts:83,323`, `src/server/services/pet_settings.service.ts:184`). No `syncIndexes`, so indexes are never dropped. Once Rust owns a collection it must create the same indexes (keys + unique/sparse/partial/TTL options from `declaredIndexes`) itself, or keep a TS process that still calls `init()`.
27. Many idempotency paths depend on a duplicate-key error (E11000) from a unique index (`domain_events.eventKey`, `credittransactions.idempotencyKey`, ledgers, receipts). Rust must map error code 11000 to the same "already done" outcome. The `extensionwallettransactions.twitchTransactionID` index is not unique in data (see index diffs).
28. The one multi-document transaction (`follow_ledger.ts:379`) needs a replica set; keep the non-transactional fallback because standalone servers reject sessions.
29. `findOneAndUpdate` defaults to returning the **pre-update** document unless `new: true` / `returnDocument: 'after'` (flag `returnNew` in `codeUsage`). The Rust driver also defaults to `Before`; set `ReturnDocument::After` only where TS does.
30. `Model.collection.*` (native) calls bypass casting, defaults and timestamps: `domain_events.ts:124` (insert of a pre-validated `toObject()`) and the one-shot scripts in `src/scripts/` (`migrate_*`). These are already raw-driver shaped.
''')
w('''## How this was produced

All inputs are reproducible from the repo plus the local read-only `mongodb` container:

```sh
cd dimabot   # model list = files that call model( and import mongoose
grep -rlE "\\bmodel(<[^>]*>)?\\(|mongoose\\.model\\(" src --include='*.ts' | xargs grep -lE "from ['\\"]mongoose['\\"]" | grep -v test | sort > /tmp/model_files.txt
MONGO_URI= REDIS_URL= SECRET_KEY=x npx tsx ../dima-rust/tools/ledger/mongo_schemas.mts /tmp/schemas.json /tmp/model_files.txt   # no DB connection; autoIndex/autoCreate/buffering off
# mongosh --eval "$(cat dima-rust/tools/ledger/mongo_census.js)"  > census.json   (read-only; exact level-1 census + $sample 300 for depth 2)
# collection stats + indexes: $collStats storageStats and getIndexes() per collection > colls.json
python3 dima-rust/tools/ledger/mongo_code_usage.py . schemas.json usage.json
python3 dima-rust/tools/ledger/mongo_ledger.py . <dir with the four json files>
python3 dima-rust/tools/ledger/mongo_md.py .
```

Limits: depth-2 paths come from a sample of up to 300 documents per collection (all documents where the collection is smaller), so rare variants deeper than the top level may be missing; top-level types and missing/null counts are exact. Usage attribution is regex-based: calls through a variable (`durable_cron_jobs.ts:78` `model = dependencies.model || CronJobIntentSchema`) or a generic `this.constructor` are listed in `globalPatterns` but not under a collection. The DB is a stale copy of production, so index and data observations describe that snapshot.
''')
open(os.path.join(root, 'dima-rust/ledger/mongo.md'), 'w').write('\n'.join(out) + '\n')
print('written', len(out), 'blocks')
