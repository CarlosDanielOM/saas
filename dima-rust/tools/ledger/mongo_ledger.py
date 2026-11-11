#!/usr/bin/env python3
"""Merge schema dump + DB stats + census + code usage into dima-rust/ledger/mongo.json.
usage: python3 mongo_ledger.py <repo-root> <workdir>   (workdir holds schemas.json colls.json census.json usage.json)"""
import json, os, re, subprocess, sys
from collections import defaultdict

root, wd = sys.argv[1:3]
L = lambda n: json.load(open(os.path.join(wd, n)))
schemas, colls, census, usage = L('schemas.json')['models'], L('colls.json')['collections'], L('census.json'), L('usage.json')

EXPECT = {'String': {'string'}, 'Number': {'int', 'double', 'long'}, 'Date': {'date'}, 'Boolean': {'bool'}, 'ObjectId': {'objectId'},
          'Buffer': {'binData'}, 'Decimal128': {'decimal'}, 'Array': {'array'}, 'Map': {'object'}, 'Embedded': {'object'}, 'UUID': {'binData'},
          'BigInt': {'long'}, 'Double': {'double'}, 'Int32': {'int'}, '__nested': {'object'}}
NOISE_SUB_OPTS = {'strictQuery', 'id', 'autoIndex', 'capped', 'typeKey', 'discriminatorKey', 'optimisticConcurrency', 'collection', 'collation', 'timeseries', 'autoCreate'}

def clean_schema(s, sub=False):
    o = {k: v for k, v in s['options'].items() if v is not None and not (sub and k in NOISE_SUB_OPTS)}
    if not sub: o = {k: v for k, v in o.items() if k not in ('capped', 'autoIndex', 'autoCreate', 'strictQuery') or v not in (False, None)}
    paths = {}
    for p, d in s['paths'].items():
        d = dict(d)
        if p == '_id' and d.get('auto'): d.pop('setters', None)
        if 'subdocument' in d: d['subdocument'] = clean_schema(d['subdocument'], True)
        if 'itemsSubdocument' in d: d['itemsSubdocument'] = clean_schema(d['itemsSubdocument'], True)
        if isinstance(d.get('mapOf'), dict) and 'subdocument' in d['mapOf']: d['mapOf'] = {'subdocument': clean_schema(d['mapOf']['subdocument'], True)}
        paths[p] = d
    r = {'options': o, 'paths': paths}
    if s.get('nested'): r['nested'] = s['nested']
    for k in ('virtuals', 'statics', 'methods'):
        if s.get(k): r[k] = s[k]
    if sub: r['subdocHasId'] = '_id' in s['paths']
    return r

# schema -> data paths at census granularity: a, a.b, a[], a[].b
def data_paths(schema, prefix='', depth=0, out=None, wild=None):
    out = {} if out is None else out; wild = set() if wild is None else wild
    for p, d in schema['paths'].items():
        segs = p.split('.')
        for i in range(1, len(segs)):
            out.setdefault(prefix + '.'.join(segs[:i]), '__nested')
        full = prefix + p; inst = d['instance']
        if inst == 'Mixed': wild.add(full)
        if inst == 'Map': wild.add(full)
        out[full] = inst
        if inst == 'Array':
            if 'itemsSubdocument' in d:
                out[full + '[]'] = 'Embedded'
                if not prefix: data_paths(d['itemsSubdocument'], full + '[].', depth + 1, out, wild)
            else:
                it = (d.get('items') or {}).get('instance', 'Mixed'); out[full + '[]'] = it
                if it == 'Mixed': wild.add(full + '[]')
        if inst == 'Embedded' and 'subdocument' in d and not prefix: data_paths(d['subdocument'], full + '.', depth + 1, out, wild)
    return out, wild

def covered(path, sp, wild, strict):
    if path in sp: return True
    if strict is False: return True
    parts = re.split(r'(?=\.|\[\])', path)
    acc = ''
    for part in parts[:-1]:
        acc += part
        if acc in wild or acc + '[]' in wild: return True
    return False

def dbtypes(cen, path):
    if '.' not in path and '[]' not in path and path in cen['topLevelExact']: return {k: v for k, v in cen['topLevelExact'][path]['types'].items()}, 'exact'
    if path in cen['sampledPaths']: return cen['sampledPaths'][path]['types'], 'sample'
    return None, None

def norm_idx(i):
    o = {k: i[k] for k in ('unique', 'sparse', 'partialFilterExpression', 'expireAfterSeconds', 'collation') if k in i and i[k] not in (False, None)}
    if 'collation' in o: o['collation'] = {k: v for k, v in o['collation'].items() if k in ('locale', 'strength')}
    return json.dumps(list(i['key'].items())), o

# grep-derived user hooks and statics (runtime dump mixes in Mongoose built-ins)
hooks = []
for dp, _, fs in os.walk(os.path.join(root, 'dimabot/src')):
    for fn in fs:
        if not fn.endswith('.ts') or '.test.' in fn: continue
        fp = os.path.join(dp, fn); rp = os.path.relpath(fp, os.path.join(root, 'dimabot'))
        for n, line in enumerate(open(fp, encoding='utf8'), 1):
            m = re.match(r'\s*(\w+)\.(pre|post)\s*(?:<[^>]*>)?\s*\(\s*([\'"][^\'"/]+[\'"]|\[[^\]]*\]|operation)\s*,', line)
            if m: hooks.append({'at': f'{rp}:{n}', 'schemaVar': m[1], 'kind': m[2], 'event': 'updateOne|findOneAndUpdate|updateMany' if m[3] == 'operation' else m[3].strip('\'"')})
hooks.sort(key=lambda h: h['at'])
HOOK_DESC = {
 'src/utils/availability/schema.ts:31': "query hook on updateOne/findOneAndUpdate/updateMany (commands, redemptionrewards via addAvailabilityFields): unless the query is flagged internalWrite(), strips any availability*/availabilityLease* keys from the update and, if the update sets the enabled field (commands.enabled / redemptionrewards.isEnabled), adds $set.availability = {token: randomUUID(), previousEnabled, restoreAt: null, pending: true, nextAt: now}",
 'src/utils/availability/schema.ts:48': 'pre-save (same two collections): on a loaded doc whose enabled field changed, sets availability = availabilityState(enabled)',
 'src/schemas/admin.schema.ts:28': 'sets updatedAt = new Date() on every save()',
 'src/schemas/app_config.schema.ts:19': 'sets refreshed_at = new Date() on every save()',
 'src/schemas/channel_ai_personality.schema.ts:342': 'pre-validate: ensureProfiles() normalises profiles[] / activeProfileId',
 'src/schemas/channel_ai_personality.schema.ts:347': 'pre-save: ensureProfiles(); loads users by accounts.id=channelID (throws if missing); enforces plan-tier limits on profiles/rules/knownUsers (throws); rewrites profiles[].createdAt (keep)/updatedAt (now); sets contextWindow 35/15/7 by plan_tier',
 'src/schemas/clip_design.schema.ts:51': 'sets updatedAt = new Date() on every save()',
 'src/schemas/clip_design.schema.ts:56': 'if isDefault: updateMany({channelID, _id:{$ne}}, {isDefault:false}) (single-default invariant)',
 'src/schemas/event.schema.ts:203': 'sets updatedAt = new Date() on every save()',
 'src/schemas/referral_code.schema.ts:64': 'lower-cases code when modified',
}
for h in hooks: h['does'] = HOOK_DESC.get(h['at'], '')
file_of = {m: s['file'].rsplit(':', 1)[0] for m, s in schemas.items()}

rust_usage = defaultdict(set)
for line in subprocess.run(['bash', '-c', f"cd {root}/dima-rust && grep -rnoE 'collection(_with_options)?(::<[A-Za-z_]+>)?\\(\\s*\"[a-z_.]+\"' src; grep -rn 'const COLLECTION' src"], capture_output=True, text=True).stdout.splitlines():
    m = re.match(r'([^:]+):(\d+):.*\"([a-z_.]+)\"', line)
    if m: rust_usage[m[3]].add(f'dima-rust/{m[1]}:{m[2]}')
rust_usage['users'] |= {'dima-rust/src/utils/twitch_streamers/adapters.rs', 'dima-rust/src/utils/twitch_tokens/adapters.rs:21'}

RAW = {  # raw-driver / non-model access (file:line), from grep of connection.db / collection() / MongoClient / GridFSBucket
 'private_assets.files': ['dimabot/src/assets/library.ts:42 (GridFSBucket private_assets)', 'dimabot/src/assets/library.ts:66 (deleteOne)'],
 'private_assets.chunks': ['dimabot/src/assets/library.ts:42 (GridFSBucket private_assets)', 'dimabot/src/assets/library.ts:65 (deleteMany)'],
 'overlay_media.files': ['dimabot/src/overlays/delivery-store.ts:20 (GridFSBucket overlay_media)', 'dimabot/src/overlays/delivery-store.ts:34 (find metadata.expiresAt)'],
 'overlay_media.chunks': ['dimabot/src/overlays/delivery-store.ts:20 (GridFSBucket overlay_media)', 'dimabot/src/overlays/delivery-store.ts:35 (distinct/deleteMany files_id)'],
 'overlay_deliveries': ['dimabot/src/overlays/delivery-store.ts:18 (collection<SavedDelivery>)', 'dimabot/src/overlays/live.ts:343,344,358(replaceOne upsert),380,503,746'],
 'overlay_source_leases': ['dimabot/src/overlays/delivery-store.ts:19 (collection<SavedPeer>)', 'dimabot/src/overlays/live.ts:336,354(replaceOne upsert),387,747'],
 'channels': ['dimabot/src/utils/migrations/channels_to_users.ts:7 (legacy one-shot migration read)'],
 'commands': ['dimabot/src/utils/migrations/migrate_ast_function_syntax.js:198 (legacy migration)'],
 'eventsubs': ['dimabot/src/utils/migrations/migrate_ast_function_syntax.js:246 (legacy migration)'],
 'site_agent_changes': ['dimabot/src/site_agent/cleanup.ts:35 (mongoose.connection.collection().deleteMany)'],
 'domain_events': ['dimabot/src/utils/domain_events.ts:124 (DomainEventSchema.collection.insertOne(doc.toObject()) - bypasses Mongoose insert, defaults come from toObject())'],
 'users': ['dima-analytics/src/channel-names.mjs:35 (find accounts.$elemMatch {type,id}; projection accounts.type/id/name)'],
 '*': ['dimadb/server/mongo.mjs:59-119 (generic DB console: find/findOne/replaceOne/insertOne/deleteOne on any collection, EJSON round-trip)', 'dimabot/src/scripts/backup_full_database.script.ts:98 (reads every collection)'],
}
SCHEMALESS_NOTE = {
 'botinfos': 'legacy/unknown: no reader or writer in dimabot/src, dima-rust/src, dima-analytics, dimadb/server, dimafx/server (grep "botinfo")',
 'channels': 'legacy: only read by the one-shot migration dimabot/src/utils/migrations/channels_to_users.ts:7 (pre-users schema)',
 'overlay_deliveries': 'raw driver collection (no Mongoose model): dimabot/src/overlays/delivery-store.ts:18; shape = interface SavedDelivery (delivery-store.ts:15); TTL handled by code deleteMany, no TTL index',
 'overlay_source_leases': 'raw driver collection (no Mongoose model): dimabot/src/overlays/delivery-store.ts:19; shape = interface SavedPeer (delivery-store.ts:16)',
 'overlay_media.files': 'GridFS bucket overlay_media (delivery-store.ts:20); metadata.expiresAt swept by sweepFiles()',
 'overlay_media.chunks': 'GridFS bucket overlay_media (delivery-store.ts:20)',
 'private_assets.files': 'GridFS bucket private_assets (dimabot/src/assets/library.ts:42)',
 'private_assets.chunks': 'GridFS bucket private_assets (dimabot/src/assets/library.ts:42)',
}

by_coll = defaultdict(list)
for name, m in schemas.items(): by_coll[m['collection']].append(name)
all_colls = sorted(set(colls) | set(by_coll))
out = {}
summary = defaultdict(list)
for c in all_colls:
    db = colls.get(c); cen = census.get(c)
    e = {'collection': c, 'existsInDb': db is not None}
    if db:
        e['db'] = {'count': cen['count'] if cen else db.get('count'), 'avgObjSize': db.get('avgObjSize'), 'size': db.get('size'), 'storageSize': db.get('storageSize'), 'totalIndexSize': db.get('totalIndexSize'),
                   'collectionOptions': db.get('options') or {}, 'indexes': db['indexes']}
        e['census'] = {'sampled': cen['sampled'], 'sampleMethod': cen['sampleMethod'], 'topLevelExact': cen['topLevelExact'], 'sampledPaths': cen['sampledPaths'], 'collapsedDynamicKeys': cen['collapsedDynamicKeys']}
    e['models'] = []
    for mn in by_coll.get(c, []):
        m = schemas[mn]
        e['models'].append({'modelName': mn, 'definedAt': 'dimabot/' + m['file'], 'schema': clean_schema(m['schema']), 'declaredIndexes': m['indexes'],
                            'hooks': [h for h in hooks if h['at'].startswith(file_of[mn]) or (h['at'].startswith('src/utils/availability/schema.ts') and c in ('commands', 'redemptionrewards'))]})
    e['codeUsage'] = usage['byCollection'].get(c, [])
    e['rawAccess'] = RAW.get(c, [])
    e['rustUsage'] = sorted(rust_usage.get(c, []))
    if not by_coll.get(c): e['status'] = 'schemaless'; e['schemalessNote'] = SCHEMALESS_NOTE.get(c, 'unknown'); summary['schemaless'].append(c)
    elif not db: e['status'] = 'schema-without-collection'; summary['schemaWithoutCollection'].append(c)
    else: e['status'] = 'modeled'
    # diffs
    if by_coll.get(c) and db and cen:
        sch = schemas[by_coll[c][0]]['schema']
        sp, wild = data_paths(sch); strict = sch['options'].get('strict')
        datap = set(cen['topLevelExact']) | set(cen['sampledPaths'])
        notInSchema = sorted(p for p in datap if not covered(p, sp, wild, strict))
        grammar = re.compile(r'^[^.\[]+(\[\])?(\.[^.\[]+)?$')
        cand = [p for p, inst in sp.items() if inst != '__nested' and p not in datap and grammar.match(p) and not any(p.startswith(w + '.') or p.startswith(w + '[]') for w in wild)]
        neverSeen = sorted(p for p in cand if not (p.endswith('[]') and p[:-2] in datap))
        emptyArrays = sorted(p[:-2] for p in cand if p.endswith('[]') and p[:-2] in datap)
        variance = []
        for p in sorted(datap):
            types, src = dbtypes(cen, p)
            if not types: continue
            nn = {t for t in types if t not in ('null', 'undefined', 'missing')}
            inst = sp.get(p)
            exp = EXPECT.get(inst) if inst and p not in wild else None
            mism = sorted(nn - exp) if exp else []
            if len(nn) > 1 or mism:
                kind = 'mismatch' if mism else ('number-width' if nn <= {'int', 'double', 'long'} else 'mixed')
                variance.append({'path': p, 'schemaType': inst or ('wildcard' if not covered(p, {}, set(), None) and covered(p, sp, wild, strict) else None), 'types': types, 'source': src, 'kind': kind, 'unexpected': mism})
        dec = {norm_idx(i)[0]: (norm_idx(i)[1], i) for m in by_coll[c] for i in schemas[m]['indexes']}
        have = {norm_idx(i)[0]: (norm_idx(i)[1], i) for i in db['indexes'] if i['name'] != '_id_'}
        e['diffs'] = {
            'dataFieldsNotInSchema': notInSchema,
            'schemaFieldsNeverSeen': neverSeen if e['db']['count'] else 'collection empty',
            'arraysAlwaysEmptyInSample': emptyArrays if e['db']['count'] else [],
            'typeVariance': variance,
            'indexesDeclaredMissingInDb': [dec[k][1] for k in dec if k not in have],
            'indexesInDbNotDeclared': [have[k][1] for k in have if k not in dec],
            'indexOptionMismatch': [{'key': json.loads(k), 'declared': dec[k][0], 'db': have[k][0]} for k in dec if k in have and dec[k][0] != have[k][0]],
        }
        if len(by_coll[c]) > 1: e['diffs']['note'] = f'{len(by_coll[c])} models share this collection; diffs use {by_coll[c][0]}'
    out[c] = e

meta = {
 'generatedFrom': {'schemas': 'dima-rust/tools/ledger/mongo_schemas.mts (runtime introspection of every mongoose model, Mongoose ' + L('schemas.json')['mongooseVersion'] + ')',
                   'db': 'dima-rust/tools/ledger/mongo_census.js against local stale copy domdimabot (read-only)', 'usage': 'dima-rust/tools/ledger/mongo_code_usage.py', 'merge': 'dima-rust/tools/ledger/mongo_ledger.py'},
 'counts': {'collectionsInDb': len(colls), 'documentsInDb': sum(v['count'] for v in census.values()), 'models': len(schemas), 'modelFiles': len({m['file'].rsplit(':', 1)[0] for m in schemas.values()}),
            'collectionsModeled': sum(1 for v in out.values() if v['status'] == 'modeled'), 'schemaless': len(summary['schemaless']), 'schemaWithoutCollection': len(summary['schemaWithoutCollection']), 'modelCalls': sum(len(v) for v in usage['byCollection'].values())},
 'userHooks': hooks,
 'globalPatterns': usage['global'],
 'rawAccessAnyCollection': RAW['*'],
}
os.makedirs(os.path.join(root, 'dima-rust/ledger'), exist_ok=True)
json.dump({'_meta': meta, 'collections': out}, open(os.path.join(root, 'dima-rust/ledger/mongo.json'), 'w'), indent=1, default=str)
print(json.dumps(meta['counts']))
