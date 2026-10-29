import subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'validate.py'),'prepare',str(s)],check=True)
for rel in ['dimabot/src/utils/moderation/permit.rs','dimabot/tests/moderation_permit.rs','dimabot/tests/moderation_permit_redis.rs','dimabot/tests/fixtures/moderation_permit_reference.cjs','dimabot/tests/moderation_text_benchmark.rs','dimabot/tests/fixtures/moderation_text_benchmark.cjs']:(s/'source'/rel).unlink(missing_ok=True)
subprocess.run([sys.executable,str(p/'prepare_posthog_sdk.py'),str(s)],check=True)
