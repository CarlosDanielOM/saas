import importlib.util,json,subprocess,sys
from pathlib import Path
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');out=s/'artifacts'/sys.argv[1];assert out.parent.is_dir() and not out.exists()
spec=importlib.util.spec_from_file_location('validate',Path(__file__).parent/'validate.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
after=v.production();assert after==json.loads((s/'production-before.json').read_text());owned={}
for kind in ['container','network','volume']:
 ids=subprocess.check_output(['docker',kind,'ls','-q','--filter','label=saas.task'],text=True).split();hits=[]
 for rid in ids:
  obj=json.loads(subprocess.check_output(['docker',kind,'inspect',rid],text=True))[0];labels=(obj.get('Config',{}).get('Labels') if kind=='container' else obj.get('Labels')) or {}
  if labels.get('saas.task','').startswith('full-rust-'):hits.append({'id':rid,'owner':labels['saas.task']})
 owned[kind+'s']=hits
assert not any(owned.values()),owned
out.write_text(json.dumps({'productionUnchanged':True,'productionRecords':len(after),'productionRecordsAfter':after,'remainingOwnedResources':owned,'acknowledgedBaseline':'production-before.json','piperRemovalAcknowledgedByUser':True},indent=2)+'\n');print(json.dumps({'productionUnchanged':True,'records':len(after),'owned':owned}))
