"""Freeze this wave while leaving the next author-only lock draft out."""
import subprocess
import sys
from pathlib import Path

folder = Path(__file__).parent
state = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
subprocess.run([sys.executable, str(folder/'validate.py'), 'prepare', str(state)], check=True)
for relative in ['dimabot/src/utils/ai_usage_lock.rs', 'dimabot/tests/ai_usage_lock.rs',
                 'dimabot/tests/fixtures/ai_usage_lock_reference.cjs',
                 'dimabot/tests/ai_usage_receipt_parser_benchmark.rs',
                 'dimabot/tests/fixtures/ai_usage_receipt_parser_source.cjs',
                 'dimabot/tests/fixtures/ai_usage_receipt_parser_benchmark.cjs']:
    (state/'source'/relative).unlink(missing_ok=True)
subprocess.run([sys.executable, str(folder/'prepare_posthog_sdk.py'), str(state)], check=True)
