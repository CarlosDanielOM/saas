#!/usr/bin/env python3
"""Materialize and hash-check the immutable 1,406-input source snapshot."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

SDK_PREFIX = 'verification/posthog-rs/'

def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=root)

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-bindings', required=True, type=Path)
    parser.add_argument('--git-root', required=True, type=Path)
    parser.add_argument('--sdk-root', required=True, type=Path,
                        help='root of the previously verified archive/source tree containing verification/posthog-rs/')
    parser.add_argument('--destination', required=True, type=Path,
                        help='must be a path that does not yet exist')
    args = parser.parse_args()

    binding_path = args.source_bindings.resolve(strict=True)
    git_root = args.git_root.resolve(strict=True)
    sdk_root = args.sdk_root.resolve(strict=True)
    dest = args.destination.absolute()
    if dest.exists():
        raise SystemExit(f'destination must not exist: {dest}')
    if not git_root.is_dir() or not sdk_root.is_dir():
        raise SystemExit('Git root and prior SDK source root must be directories')

    binding = json.loads(binding_path.read_text())
    commit = binding['codeCommit']
    if git(git_root, 'rev-parse', commit).decode().strip() != commit:
        raise SystemExit('source binding commit is unavailable or did not resolve exactly')
    git_inputs = binding['gitInputs']
    sdk_inputs = binding['reusedVerifiedSdkInputs']['inputs']
    if len(git_inputs) != 1396 or len(sdk_inputs) != 10 or len(git_inputs) + len(sdk_inputs) != 1406:
        raise SystemExit('source binding input counts do not match the accepted receipt')
    combined = {**git_inputs, **sdk_inputs}
    canonical_tree = json.dumps(combined, sort_keys=True).encode()
    if hashlib.sha256(canonical_tree).hexdigest() != binding['sourceTreeSha256']:
        raise SystemExit('source-tree digest does not match the accepted source binding')
    if any(path.startswith(SDK_PREFIX) for path in git_inputs) or any(not path.startswith(SDK_PREFIX) for path in sdk_inputs):
        raise SystemExit('unexpected source binding partition')
    for rel in [*git_inputs, *sdk_inputs]:
        item = Path(rel)
        if item.is_absolute() or not item.parts or any(part in ('', '.', '..') for part in item.parts):
            raise SystemExit(f'unsafe bound relative path: {rel}')

    # Validate every byte before creating the output tree.
    for rel, expected in git_inputs.items():
        actual = digest(git(git_root, 'show', f'{commit}:{rel}'))
        if actual != expected:
            raise SystemExit(f'Git input hash mismatch: {rel}: {actual} != {expected}')
    sdk_data = {}
    for rel, expected in sdk_inputs.items():
        path = sdk_root / rel
        data = path.read_bytes()
        if digest(data) != expected:
            raise SystemExit(f'previously verified SDK source hash mismatch: {path}')
        sdk_data[rel] = data

    modes = {}
    if git_inputs:
        listing = git(git_root, 'ls-tree', '-r', '-z', '--full-tree', commit, '--', *git_inputs.keys())
        for record in listing.split(b'\0'):
            if not record:
                continue
            metadata, raw_path = record.split(b'\t', 1)
            mode, kind, _ = metadata.decode().split(' ', 2)
            rel = os.fsdecode(raw_path)
            if kind != 'blob' or mode not in ('100644', '100755'):
                raise SystemExit(f'unsupported Git input type or mode: {mode} {kind} {rel}')
            modes[rel] = mode
    if set(modes) != set(git_inputs):
        raise SystemExit('Git tree does not contain exactly the bound source paths')

    dest.mkdir(parents=False, exist_ok=False)
    try:
        for rel, expected in git_inputs.items():
            data = git(git_root, 'show', f'{commit}:{rel}')
            if digest(data) != expected:
                raise SystemExit(f'Git input changed while materializing: {rel}')
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if modes[rel] == '100755' else 0o644)
        for rel, data in sdk_data.items():
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        result = {}
        for rel, expected in {**git_inputs, **sdk_inputs}.items():
            actual = digest((dest / rel).read_bytes())
            if actual != expected:
                raise SystemExit(f'materialized hash mismatch: {rel}')
            result[rel] = actual
        if len(result) != 1406:
            raise SystemExit('materialized input count mismatch')
    except BaseException:
        # Leave the task-owned destination available for inspection if a write fails.
        raise
    print(json.dumps({'destination': str(dest), 'codeCommit': commit, 'sourceInputs': len(result),
                      'gitInputs': len(git_inputs), 'reusedVerifiedSdkInputs': len(sdk_inputs),
                      'sourceTreeSha256': binding['sourceTreeSha256']}, sort_keys=True))

if __name__ == '__main__':
    main()
