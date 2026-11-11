// Read-only field census for every collection in the current database (mongosh).
// Level 1: exact over all documents. Level 2 (+ array elements): $sample of up to SAMPLE docs.
const SAMPLE = 300, ARRAY_PEEK = 20, MAP_COLLAPSE = 40;
const result = {};
const t2 = { k: '$$s.k', t: { $type: '$$s.v' } };
for (const name of db.getCollectionNames().sort()) {
  const col = db.getCollection(name);
  const total = col.estimatedDocumentCount();
  // exact level-1 census
  const lvl1 = col.aggregate([
    { $project: { f: { $map: { input: { $objectToArray: '$$ROOT' }, as: 's', in: t2 } } } },
    { $unwind: '$f' }, { $group: { _id: { k: '$f.k', t: '$f.t' }, n: { $sum: 1 } } }
  ], { allowDiskUse: true }).toArray();
  // sampled deep census
  const pre = total > SAMPLE ? [{ $sample: { size: SAMPLE } }] : [];
  const docs = col.aggregate([...pre, { $project: { f: { $map: { input: { $objectToArray: '$$ROOT' }, as: 'e', in: {
    k: '$$e.k', t: { $type: '$$e.v' },
    sub: { $switch: { branches: [
      { case: { $eq: [{ $type: '$$e.v' }, 'object'] }, then: { $map: { input: { $objectToArray: '$$e.v' }, as: 's', in: t2 } } },
      { case: { $eq: [{ $type: '$$e.v' }, 'array'] }, then: { $reduce: { input: { $slice: ['$$e.v', ARRAY_PEEK] }, initialValue: [], in: { $concatArrays: ['$$value',
        [{ k: '[]', t: { $type: '$$this' } }],
        { $cond: [{ $eq: [{ $type: '$$this' }, 'object'] }, { $map: { input: { $objectToArray: '$$this' }, as: 'y', in: { k: { $concat: ['[].', '$$y.k'] }, t: { $type: '$$y.v' } } } }, []] }] } } } },
    ], default: [] } } } } } } }]).toArray();
  const paths = {}; const subkeys = {};
  const bump = (p, t, docIdx) => { const e = paths[p] ??= { types: {}, docs: new Set(), nullDocs: new Set() }; e.types[t] = (e.types[t] || 0) + 1; e.docs.add(docIdx); if (t === 'null' || t === 'undefined') e.nullDocs.add(docIdx); };
  docs.forEach((d, i) => { for (const f of d.f) { bump(f.k, f.t, i); for (const s of f.sub || []) { const k = s.k.startsWith('[]') ? f.k + s.k : f.k + '.' + s.k; (subkeys[f.k] ??= new Set()).add(s.k.replace(/^\[\]\.?/, '')); bump(k, s.t, i); } } });
  // collapse dynamic-key objects (Maps / id-keyed objects)
  const collapsed = [];
  for (const [parent, keys] of Object.entries(subkeys)) {
    const plain = [...keys].filter(k => k !== '');
    if (plain.length > MAP_COLLAPSE) {
      collapsed.push({ parent, distinctKeys: plain.length });
      for (const p of Object.keys(paths)) {
        const m = p.match(new RegExp('^' + parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\.|\\[\\]\\.)([^.]+)$'));
        if (m) { const tgt = parent + m[1] + '<key>'; const src = paths[p]; const e = paths[tgt] ??= { types: {}, docs: new Set(), nullDocs: new Set() }; for (const [t, n] of Object.entries(src.types)) e.types[t] = (e.types[t] || 0) + n; src.docs.forEach(x => e.docs.add(x)); src.nullDocs.forEach(x => e.nullDocs.add(x)); delete paths[p]; }
      }
    }
  }
  const sampled = docs.length;
  const deep = {};
  for (const [p, e] of Object.entries(paths).sort()) deep[p] = { types: e.types, presentDocs: e.docs.size, nullDocs: e.nullDocs.size, missingDocs: sampled - e.docs.size };
  const top = {};
  for (const r of lvl1) { const e = top[r._id.k] ??= { types: {}, present: 0 }; e.types[r._id.t] = r.n; e.present += r.n; }
  const exactCount = col.countDocuments({});
  for (const e of Object.values(top)) { e.missing = exactCount - e.present; e.null = e.types.null || 0; }
  result[name] = { count: exactCount, sampled, sampleMethod: total > SAMPLE ? '$sample' : 'all', topLevelExact: top, sampledPaths: deep, collapsedDynamicKeys: collapsed };
}
print(EJSON.stringify(result, { relaxed: true }));
