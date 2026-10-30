import hashlib,json,shutil,subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');root=Path('/root/saas-rust')
subprocess.run([sys.executable,str(p/'freeze_advanced_oracle.py')],check=True)
for name in ['migration-notes/evidence/2026-10-29-billing-recovery-source/external-source-api-ee0635765a02/dimabot/src/utils/billing.ts','migration-notes/evidence/2026-10-30-ai-credit-reader-source/external-source-55bd0bb/dimabot/src/utils/plan_cache_fence.ts','migration-notes/evidence/2026-10-30-ai-credit-reader-source/capture-manifest.json']:
 dst=s/'source'/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,dst)
if '--include-protocol' not in sys.argv:
 for name in ['dimabot/tests/ai_credit_reader_protocol.rs','dimabot/tests/support/ai_credit_reader_protocol.rs']:
  (s/'source'/name).unlink(missing_ok=True)
if '--include-accounting' not in sys.argv:
 for name in ['dimabot/src/utils/polar_cache_usage.rs','dimabot/tests/polar_cache_usage.rs','dimabot/tests/fixtures/polar_cache_usage_reference.cjs','dimabot/tests/support/polar_cache_usage.rs']:
  (s/'source'/name).unlink(missing_ok=True)
if '--include-semantic-worker' not in sys.argv:
 for name in ['dimabot/src/utils/moderation/semantic_worker.rs','dimabot/tests/moderation_semantic_worker.rs','dimabot/tests/support/moderation_semantic_worker.rs','dimabot/tests/fixtures/moderation_semantic_worker_reference.cjs']:
  (s/'source'/name).unlink(missing_ok=True)
if '--include-bson-js-json' not in sys.argv:
 for name in ['dimabot/src/utils/bson_js_json.rs','dimabot/tests/bson_js_json.rs','dimabot/tests/fixtures/bson_js_json_reference.cjs']:
  (s/'source'/name).unlink(missing_ok=True)
h={str(f.relative_to(s/'source')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((s/'source').rglob('*')) if f.is_file()}
(s/'snapshot.json').write_text(json.dumps(h,indent=2)+'\n');print(json.dumps({'files':len(h),'sourceTreeSha256':hashlib.sha256(json.dumps(h,sort_keys=True).encode()).hexdigest()}))
