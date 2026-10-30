import hashlib,json,subprocess,sys
from pathlib import Path
p=Path(__file__).parent
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'freeze_redis_application.py')],check=True)
# Keep the next unwired, unverified dispatcher draft out of this feature snapshot.
for f in ['dimabot/src/utils/moderation/rule_dispatcher.rs','dimabot/tests/moderation_rule_dispatcher.rs','dimabot/tests/fixtures/moderation_rule_dispatcher_reference.cjs']:
    candidate=s/'source'/f
    if candidate.exists(): candidate.unlink()
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest()}))
