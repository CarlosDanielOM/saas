"""Freeze the accepted lock and following parser benchmark without exclusions."""
import subprocess,sys
from pathlib import Path
folder=Path(__file__).parent
state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable,str(folder/'validate.py'),'prepare',str(state)],check=True)
for relative in ['dimabot/src/utils/ai_usage_ledger_reads.rs','dimabot/tests/ai_usage_ledger_reads.rs','dimabot/tests/fixtures/ai_usage_ledger_reads_reference.cjs','dimabot/tests/support/ai_usage_ledger_reads.rs']:
 (state/'source'/relative).unlink(missing_ok=True)
subprocess.run([sys.executable,str(folder/'prepare_posthog_sdk.py'),str(state)],check=True)
