#!/usr/bin/env python3
"""Map every Mongoose model call in dimabot/src to its collection, with flags.
usage: python3 mongo_code_usage.py <repo-root> <schemas.json> <out.json>"""
import json, os, re, sys
from collections import defaultdict

root, schemas_path, out_path = sys.argv[1:4]
src_root = os.path.join(root, 'dimabot/src')
models = json.load(open(schemas_path))['models']

def rel(p): return os.path.relpath(p, os.path.join(root, 'dimabot'))
def lineno(text, idx): return text.count('\n', 0, idx) + 1

files = []
for d, _, fs in os.walk(src_root):
    if 'node_modules' in d: continue
    files += [os.path.join(d, f) for f in fs if f.endswith(('.ts', '.mts', '.js')) and not f.endswith('.d.ts')]
texts = {f: open(f, encoding='utf8').read() for f in files}

# 1. identifier -> model per defining file (named exports + default export)
exports = defaultdict(dict)  # file -> {exportName|'default': modelName}
local = defaultdict(dict)    # file -> {localIdent: modelName}
for name, m in models.items():
    f, ln = m['file'].rsplit(':', 1); full = os.path.join(root, 'dimabot', f); t = texts[full]
    lines = t.split('\n'); i = int(ln) - 1
    ctx = '\n'.join(lines[max(0, i - 2):i + 1])
    mm = re.search(r'(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:mongoose\.)?model\b[^\n]*$', ctx, re.M) or re.search(r'(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:mongoose\.)?$', ctx, re.M)
    if 'export default model' in lines[i]: exports[full]['default'] = name; continue
    if mm:
        ident = mm.group(1); local[full][ident] = name; exports[full][ident] = name
        if re.search(r'^export default\s+' + ident + r'\s*;?\s*$', t, re.M): exports[full]['default'] = name

def resolve(frm, spec):
    if not spec.startswith('.'): return None
    p = os.path.normpath(os.path.join(os.path.dirname(frm), spec))
    for cand in (re.sub(r'\.js$', '.ts', p), p, p + '.ts', re.sub(r'\.mjs$', '.mts', p)):
        if cand in texts: return cand
    return None

imp_re = re.compile(r'import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*[\'"]([^\'"]+)[\'"]', re.S)
dyn_re = re.compile(r'(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*[\'"]([^\'"]+)[\'"]\s*\)')
METHODS = 'find|findOne|findById|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|findOneAndReplace|findByIdAndRemove|updateOne|updateMany|replaceOne|deleteOne|deleteMany|insertMany|create|countDocuments|estimatedDocumentCount|exists|distinct|aggregate|bulkWrite|bulkSave|watch|init|syncIndexes|createIndexes|ensureIndexes|diffIndexes|hydrate|where|startSession|validate|createCollection|listIndexes|cleanIndexes'
NATIVE = 'insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|find|findOne|findOneAndUpdate|findOneAndReplace|findOneAndDelete|aggregate|bulkWrite|countDocuments|distinct|createIndex|createIndexes|dropIndex|watch'

def call_extent(t, open_idx):
    depth, i, q = 0, open_idx, None
    while i < len(t):
        c = t[i]
        if q:
            if c == '\\': i += 2; continue
            if c == q: q = None
        elif c in '\'"`': q = c
        elif c in '([{': depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0: break
        i += 1
    end = i + 1
    m = re.match(r'(\s*\.\s*\w+\s*\((?:[^()]|\([^()]*\))*\))*', t[end:end + 400])
    return t[open_idx:end], t[end:end + (m.end() if m else 0)]

FLAGS = {
    'upsert': r'upsert\s*:\s*true', 'setOnInsert': r'\$setOnInsert', 'session': r'\bsession\b', 'arrayFilters': r'arrayFilters',
    'timestampsOption': r'timestamps\s*:', 'strictOption': r'\bstrict\s*:', 'runValidators': r'runValidators', 'setDefaultsOnInsert': r'setDefaultsOnInsert',
    'overwrite': r'overwrite\s*:', 'returnNew': r'new\s*:\s*true|returnDocument\s*:\s*[\'"]after', 'updatePipeline': r'^\(\s*[^,]+,\s*\[',
    'lean': r'\.lean\s*\(', 'populate': r'\.populate\s*\(', 'select': r'\.select\s*\(|projection', 'cursor': r'\.cursor\s*\(', 'inc': r'\$inc', 'push': r'\$push|\$addToSet', 'unset': r'\$unset',
    'ordered': r'ordered\s*:', 'hint': r'\.hint\s*\(|hint\s*:', 'collation': r'collation', 'maxTimeMS': r'maxTimeMS', 'allowDiskUse': r'allowDiskUse',
}
usage = defaultdict(list)
is_test = lambda f: bool(re.search(r'\.test\.|\.testutil\.', f))
unattributed = []
for f, t in texts.items():
    idents = dict(local.get(f, {}))
    for m in imp_re.finditer(t):
        target = resolve(f, m.group(3))
        if not target or target not in exports: continue
        if m.group(1) and 'default' in exports[target]: idents[m.group(1)] = exports[target]['default']
        for part in (m.group(2) or '').split(','):
            part = part.strip().replace('type ', '')
            if not part: continue
            a, _, b = part.partition(' as ')
            if a.strip() in exports[target]: idents[(b or a).strip()] = exports[target][a.strip()]
    for m in dyn_re.finditer(t):
        target = resolve(f, m.group(2))
        if not target or target not in exports: continue
        for part in m.group(1).split(','):
            a, _, b = part.strip().partition(':')
            if a.strip() in exports[target]: idents[(b or a).strip()] = exports[target][a.strip()]
    # fallback: destructured dynamic imports such as `const [{ X }] = await Promise.all([import('...x.schema.js')])`
    for target, ex in exports.items():
        base = os.path.basename(target).rsplit('.', 1)[0]
        if target == f or base not in t: continue
        for ident, mname in ex.items():
            if ident != 'default' and ident not in idents and re.search(r'\{[^}]*\b' + ident + r'\b[^}]*\}', t): idents[ident] = mname
    if not idents: continue
    alt = '|'.join(sorted(map(re.escape, idents), key=len, reverse=True))
    for m in re.finditer(r'(?<![\w.$])(' + alt + r')\s*\.\s*(?:(collection)\s*\.\s*(' + NATIVE + r')|(' + METHODS + r'))\s*(?:<[^()]*?>)?\s*\(', t):
        ident = m.group(1); native = bool(m.group(2)); meth = m.group(3) or m.group(4)
        args, chain = call_extent(t, m.end() - 1)
        whole = args + chain
        flags = [k for k, rx in FLAGS.items() if re.search(rx, args if k == 'updatePipeline' else whole, re.M)]
        usage[models[idents[ident]]['collection']].append({'at': f'{rel(f)}:{lineno(t, m.start())}', 'model': idents[ident], 'op': ('collection.' if native else '') + meth, 'flags': flags + (['test'] if is_test(f) else []) + (['script'] if '/scripts/' in f or '/migrations/' in f else [])})
    for m in re.finditer(r'new\s+(' + alt + r')\s*\(', t):
        usage[models[idents[m.group(1)]]['collection']].append({'at': f'{rel(f)}:{lineno(t, m.start())}', 'model': idents[m.group(1)], 'op': 'new', 'flags': []})

# 2. global patterns (file:line lists)
GLOBAL = {
    'transactions_sessions': r'startSession\s*\(|withTransaction\s*\(|startTransaction\s*\(|commitTransaction|abortTransaction',
    'save_calls': r'\.save\s*\(',
    'setOnInsert': r'\$setOnInsert',
    'upsert_true': r'upsert\s*:\s*true',
    'bulkWrite': r'\.bulkWrite\s*\(|bulkSave\s*\(',
    'aggregate': r'\.aggregate\s*(?:<[^()]*>)?\s*\(',
    'lean': r'\.lean\s*(?:<[^()]*>)?\s*\(',
    'populate': r'\.populate\s*\(',
    'decimal128_long_int32': r'\bDecimal128\b|\bInt32\b|(?<![\w.])Long\.from|\bmongo\.Long\b|Schema\.Types\.(?:Decimal128|BigInt|Double|Int32)|\bBigInt\b.*Schema',
    'objectid_construct_or_check': r'new\s+(?:mongoose\.)?(?:Types\.|mongo\.)?ObjectId\s*\(|isValidObjectId|ObjectId\.isValid|Types\.ObjectId\.createFromHexString|ObjectId\.createFromHexString',
    'findById': r'\.findById(?:AndUpdate|AndDelete|AndRemove)?\s*\(',
    'change_streams_watch': r'\.watch\s*\(',
    'markModified': r'markModified\s*\(',
    'toObject_toJSON': r'\.toObject\s*\(|\.toJSON\s*\(',
    'where_js': r'\$where|\$function|\$accumulator',
    'text_search': r'\$text\b|\$search\b',
    'discriminator': r'\.discriminator\s*\(',
    'timestamps_override': r'timestamps\s*:\s*false',
    'strict_override': r'strict\s*:\s*false|strictQuery',
    'raw_db_access': r'connection\.db\b|connection\.collection\s*\(|getClient\s*\(\)|MongoClient|GridFSBucket|\.collection\s*\.\s*(?:' + NATIVE + r')\s*\(',
    'native_insert_bypasses_defaults': r'\.collection\s*\.\s*(?:insertOne|insertMany|bulkWrite|updateOne|updateMany|replaceOne)\s*\(',
}
glob = {}
for k, rx in GLOBAL.items():
    hits = []
    for f, t in sorted(texts.items()):
        if re.search(r'\.test\.|\.testutil\.|/__tests__/', f): continue
        for m in re.finditer(rx, t): hits.append(f'{rel(f)}:{lineno(t, m.start())}')
    glob[k] = {'count': len(hits), 'at': hits}

# 3. lean results that a route sends to the client (heuristic: same file under server/ with res.json/res.send near the lean call)
lean_http = []
for f, t in texts.items():
    if '/server/' not in f or '.test.' in f: continue
    lines = t.split('\n')
    for m in re.finditer(r'\.lean\s*(?:<[^()]*>)?\s*\(', t):
        ln = lineno(t, m.start())
        win = '\n'.join(lines[ln - 1: ln + 25])
        if re.search(r'res\s*\.\s*(?:status\([^)]*\)\s*\.\s*)?(?:json|send)\s*\(', win): lean_http.append(f'{rel(f)}:{ln}')
glob['lean_near_http_response'] = {'count': len(lean_http), 'at': sorted(lean_http), 'note': 'heuristic: .lean() in a server/ file with res.json/res.send within the next 25 lines'}

json.dump({'byCollection': {k: sorted(v, key=lambda x: x['at']) for k, v in sorted(usage.items())}, 'global': glob}, open(out_path, 'w'), indent=1)
print('collections with usage', len(usage), 'calls', sum(map(len, usage.values())))
for k, v in glob.items(): print(k, v['count'])
