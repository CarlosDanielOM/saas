import subprocess,sys
from pathlib import Path
folder=Path(__file__).parent;state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(folder/'validate.py'),'prepare',str(state)],check=True)
for p in ['dimabot/src/utils/ai_usage_ledger_queries.rs','dimabot/tests/ai_usage_ledger_queries.rs','dimabot/tests/fixtures/ai_usage_ledger_queries_reference.cjs','dimabot/src/utils/ai_usage_retention.rs','dimabot/tests/ai_usage_retention.rs','dimabot/tests/fixtures/ai_usage_retention_reference.cjs']:(state/'source'/p).unlink(missing_ok=True)
subprocess.run([sys.executable,str(folder/'prepare_posthog_sdk.py'),str(state)],check=True)
