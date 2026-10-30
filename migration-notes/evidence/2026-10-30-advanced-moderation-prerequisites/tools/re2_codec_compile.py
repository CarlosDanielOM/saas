from pathlib import Path
import validate
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
with validate.ops.rust_build_lock():
    assert not validate.docker('ps','-q','--filter','label='+validate.mod.OWNER+'.rust-build=true'),'another capped compiler is running'
    validate.run(s,'node','node /task-tools/re2_codec_build.cjs')
