#!/usr/bin/env python3
"""Reuse checked-in provider/boot fixtures for isolated emote scope checks.
Run: python3 ops/checks/dashboard-emote-fixtures/prepare.py /tmp/dashboard-emote-fixtures
Then saas-ops verify RUN --fixtures DIR --test-env DIR/TARGET-env.json
     --dependency mongo --dependency redis --check ops/checks/dashboard-emotes.mjs
"""
from pathlib import Path
import json
import shutil
import sys

root = Path(__file__).resolve().parents[3]
out = Path(sys.argv[1]).resolve()
assert out.parent == Path('/tmp') and out.name.startswith('dashboard-emote-')
out.mkdir(mode=0o700)
shutil.copyfile(root / 'ops/checks/dashboard-activity-fixtures/providers.mjs', out / 'providers.mjs')
shutil.copyfile(root / 'ops/checks/kokoro-fixtures/boot.mjs', out / 'boot.mjs')
base = json.loads((root / 'ops/checks/dashboard-activity-fixtures/test-env.json').read_text())
for target in ('api', 'cron', 'bot'):
    env = dict(base)
    if target == 'bot':
        env = json.loads((root / 'ops/checks/kokoro-fixtures/bot-env.json').read_text())
    (out / f'{target}-env.json').write_text(json.dumps(env, indent=2))
print(out)
