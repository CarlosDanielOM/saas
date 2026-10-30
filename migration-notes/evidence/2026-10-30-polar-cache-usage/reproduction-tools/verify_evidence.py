#!/usr/bin/env python3
"""Verify the retained Polar cache-mode evidence archive using local files only."""
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

index = json.loads((ROOT / 'artifact-sha256.json').read_text())
seen = set()
for entry in index['entries']:
    rel = entry['path']
    if rel in seen:
        raise SystemExit(f'duplicate index path: {rel}')
    seen.add(rel)
    data = (ROOT / rel).read_bytes()
    if len(data) != entry['storedBytes'] or sha(data) != entry['storedSha256']:
        raise SystemExit(f'stored payload mismatch: {rel}')
    if rel.endswith('.gz'):
        raw = gzip.decompress(data)
        if len(raw) != entry['rawBytes'] or sha(raw) != entry['rawSha256']:
            raise SystemExit(f'decompressed payload mismatch: {rel}')
    elif len(data) != entry['rawBytes'] or sha(data) != entry['rawSha256']:
        raise SystemExit(f'raw payload mismatch: {rel}')
if len(seen) != index['payloadCount']:
    raise SystemExit('payload count mismatch')
refs = [(ROOT / 'artifacts/polar-cache-usage' / f'attempt{i}-reference.json').read_bytes() for i in range(1, 4)]
if not (refs[0] == refs[1] == refs[2]):
    raise SystemExit('reference corpora differ')
facts = json.loads((ROOT / 'artifacts/polar-cache-usage/parent-final-facts.json').read_text())
if sha(refs[0]) != facts['fixtureSha256']:
    raise SystemExit('reference corpus hash mismatch')
if len(json.loads(refs[0])['cases']) != 32:
    raise SystemExit('reference case count mismatch')
bindings = json.loads((ROOT / 'source-bindings.json').read_text())
if len(bindings['gitInputs']) != 1446 or len(bindings['reusedSdkInputs']) != 10:
    raise SystemExit('source binding counts mismatch')
for rel in ['dimabot/src/utils/polar_cache_usage.rs', 'dimabot/tests/polar_cache_usage.rs', 'dimabot/tests/support/polar_cache_usage.rs', 'dimabot/tests/fixtures/polar_cache_usage_reference.cjs']:
    payload = (ROOT / 'source-snapshot' / rel).read_bytes()
    if sha(payload) != bindings['gitInputs'][rel]:
        raise SystemExit(f'source snapshot binding mismatch: {rel}')
print(f"verified {len(seen)} indexed payloads, 3 identical 32-record corpora, and 1,456 source bindings")
