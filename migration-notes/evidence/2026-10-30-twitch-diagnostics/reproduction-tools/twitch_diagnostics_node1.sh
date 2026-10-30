#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/twitch-diagnostics/attempt1
mkdir -p "$base/delete" "$base/diagnostics"
provenance=/artifacts/posthog-receipt/attempt1/node-provenance
cmp /usr/local/bin/node "$provenance/node"
cmp node_modules/typescript/lib/typescript.js "$provenance/root/node_modules/typescript/lib/typescript.js"
cmp node_modules/typescript/package.json "$provenance/root/node_modules/typescript/package.json"
node tests/fixtures/delete_twitch_message_reference.cjs --write "$base/delete"
node tests/fixtures/delete_twitch_message_reference.cjs --check "$base/delete"
node tests/fixtures/twitch_function_diagnostics_reference.cjs --write "$base/diagnostics"
node tests/fixtures/twitch_function_diagnostics_reference.cjs --check "$base/diagnostics"
python3 - <<'PY'
from pathlib import Path
import json,hashlib
base=Path('/artifacts/twitch-diagnostics/attempt1');proof={}
for name,file in [('delete',base/'delete/delete_twitch_message_cases.json'),('diagnostics',base/'diagnostics/twitch_function_diagnostics.json')]:
 d=json.loads(file.read_bytes());proof[name]={'fixture_sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'cases':len(d['cases'])}
(base/'fixture-digests.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
PY
