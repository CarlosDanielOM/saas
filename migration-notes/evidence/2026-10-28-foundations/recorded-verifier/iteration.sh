set -eu
TASK_STATE=/root/.local/state/rust-full-migration-20261028-lu443ytp
python3 /tmp/dimabot-full-migration-tools/validate.py prepare "$TASK_STATE"
python3 /tmp/dimabot-full-migration-tools/validate.py format "$TASK_STATE" --script 'cargo fmt --all; cargo fmt --all -- --check'
python3 /tmp/dimabot-full-migration-tools/apply_format.py "$TASK_STATE"
python3 /tmp/dimabot-full-migration-tools/validate.py prepare "$TASK_STATE"
python3 /tmp/dimabot-full-migration-tools/validate.py compiler-fixtures "$TASK_STATE" --script 'sh /task-tools/adapters.sh'
