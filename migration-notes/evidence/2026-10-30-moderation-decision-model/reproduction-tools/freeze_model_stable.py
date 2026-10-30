import hashlib,json,subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'freeze_advanced_oracle.py')],check=True)
excluded=['src/utils/moderation/decisions.rs','tests/moderation_decisions.rs','tests/support/moderation_decisions.rs','tests/fixtures/moderation_decisions_source.cjs','tests/fixtures/moderation_decisions_reference.cjs']
for name in excluded:(s/'source/dimabot'/name).unlink(missing_ok=True)
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest(),'excludedUnverifiedDecisionStoreDrafts':excluded}))
