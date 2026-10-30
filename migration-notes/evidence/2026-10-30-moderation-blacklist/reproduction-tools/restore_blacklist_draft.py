"""Move only this task's exact, hash-owned draft files between staged and live source."""
import argparse, hashlib, json, subprocess
from pathlib import Path
ROOT = Path('/root/saas-rust')
STAGE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-blacklist/staged-source')
args = argparse.ArgumentParser()
args.add_argument('mode', choices=['park', 'restore'])
mode = args.parse_args().mode
manifest = json.loads((STAGE / 'manifest.json').read_text())
sha = lambda raw: hashlib.sha256(raw).hexdigest()
prepared = []
for name, row in manifest['files'].items():
    assert name.startswith('dimabot/') and '..' not in Path(name).parts
    target = ROOT / name
    assert target.resolve().is_relative_to(ROOT) and not target.is_symlink()
    raw = (STAGE / name).read_bytes()
    assert sha(raw) == row['sha256'], name
    base = subprocess.check_output(['git', 'show', manifest['baseCommit'] + ':' + name], cwd=ROOT) if row['tracked'] else None
    assert (sha(base) if base is not None else None) == row['baseSha256'], name
    current = sha(target.read_bytes()) if target.exists() else None
    assert current in [row['sha256'], row['baseSha256']], ('concurrent edit; preserve and reconcile', name)
    prepared.append((target, raw, base))
for target, raw, base in prepared:
    selected = raw if mode == 'restore' else base
    if selected is None:
        if target.exists(): target.unlink()
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(selected)
    assert (target.read_bytes() if target.exists() else None) == selected
print(json.dumps({'mode': mode, 'files': len(prepared), 'baseCommit': manifest['baseCommit']}))
