import hashlib,json,statistics,sys
from pathlib import Path
wave=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-spam');attempt=int(sys.argv[1]);p=wave/f'paired-attempt{attempt}';r=json.loads((p/'spam-paired-report.json').read_text());assert r['status']=='passed' and r['hashesBefore']==r['hashesAfter'] and len(r['order'])==70
input_path=wave/'benchmark-attempt1/input.json';raw=input_path.read_bytes();assert hashlib.sha256(raw).hexdigest()=='9f54153d86b2f91417733343c744d4f8e17d0a1a6bf744df1779ea3bcad6086b';data=json.loads(raw)
def checksum(cases,rounds):
 h=2166136261
 def add(n):
  nonlocal h;h=((h^n)*16777619)&0xffffffff
 def visit(v):
  kind=v['kind']
  if kind in ['undefined','hole','null']:add(['undefined','hole','null'].index(kind))
  elif kind=='boolean':add(3);add(int(v['value']))
  elif kind=='number':
   add(4)
   for c in v['bits'].encode('ascii'):add(c)
  elif kind=='string':
   add(5)
   for u in v['utf16']:add(u)
   add(65536)
  elif kind=='array':
   add(6);add(len(v['items']))
   for x in v['items']:visit(x)
  elif kind=='object':
   add(7);add(len(v['entries']))
   for key,x in v['entries']:
    for u in key:add(u)
    add(65536);visit(x)
  elif kind=='date':add(8);visit(v['milliseconds'])
  else:raise AssertionError(kind)
 for _ in range(rounds):
  for c in cases:visit(c['result']['value']);add(65537)
 return h
metrics={};pos=0
for name,w in r['workloads'].items():
 expected=checksum(data['workloads'][name],r['rounds']);assert w['expected']=={'operations':8000,'checksum':expected}
 assert len(w['samples'])==7;metrics[name]={}
 for i,s in enumerate(w['samples']):
  order=['node','rust'] if i%2==0 else ['rust','node'];assert s['order']==order
  for actor in order:
   m=json.loads((p/f'sample-{actor}-{name}-{i+1}.json').read_text());assert m==s[actor]
   assert m['operations']==8000 and m['warmupOperations']==24000 and m['checksum']==expected and m['inputSha256']==hashlib.sha256(raw).hexdigest()
   o=r['order'][pos];pos+=1;assert (o['actor'],o['workload'],o['pair'],o['metric'],o['exit'])==(actor,name,i+1,m,{'code':0,'signal':None})
 for actor in ['node','rust']:
  v=[int(s[actor]['nanoseconds'])/8000 for s in w['samples']];med=statistics.median(v);assert med==w['metrics'][actor]['medianNsPerOperation'];metrics[name][actor]={'median':med,'min':min(v),'max':max(v)}
 metrics[name]['rustChangePercent']=(metrics[name]['rust']['median']/metrics[name]['node']['median']-1)*100
assert pos==70
out={'all70ActorsAndChecksumsVerified':True,'alternatingPairOrderVerified':True,'inputSha256':hashlib.sha256(raw).hexdigest(),'beforeAfterHashesMatch':True,'metricsNsPerOperation':metrics}
target=p/'independent-readback.json';assert not target.exists();target.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
