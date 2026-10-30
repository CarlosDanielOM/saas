#!/bin/sh
set -eu
cd /source/dimabot
cargo fmt --all
python3 - <<'PY2'
import subprocess,hashlib,json
from pathlib import Path
p=Path('/artifacts/fish-favorites/toolchain/rustc.json');p.parent.mkdir(parents=True,exist_ok=True)
rustc=Path(subprocess.check_output(['rustup','which','rustc'],text=True).strip()).resolve()
j={'schemaVersion':1,'path':str(rustc),'sha256':hashlib.sha256(rustc.read_bytes()).hexdigest(),'version':subprocess.check_output([str(rustc),'-V'],text=True).strip(),'verbose':subprocess.check_output([str(rustc),'-Vv'],text=True)}
with p.open('x') as f: f.write(json.dumps(j,indent=2)+'\n')
print(json.dumps(j));print('rustcMetadataSha256',hashlib.sha256(p.read_bytes()).hexdigest())
PY2
