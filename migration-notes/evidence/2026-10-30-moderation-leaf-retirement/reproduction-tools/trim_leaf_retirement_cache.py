import hashlib,importlib.util,json,re,subprocess
from pathlib import Path
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
spec=importlib.util.spec_from_file_location('validate',Path(__file__).parent/'validate.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
assert not v.docker('ps','-q','--filter','label='+v.mod.OWNER+'.rust-build=true'),'compiler active'
p=s/'target/debug/deps';assert p.resolve()==p and p.is_dir()
allowed=('ai_usage_', 'posthog_', 'bson_js_json-', 'ai_credit_reader', 'polar_cache_usage-', 'raid_analytics-', 'raid_sessions-', 'stream_activity-')
candidates=[]
for f in p.iterdir():
 st=f.lstat()
 if f.is_file() and not f.is_symlink() and st.st_mode&0o111 and '.' not in f.name and f.name.startswith(allowed) and re.search(r'-[0-9a-f]{16}$',f.name):candidates.append((st.st_blocks*512,f))
before=v.cache_bytes(s);removed=[];freed=0
for size,f in sorted(candidates,key=lambda pair:pair[0],reverse=True):
 if freed>=1024**3:break
 data=f.read_bytes();assert data[:4]==b'\x7fELF'
 removed.append({'path':str(f.relative_to(s)),'bytes':len(data),'allocatedBytes':size,'sha256':hashlib.sha256(data).hexdigest()});f.unlink();freed+=size
assert freed>700*1024**2
out=s/'artifacts/moderation-leaf-retirement/cache-maintenance.json';assert not out.exists()
out.write_text(json.dumps({'scope':'only completed task-owned private debug test executables; no source/shared cache/release export/production resources','cacheBefore':before,'cacheAfter':v.cache_bytes(s),'freedAllocatedBytes':freed,'removed':removed},indent=2)+'\n')
print(json.dumps({'removedPrivateExecutables':len(removed),'freedBytes':freed,'cacheBytes':v.cache_bytes(s),'artifact':str(out)}))
