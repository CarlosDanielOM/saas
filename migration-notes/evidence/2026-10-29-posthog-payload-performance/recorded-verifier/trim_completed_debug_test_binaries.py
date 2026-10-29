"""Remove only old, regenerable test executables from this task's private cache."""
import hashlib
import importlib.util
import json
import re
import stat
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('migration_validate', Path(__file__).with_name('validate.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
state = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
driver.ops.state = state
record = state/'artifacts/posthog-payload-performance/completed-debug-test-binaries-maintenance.json'
assert not record.exists()
with driver.ops.rust_build_lock():
    initial = json.loads((state/'production-before.json').read_text())
    assert driver.production() == initial
    assert not driver.docker('ps', '-q', '--filter', 'label='+driver.mod.OWNER+'.rust-build=true')
    root = state/'target/debug/deps'
    assert root.resolve() == root
    files = []
    for file in sorted(root.iterdir()):
        st = file.lstat()
        if not (stat.S_ISREG(st.st_mode) and st.st_nlink == 1
                and st.st_mtime_ns < 1793272670378243591 and st.st_size > 1_000_000
                and re.fullmatch(r'[A-Za-z0-9_]+-[0-9a-f]{16}', file.name)):
            continue
        with file.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        files.append({'path':str(file.relative_to(state)),
                      'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
                      'bytes':st.st_size, 'allocatedBytes':st.st_blocks*512,
                      'mtimeNs':st.st_mtime_ns})
    proof = {'scope':'Only old single-link ELF test executables in the task-private target/debug/deps; all from completed or failed prior test phases before the scoped retry. No dependency, shared cache, release image, source or production mutation.',
             'beforeAllocatedBytes':driver.cache_bytes(state), 'files':files}
    record.write_text(json.dumps(proof, indent=2)+'\n')
    for item in files:
        file = state/item['path']
        assert file.stat().st_nlink == 1
        assert hashlib.sha256(file.read_bytes()).hexdigest() == item['sha256']
        file.unlink()
    proof.update(afterAllocatedBytes=driver.cache_bytes(state),
                 removedAllocatedBytes=sum(f['allocatedBytes'] for f in files),
                 productionUnchanged=driver.production() == initial)
    assert proof['productionUnchanged']
    record.write_text(json.dumps(proof, indent=2)+'\n')
    print(json.dumps({k:v for k,v in proof.items() if k != 'files'}))
