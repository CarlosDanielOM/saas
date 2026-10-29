import subprocess,sys
from pathlib import Path
p=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(p/'validate.py'),'prepare',str(s)],check=True)
for rel in ['dimabot/src/utils/ai_usage_ledger_backfill.rs','dimabot/tests/ai_usage_ledger_backfill.rs','dimabot/tests/fixtures/ai_usage_ledger_backfill_reference.cjs','dimabot/tests/ai_usage_daily_reducer_benchmark.rs','dimabot/tests/fixtures/ai_usage_daily_reducer_benchmark.cjs']:(s/'source'/rel).unlink(missing_ok=True)
subprocess.run([sys.executable,str(p/'prepare_posthog_sdk.py'),str(s)],check=True)
