import hashlib,json,shutil,subprocess,sys
from pathlib import Path
p=Path(__file__).parent
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'freeze_rule_dispatcher.py')],check=True)
shutil.copy2('/root/saas-rust/dimabot/tsconfig.json',s/'source/dimabot/tsconfig.json')
for rel in ['dimabot/src/schemas/moderation_variation.schema.rs','dimabot/tests/moderation_variation_schema.rs','dimabot/tests/fixtures/moderation_variation_schema_reference.cjs']:
 (s/'source'/rel).unlink(missing_ok=True)
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest()}))
