"""Add archive-verified SDK references to a parent-owned frozen source copy."""
import hashlib
import json
import sys
import tarfile
import tomllib
from pathlib import Path

state = Path(sys.argv[1])
assert state == Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
root = Path('/root/saas-rust')
registry = 'index.crates.io-1949cf8c6b5b557f'
archive = state / 'cargo/registry/cache' / registry / 'posthog-rs-0.27.0.crate'
source = state / 'cargo/registry/src' / registry / 'posthog-rs-0.27.0'
output = state / 'source/verification/posthog-rs'
assert not output.exists(), 'Prepare a fresh snapshot first'
digest = lambda raw: hashlib.sha256(raw).hexdigest()
locked = next(p for p in tomllib.loads((root/'dimabot/Cargo.lock').read_text())['package']
              if p['name'] == 'posthog-rs' and p['version'] == '0.27.0')
assert digest(archive.read_bytes()) == locked['checksum']
files = ['Cargo.toml', 'LICENSE', 'src/event.rs', 'src/client/async_client.rs',
         'src/client/transport.rs', 'src/lib.rs', 'src/client/mod.rs',
         'src/client/retry.rs', 'src/client/v0_capture.rs', 'src/client/common.rs']
proof = {}
with tarfile.open(archive, 'r:gz') as package:
    for name in files:
        raw = package.extractfile('posthog-rs-0.27.0/' + name).read()
        assert raw == (source/name).read_bytes(), name
        p = output/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        p.chmod(0o444)
        proof[name] = digest(raw)
snapshot = {str(p.relative_to(state/'source')): digest(p.read_bytes())
            for p in sorted((state/'source').rglob('*')) if p.is_file()}
(state/'snapshot.json').write_text(json.dumps(snapshot, indent=2) + '\n')
(state/'artifacts/posthog-sdk-snapshot-proof.json').write_text(json.dumps({
    'package': 'posthog-rs', 'version': '0.27.0', 'archiveSha256': locked['checksum'],
    'files': proof, 'containerPath': '/source/verification/posthog-rs',
    'scope': 'Read-only verification inputs; no dependency installation or SDK fork.'
}, indent=2) + '\n')
print(json.dumps({'sdkFilesVerifiedAndCopied': len(proof), 'snapshotFiles': len(snapshot)}))
