set -eu
mkdir -p /artifacts/receipt-parser-benchmark/scalar-diagnostic
set --
for task_native_path in /target-cache/release/build/*/out; do
 set -- "$@" -L "native=$task_native_path"
done
rustc --edition=2024 -C opt-level=3 -C debug-assertions=off /task-tools/receipt_scalar_profile.rs --extern dima_rust=/target-cache/release/deps/libdima_rust-876f99c816a4cba7.rlib -L dependency=/target-cache/release/deps "$@" -o /artifacts/receipt-parser-benchmark/scalar-diagnostic/profile
/artifacts/receipt-parser-benchmark/scalar-diagnostic/profile > /artifacts/receipt-parser-benchmark/scalar-diagnostic/report.jsonl
cat /artifacts/receipt-parser-benchmark/scalar-diagnostic/report.jsonl
sha256sum /target-cache/release/deps/libdima_rust-876f99c816a4cba7.rlib > /artifacts/receipt-parser-benchmark/scalar-diagnostic/rlib.sha256
