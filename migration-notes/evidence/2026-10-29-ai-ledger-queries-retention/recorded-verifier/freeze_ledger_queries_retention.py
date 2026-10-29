import subprocess,sys
from pathlib import Path
folder=Path(__file__).parent;s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(folder/'validate.py'),'prepare',str(s)],check=True)
for rel in ['dimabot/src/utils/ai_usage_ledger_persistence.rs','dimabot/src/utils/ai_usage_aggregate_policy.rs','dimabot/tests/ai_usage_ledger_persistence.rs','dimabot/tests/fixtures/ai_usage_ledger_persistence_reference.cjs']:(s/'source'/rel).unlink(missing_ok=True)
subprocess.run([sys.executable,str(folder/'prepare_posthog_sdk.py'),str(s)],check=True)
