"""Run local gifting experiments; optionally download pinned public source.

Usage:
  python3 ops/experiments/credit-gifts/run.py --fetch-upstream --output /tmp/gift-results.json
  python3 ops/experiments/credit-gifts/run.py --source-dir /tmp/polar-source --output /tmp/gift-results.json

Downloads contact raw.githubusercontent.com only. Tests do not contact Polar or
start application services. The Node experiment runs without network permission.
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from upstream import COMMIT, FILES


def download(directory):
    import urllib.request
    manifest = {'repository': 'https://github.com/polarsource/polar', 'commit': COMMIT, 'files': {}}
    for relative, expected in FILES.items():
        url = f'https://raw.githubusercontent.com/polarsource/polar/{COMMIT}/{relative}'
        request = urllib.request.Request(url, headers={'User-Agent': 'credit-gift-local-experiment'})
        with urllib.request.urlopen(request, timeout=30) as response:
            source = response.read()
        digest = hashlib.sha256(source).hexdigest()
        if digest != expected:
            raise RuntimeError(f'Pinned source checksum mismatch: {relative}')
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source)
        manifest['files'][relative] = {'sha256': digest, 'bytes': len(source)}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--source-dir', type=Path, help='Previously downloaded pinned Polar source')
    mode.add_argument('--fetch-upstream', action='store_true', help='Download public source; never uses Polar credentials')
    parser.add_argument('--output', type=Path, required=True, help='Results JSON path under /tmp')
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(Path('/tmp')):
        parser.error('--output must be under /tmp')
    if output.exists():
        parser.error('Use a new output path; existing results will not be overwritten')
    here = Path(__file__).resolve().parent
    repo = here.parents[2]
    with tempfile.TemporaryDirectory(prefix='credit-gift-experiment-') as temporary:
        workspace = Path(temporary)
        source = args.source_dir.resolve() if args.source_dir else workspace / 'upstream'
        if args.fetch_upstream:
            source.mkdir()
            download(source)
        application = workspace / 'application.json'
        provider = workspace / 'provider.json'
        subprocess.run([
            'node', '--permission', f'--allow-fs-read={repo}',
            '--allow-fs-read=/tmp', '--allow-fs-write=/tmp',
            '--experimental-vm-modules', str(here / 'application.mjs'), str(application),
        ], check=True, timeout=60)
        subprocess.run(['python3', '-I', str(here / 'upstream.py'), str(source), str(provider)], check=True, timeout=60)
        app_results = json.loads(application.read_text())
        provider_results = json.loads(provider.read_text())
        test_count = len(app_results['tests']) + len(provider_results['tests'])
        results = {
            'recordedAt': datetime.now(timezone.utc).isoformat(),
            'status': 'local_experiments_passed_hosted_sandbox_not_tested',
            'passedTests': test_count,
            'failedTests': 0,
            'application': app_results,
            'upstream': provider_results,
            'hostedPolarSandbox': {'status': 'not_tested', 'reason': 'No sandbox organization access token is available.'},
            'production': {'servicesStartedOrChanged': False, 'billingRequestsSent': 0, 'dataMutations': 0, 'deployed': False},
            'decision': 'Do not use negative ai_usage adjustments to deliver permanent gifts. Native recipient grants need a hosted sandbox proof; a durable application gift balance is the fallback.',
            'cleanup': 'Temporary experiment workspaces removed; no persistent test servers, databases, containers, or networks created.',
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents accidental replacement of previous evidence.
        with output.open('x') as file:
            file.write(json.dumps(results, indent=2) + '\n')
        print(f'{test_count} local experiments passed. Hosted Polar sandbox NOT TESTED. Results: {output}')


if __name__ == '__main__':
    main()
