import hashlib,json,os,subprocess,sys,time
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'freeze_permit.py')],check=True)
now=time.time_ns()
for f in (s/'source').rglob('*'):
 if f.is_file():os.utime(f,ns=(now,now))
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest()}))
