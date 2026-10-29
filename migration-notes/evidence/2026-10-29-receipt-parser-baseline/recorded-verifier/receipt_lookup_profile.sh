set -eu
mkdir -p /artifacts/receipt-parser-benchmark/lookup-diagnostic
set --
for task_native_path in /target-cache/release/build/*/out; do
 set -- "$@" -L "native=$task_native_path"
done
rustc --edition=2024 -C opt-level=3 -C debug-assertions=off /task-tools/receipt_lookup_profile.rs --extern dima_rust=/target-cache/release/deps/libdima_rust-876f99c816a4cba7.rlib -L dependency=/target-cache/release/deps "$@" -o /artifacts/receipt-parser-benchmark/lookup-diagnostic/profile
/artifacts/receipt-parser-benchmark/lookup-diagnostic/profile > /artifacts/receipt-parser-benchmark/lookup-diagnostic/report.jsonl
cat /artifacts/receipt-parser-benchmark/lookup-diagnostic/report.jsonl
