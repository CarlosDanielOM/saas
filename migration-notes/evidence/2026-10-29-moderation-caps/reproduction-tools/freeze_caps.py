import subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'validate.py'),'prepare',str(s)],check=True)
for rel in ['dimabot/tests/fixtures/js_unicode17_prepare.cjs','dimabot/src/utils/bson_js_primitive.rs','dimabot/tests/bson_js_primitive.rs','dimabot/tests/fixtures/bson_js_primitive_reference.cjs',]:(s/'source'/rel).unlink(missing_ok=True)
subprocess.run([sys.executable,str(p/'prepare_posthog_sdk.py'),str(s)],check=True)
