#!/usr/bin/env python3
"""Parent-only export after capped compiler and receipt have completed."""
import argparse, hashlib, json, struct
from pathlib import Path, PurePosixPath

p = argparse.ArgumentParser()
for name in ('receipt', 'build-log', 'target-root', 'output-dir'):
    p.add_argument('--' + name, required=True, type=Path)
p.add_argument('--feature', required=True)
p.add_argument('--target', required=True)
p.add_argument('--target-source', required=True, help='Cargo source path inside /source')
p.add_argument('--triple', required=True, choices=['x86_64-unknown-linux-musl'])
a = p.parse_args()
assert all(c.isalnum() or c in '_-' for c in a.feature + a.target)
assert a.target_source.startswith('/source/dimabot/tests/') and '..' not in PurePosixPath(a.target_source).parts
sha = lambda b: hashlib.sha256(b).hexdigest()
receipt_bytes = a.receipt.read_bytes()
log_bytes = a.build_log.read_bytes()
receipt = json.loads(receipt_bytes)
assert receipt['success'] and receipt['production_unchanged'] and receipt['limits_verified']
assert receipt['toolchain_image'] == 'sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9'
hashes = receipt['source_hashes']
assert hashes and receipt['source_tree_sha256'] == sha(json.dumps(hashes, sort_keys=True).encode())
messages = [json.loads(line) for line in log_bytes.decode().splitlines()]
assert messages[-1] == {'reason':'build-finished','success':True}
found = [m for m in messages if m.get('reason') == 'compiler-artifact' and m.get('target', {}).get('name') == a.target and m.get('executable')]
assert len(found) == 1
m = found[0]
assert m['target']['kind'] == ['test'] and m['target']['crate_types'] == ['bin']
assert m['profile']['test'] and m['profile']['opt_level'] == '3' and not m['profile']['debug_assertions']
assert a.feature in m['features'] and 'default' not in m['features']
assert m['target']['src_path'] == a.target_source
assert m['executable'].startswith(('/target-cache/release/deps/', '/target-cache/x86_64-unknown-linux-musl/release/deps/'))
# Default host-target output is also valid when the parent has verified the
# pinned musl host via the immutable compiler bootstrap log.
rel = PurePosixPath(m['executable']).relative_to('/target-cache')
assert '..' not in rel.parts
root = a.target_root.resolve(strict=True)
source = (root / rel).resolve(strict=True)
assert source.is_relative_to(root) and source.is_file()
b = source.read_bytes()
assert len(b) >= 64 and b[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', b, 18)[0] == 62
start = struct.unpack_from('<Q', b, 32)[0]
size, count = struct.unpack_from('<HH', b, 54)
assert size >= 56 and start + size * count <= len(b)
headers = []
for i in range(count):
    pos = start + i * size
    kind = struct.unpack_from('<I', b, pos)[0]
    headers.append(kind)
    assert kind != 3, 'ELF interpreter'
    if kind == 2:
        off, length = struct.unpack_from('<Q', b, pos+8)[0], struct.unpack_from('<Q', b, pos+32)[0]
        assert off + length <= len(b) and length % 16 == 0
        ended = False
        for cursor in range(off, off + length, 16):
            tag = struct.unpack_from('<q', b, cursor)[0]
            assert tag != 1, 'DT_NEEDED'
            if tag == 0:
                ended = True
                break
        assert ended
out = a.output_dir
out.mkdir(mode=0o700)
target = out / a.target
with target.open('xb') as f: f.write(b)
target.chmod(0o555)
assert target.read_bytes() == b
for data, name in [(receipt_bytes, a.receipt.name), (log_bytes, 'build.jsonl')]:
    with (out / name).open('xb') as f: f.write(data)
with (out / 'source-hashes.json').open('x') as f: json.dump(hashes, f, sort_keys=True, indent=2); f.write('\n')
report = {'format':1, 'buildReceipt':a.receipt.name, 'buildReceiptSha256':sha(receipt_bytes), 'buildLogSha256':sha(log_bytes), 'toolchainImage':receipt['toolchain_image'], 'sourceTreeSha256':receipt['source_tree_sha256'], 'sourceInputs':len(hashes), 'binaries':[{'name':a.target,'cargoExecutable':m['executable'],'artifactPath':str(target),'sha256':sha(b),'bytes':len(b),'elfMachine':'x86-64','staticNoInterpreterOrNeededLibraries':True,'programHeaderTypes':headers,'profile':m['profile'],'features':m['features']}]}
with (out / 'binary-provenance.json').open('x') as f: json.dump(report, f, indent=2); f.write('\n')
print(json.dumps(report))
