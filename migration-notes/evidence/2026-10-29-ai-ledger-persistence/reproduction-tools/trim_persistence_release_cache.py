from pathlib import Path
from collections import Counter
import importlib.util,hashlib,json,stat,shutil
folder=Path(__file__).parent
spec=importlib.util.spec_from_file_location('trim_owned_release',folder/'validate.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');m.ops.state=s
record=s/'artifacts/ledger-persistence/pre-retry-release-cache-maintenance.json'
with m.ops.rust_build_lock():
 initial=json.loads((s/'production-before.json').read_text());assert m.production()==initial
 assert not m.docker('ps','-q','--filter','label='+m.mod.OWNER+'.rust-build=true')
 p=s/'target/release';assert p.resolve()==p and p.is_dir();files=[];links=Counter();counts={}
 for f in sorted(p.rglob('*')):
  st=f.lstat()
  if stat.S_ISREG(st.st_mode):
   inode=(st.st_dev,st.st_ino);links[inode]+=1;counts[inode]=st.st_nlink
   files.append({'path':str(f.relative_to(s)),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':st.st_size,'allocatedBytes':st.st_blocks*512,'inode':list(inode),'links':st.st_nlink})
  else:assert stat.S_ISDIR(st.st_mode),str(f)
 assert all(counts[k]==v for k,v in links.items()),'Hardlink reaches outside task-owned release subtree'
 proof={'scope':'Completed regenerable release compiler artifacts exclusively within this task-owned target/release. All inode links proven internal. Prior timing reports, input hashes, source evidence, debug artifacts, Cargo registry, shared caches and production remain intact.','beforeAllocatedBytes':m.cache_bytes(s),'files':files}
 assert not record.exists();record.write_text(json.dumps(proof,indent=2)+'\n');shutil.rmtree(p)
 proof.update(afterAllocatedBytes=m.cache_bytes(s),removedAllocatedBytes=sum(x['allocatedBytes'] for x in files),productionUnchanged=m.production()==initial)
 assert proof['productionUnchanged'];record.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({k:v for k,v in proof.items() if k!='files'}))
