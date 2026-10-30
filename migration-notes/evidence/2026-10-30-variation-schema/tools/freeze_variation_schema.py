#!/usr/bin/env python3
"""Re-run the pinned, disconnected Mongoose schema oracle against a source snapshot."""
import argparse
import hashlib
import os
import subprocess
from pathlib import Path

NODE_SHA256 = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108'
FIXTURE = 'tests/fixtures/moderation_variation_schema_reference.cjs'

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source-root', required=True, type=Path, help='canonical dimabot source root with pinned node_modules')
    p.add_argument('--node', required=True, type=Path, help='pinned Node executable')
    p.add_argument('--output-dir', required=True, type=Path, help='canonical empty output dir for --write or existing fixture dir for --check')
    p.add_argument('mode', choices=['--write', '--check'])
    a = p.parse_args()
    source = a.source_root.resolve(strict=True)
    node = a.node.resolve(strict=True)
    output = a.output_dir.resolve(strict=True)
    if str(source) != str(a.source_root) or str(output) != str(a.output_dir):
        raise SystemExit('source and output paths must be canonical absolute paths')
    if not (source / FIXTURE).is_file() or not (source / 'package.json').is_file():
        raise SystemExit('source root is not the pinned dimabot snapshot')
    if hashlib.sha256(node.read_bytes()).hexdigest() != NODE_SHA256:
        raise SystemExit('Node executable SHA-256 does not match the oracle pin')
    if source == output or source in output.parents:
        raise SystemExit('oracle output must be outside the immutable source tree')
    env = os.environ.copy()
    env['DIMA_SCHEMA_SOURCE_ROOT'] = str(source)
    env['DIMA_SCHEMA_NODE_SHA256'] = NODE_SHA256
    subprocess.run([str(node), str(source / FIXTURE), a.mode, str(output)], env=env, check=True)

if __name__ == '__main__':
    main()
