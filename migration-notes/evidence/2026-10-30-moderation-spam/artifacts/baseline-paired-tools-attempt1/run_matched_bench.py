"""Run capped Node actors while holding the repository-wide compiler lock."""
import argparse, importlib.util, json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('state',type=Path);p.add_argument('--script',required=True);p.add_argument('--lock-record',required=True,type=Path);a=p.parse_args()
spec=importlib.util.spec_from_file_location('matched_validation',Path(__file__).parent/'validate.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
assert a.lock_record.parent.is_dir() and not a.lock_record.exists()
record={'compilerLockHeldDuringNodeValidation':True,'compilerLock':str(Path.home()/'.local/state/saas-ops-rust-build.lock'),'sourceTreeSha256':__import__('hashlib').sha256(json.dumps(json.loads((a.state/'snapshot.json').read_text()),sort_keys=True).encode()).hexdigest()}
with v.ops.rust_build_lock():
 before=v.docker('ps','-q','--filter','label='+v.mod.OWNER+'.rust-build=true').split();assert not before
 record['activeCompilersBefore']=before
 try:
  v.run(a.state,'node',a.script);record['success']=True
 except BaseException:
  record['success']=False;raise
 finally:
  after=v.docker('ps','-q','--filter','label='+v.mod.OWNER+'.rust-build=true').split();record['activeCompilersAfter']=after
  with a.lock_record.open('x') as f:json.dump(record,f,indent=2);f.write('\n')
  assert not after
