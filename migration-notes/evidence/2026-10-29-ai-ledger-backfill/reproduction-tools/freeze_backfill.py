import subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'validate.py'),'prepare',str(s)],check=True)
for rel in ['dimabot/tests/ai_usage_classification.rs','dimabot/tests/fixtures/ai_usage_classification_reference.cjs','dimabot/src/utils/bson_js_primitive.rs','dimabot/tests/bson_js_primitive.rs','dimabot/tests/fixtures/bson_js_primitive_reference.cjs','dimabot/tests/ai_usage_persistence_e2e_benchmark.rs','dimabot/tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs']:(s/'source'/rel).unlink(missing_ok=True)
subprocess.run(['git','show','a87d9ee7:dimabot/src/utils/ai_usage.rs'],check=True,stdout=(s/'source/dimabot/src/utils/ai_usage.rs').open('wb'))
subprocess.run([sys.executable,str(p/'prepare_posthog_sdk.py'),str(s)],check=True)
