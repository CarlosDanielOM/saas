import hashlib, json, shutil, stat, struct, sys
from pathlib import Path, PurePosixPath

state = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
wave = Path(sys.argv[2]) if len(sys.argv) > 2 else state / 'artifacts/moderation-schema-benchmark/attempt1'
assert wave.parent == state / 'artifacts/moderation-schema-benchmark' and wave.resolve() == wave
receipt = json.loads(Path(sys.argv[1]).read_text())
snapshot = json.loads((state / 'snapshot.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
assert receipt['success'] and receipt['production_unchanged']
assert receipt['source_tree_sha256'] == sha(json.dumps(snapshot, sort_keys=True).encode())
output = wave / 'bin'
output.mkdir()
records = []
for kind, name in [('benchmark', 'channel_moderation_settings_benchmark')]:
    messages = [json.loads(line) for line in (wave / (kind + '-build.jsonl')).read_text().splitlines()]
    assert messages[-1] == {'reason': 'build-finished', 'success': True}
    found = [m for m in messages if m.get('reason') == 'compiler-artifact'
             and m.get('target', {}).get('name') == name and m.get('executable')]
    assert len(found) == 1
    artifact = found[0]
    assert artifact['profile']['test'] and not artifact['profile']['debug_assertions']
    relative = PurePosixPath(artifact['executable']).relative_to('/target-cache')
    source = state / 'target' / relative
    assert source.resolve().is_relative_to((state / 'target').resolve())
    raw = source.read_bytes()
    assert raw[:6] == b'\x7fELF\x02\x01'
    assert struct.unpack_from('<H', raw, 18)[0] == 62
    start = struct.unpack_from('<Q', raw, 32)[0]
    size, count = struct.unpack_from('<HH', raw, 54)
    headers = []
    for i in range(count):
        pos = start + i * size
        kind_value = struct.unpack_from('<I', raw, pos)[0]
        headers.append(kind_value)
        assert kind_value != 3, 'Dynamic interpreter: cannot execute this binary in the pinned Node image'
        if kind_value == 2:
            offset = struct.unpack_from('<Q', raw, pos + 8)[0]
            length = struct.unpack_from('<Q', raw, pos + 32)[0]
            for cursor in range(offset, offset + length, 16):
                tag = struct.unpack_from('<q', raw, cursor)[0]
                assert tag != 1, 'External dynamic-library dependency'
                if tag == 0:
                    break
    target = output / name
    with target.open('xb') as stream:
        stream.write(raw)
    target.chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    assert target.read_bytes() == raw
    records.append({'name': name, 'cargoExecutable': artifact['executable'],
                    'artifactPath': str(target.relative_to(state / 'artifacts')),
                    'sha256': sha(raw), 'bytes': len(raw),
                    'elfMachine': 'x86-64', 'staticNoInterpreterOrNeededLibraries': True,
                    'programHeaderTypes': headers, 'profile': artifact['profile']})
report = {'buildReceipt': Path(sys.argv[1]).name,
          'toolchainImage': receipt['toolchain_image'],
          'sourceTreeSha256': receipt['source_tree_sha256'],
          'sourceInputs': len(snapshot), 'binaries': records}
(wave / 'binary-provenance.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
