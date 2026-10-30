#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/delete-twitch-message/attempt1
mkdir -p "$base/oracle"
provenance=/artifacts/posthog-receipt/attempt1/node-provenance
cmp /usr/local/bin/node "$provenance/node"
cmp node_modules/typescript/lib/typescript.js "$provenance/root/node_modules/typescript/lib/typescript.js"
cmp node_modules/typescript/package.json "$provenance/root/node_modules/typescript/package.json"
node tests/fixtures/delete_twitch_message_reference.cjs --write "$base/oracle"
node tests/fixtures/delete_twitch_message_reference.cjs --check "$base/oracle"
python3 - <<'PY'
import pathlib,json,hashlib
base=pathlib.Path('/artifacts/delete-twitch-message/attempt1');p=base/'oracle/delete_twitch_message_cases.json';d=json.loads(p.read_text());proof={'fixture_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'source_cases':len(d['cases']),'explicit_parser_depth_boundary_cases':sum('nativeDepthLimit' in c['spec'] for c in d['cases']),'source_only_logger_throw_cases':sum(bool(c['spec'].get('logThrow')) for c in d['cases']),'reused_toolchain_capture':'/artifacts/posthog-receipt/attempt1/node-provenance','binary_and_typescript_capture_equal_pinned_container':True};(base/'provenance-comparison.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
PY
