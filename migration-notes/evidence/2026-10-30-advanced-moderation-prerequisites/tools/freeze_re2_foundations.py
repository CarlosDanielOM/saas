import hashlib,json,subprocess,sys
from pathlib import Path
p=Path(__file__).parent
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'freeze_advanced_oracle.py')],check=True)
for name in ['dimabot/src/utils/re2_native.rs','dimabot/tests/re2_native.rs']:
 (s/'source'/name).unlink(missing_ok=True)
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest(),'exclusions':['pending unverified re2_native implementation and tests']}))
