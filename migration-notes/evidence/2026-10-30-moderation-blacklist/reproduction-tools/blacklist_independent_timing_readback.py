import collections,hashlib,json,statistics,sys
from pathlib import Path
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
w=s/'artifacts/moderation-blacklist'/sys.argv[1]
report_dir=sys.argv[2] if len(sys.argv)>2 else 'paired1'
p=w/report_dir/'blacklist-paired-report.json';d=json.loads(p.read_text());fixture=json.loads((w/'benchmark/moderation-blacklist-benchmark.json').read_text())
assert d['status']=='passed' and d['hashesBefore']==d['hashesAfter'] and len(d['order'])==56
results={}
for name,x in d['workloads'].items():
 assert len(x['samples'])==7
 checksum=2166136261
 for _ in range(d['iterations']):
  for case in fixture['suites'][name]:
   e=case['evaluation']
   for n in [int(e['triggered']),*(e['matchedText'] or []),65536]: checksum=((checksum^n)*16777619)&0xffffffff
 assert checksum==x['expected']['checksum']
 results[name]={}
 for actor in ['node','rust']:
  vals=[]
  for i,pair in enumerate(x['samples']):
   assert pair['pair']==i+1 and pair['order']==(['node','rust'] if i%2==0 else ['rust','node'])
   q=pair[actor];assert q['checksum']==checksum and q['operations']==x['expected']['operations']==d['iterations']*len(fixture['suites'][name]) and q['warmups']==3
   vals.append(int(q['nanoseconds'])/q['operations'])
  assert statistics.median(vals)==x['metrics'][actor]['medianNsPerOperation']
  results[name][actor]={'medianNsPerOperation':statistics.median(vals),'minNsPerOperation':min(vals),'maxNsPerOperation':max(vals),'samples':vals}
 results[name]['rustTimeReductionPercent']=100*(1-results[name]['rust']['medianNsPerOperation']/results[name]['node']['medianNsPerOperation'])
assert all(x['exit']=={'code':0,'signal':None} for x in d['order'])
r={'all56ActorExitsZero':True,'independentPreparedFixtureChecksumsVerified':True,'sourceAndBinaryHashesUnchanged':True,'iterations':d['iterations'],'results':results}
out=w/report_dir/'independent-timing-readback.json';assert not out.exists();out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
