"""Journal and remove only obsolete binary aliases wholly inside this cache."""
import hashlib
import importlib.util
import json
import re
import stat
from pathlib import Path

spec=importlib.util.spec_from_file_location('private_binary_maintenance',Path(__file__).with_name('validate.py'))
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
driver.ops.state=state
record=state/'artifacts/posthog-payload-performance/private-binary-alias-maintenance.json'
assert not record.exists()
with driver.ops.rust_build_lock():
    baseline=json.loads((state/'production-before.json').read_text())
    assert driver.production()==baseline
    assert not driver.docker('ps','-q','--filter','label='+driver.mod.OWNER+'.rust-build=true')
    root=state/'target/debug';assert root.resolve()==root
    names={'cron_index','stream_activity','raid_analytics','follow_defense_baseline',
           'roulette_completion','ai_usage_receipts','raid_sessions',
           'stream_activity_fixture','js_date','dashboard_activity'}
    groups={}
    for path in root.rglob('*'):
        st=path.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_mtime_ns>=1793267370297086967 or st.st_nlink<2:
            continue
        selected=(path.parent==root and path.name in names) or (
            path.parent==root/'deps' and re.fullmatch(
                r'('+'|'.join(sorted(names))+r')-[0-9a-f]{16}',path.name))
        if selected:
            with path.open('rb') as stream:
                if stream.read(4)==b'\x7fELF':
                    groups.setdefault((st.st_dev,st.st_ino),[]).append((path,st))
    files=[]
    for paths in groups.values():
        # Reject any inode with even one link not accounted for in our private
        # path allowlist. No production/shared cache or dependency is eligible.
        if len(paths)!=paths[0][1].st_nlink:
            continue
        for path,st in paths:
            files.append({'path':str(path.relative_to(state)),
                          'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                          'bytes':st.st_size,'allocatedBytes':st.st_blocks*512,
                          'inode':st.st_ino,'device':st.st_dev,'mtimeNs':st.st_mtime_ns})
    proof={'scope':'Only obsolete worker/test binary aliases wholly inside this task-private debug target, all older than the performance wave. No crate/library dependency, source, image, shared cache or production resource touched.',
           'beforeAllocatedBytes':driver.cache_bytes(state),'files':files}
    record.write_text(json.dumps(proof,indent=2)+'\n')
    for item in files:
        path=state/item['path'];st=path.lstat()
        assert (st.st_dev,st.st_ino)==(item['device'],item['inode'])
        assert hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
        path.unlink()
    proof.update(afterAllocatedBytes=driver.cache_bytes(state),
                 conservativeRemovedBytes=sum(f['allocatedBytes'] for f in files),
                 productionUnchanged=driver.production()==baseline)
    assert proof['productionUnchanged']
    record.write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps({k:v for k,v in proof.items() if k!='files'}))
