set -eu
wave=/artifacts/ai-usage-lock/attempt2
export DIMA_AI_LOCK_REFERENCE_DIR="$wave/reference"
export DIMA_AI_LOCK_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_LOCK_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_LOCK_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
export DIMA_AI_LOCK_FIXTURE_TOKEN=ai-usage-lock-fixture-20261029-native1
python3 - <<'MARKER'
import os,socket
assert os.environ['DIMA_RUST_TEST_RESOURCE_OWNER']=='dimabot-migration'
assert os.environ['DIMA_TEST_REDIS_URL']=='redis://keyword-redis:6379/'
parts=[b'SET',b'test:ai-usage-lock:owner',os.environ['DIMA_AI_LOCK_FIXTURE_TOKEN'].encode(),b'NX',b'EX',b'900']
frame=b'*'+str(len(parts)).encode()+b'\r\n'+b''.join(b'$'+str(len(x)).encode()+b'\r\n'+x+b'\r\n' for x in parts)
with socket.create_connection(('keyword-redis',6379),timeout=3) as s:
 s.sendall(frame);assert s.makefile('rb').readline()==b'+OK\r\n'
print('Fresh private Redis ownership marker established.')
MARKER
find "$wave/reference" -type f -exec sha256sum {} \; | sort > "$wave/runtime-before.sha256"
cargo test --locked --offline --no-default-features --features ai-usage-lock --test ai_usage_lock native_source_protocol_matrix -- --ignored --exact --nocapture --test-threads=1
for name in real_redis_race_contention_and_owner_safety real_redis_busy_deadline real_redis_cancel_panic_and_finally real_redis_renewal_loss_and_error_precedence real_redis_held_reply_cancellation_has_no_background_renewal native_default_bootstrap; do
 cargo test --locked --offline --no-default-features --features ai-usage-lock --test ai_usage_lock "$name" -- --ignored --exact --nocapture --test-threads=1
done
find "$wave/reference" -type f -exec sha256sum {} \; | sort > "$wave/runtime-after.sha256"
cmp "$wave/runtime-before.sha256" "$wave/runtime-after.sha256"
