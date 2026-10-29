"""Preserve the verified initial baseline without reading future working edits."""
import gzip
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

root = Path('/root/saas-rust')
state = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
artifacts = state/'artifacts'
wave = artifacts/'posthog-receipt'
destination = root/'migration-notes/evidence/2026-10-29-posthog-receipt'
assert not destination.exists()
destination.mkdir(parents=True)
commit = subprocess.check_output(['git','rev-parse','77141415'], text=True).strip()
digest = lambda raw: hashlib.sha256(raw).hexdigest()
write = lambda path, value: path.write_text(json.dumps(value, indent=2)+'\n')
compressed = {}
retained = {}

def retain(source, relative):
    relative = Path(relative)
    target = destination/relative
    target.parent.mkdir(parents=True, exist_ok=True)
    raw_hash = hashlib.sha256()
    raw_bytes = 0
    if source.stat().st_size > 65536 or relative.suffix == '.log':
        target = target.with_name(target.name+'.gz')
        with source.open('rb') as stream, target.open('xb') as output:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=6) as zipped:
                while chunk := stream.read(1024*1024):
                    raw_hash.update(chunk)
                    raw_bytes += len(chunk)
                    zipped.write(chunk)
        compressed[str(target.relative_to(destination))] = {
            'originalPath':str(relative), 'rawSha256':raw_hash.hexdigest(), 'rawBytes':raw_bytes}
    else:
        raw = source.read_bytes()
        target.write_bytes(raw)
        raw_hash.update(raw)
        raw_bytes = len(raw)
    retained[str(relative)] = {'storedPath':str(target.relative_to(destination)),
                              'rawSha256':raw_hash.hexdigest(), 'rawBytes':raw_bytes}

excluded = []
for source in sorted(wave.rglob('*')):
    if not source.is_file():
        continue
    relative = source.relative_to(wave)
    if 'node-provenance' in relative.parts:
        tail = relative.parts[relative.parts.index('node-provenance')+1:]
        if tail != ('manifest.json',):
            excluded.append({'path':str(relative), 'bytes':source.stat().st_size,
                             'sha256':digest(source.read_bytes())})
            continue
    retain(source, Path('artifacts')/relative)

for name in ['posthog-sdk-source-proof.json', 'posthog-sdk-snapshot-proof.json',
             'posthog-parser-private-cache-maintenance.json']:
    retain(artifacts/name, Path('artifacts')/name)

runs = []
for source in sorted(artifacts.glob('*-receipt.json')):
    match = re.fullmatch(r'(format|node|compiler)-(\d+)-receipt.json', source.name)
    if not match or int(match[2]) < 1793261661342957318:
        continue
    receipt = json.loads(source.read_text())
    log = source.with_name(source.name.replace('-receipt.json','.log'))
    assert log.is_file()
    retain(source, Path('runs')/source.name)
    retain(log, Path('runs')/log.name)
    runs.append({'receipt':retained[str(Path('runs')/source.name)]['storedPath'],
                 'log':retained[str(Path('runs')/log.name)]['storedPath'],
                 **{k:receipt[k] for k in ['phase','success','source_tree_sha256','production_unchanged']}})

tools = Path('/tmp/dimabot-full-migration-tools')
for name in ['validate.py','apply_format.py','prepare_posthog_sdk.py','freeze_posthog_wave.py',
             'copy_receipt_node_provenance.cjs','trim_stale_test_binaries.py',
             'posthog_receipt_node.sh','posthog_receipt_node2.sh','posthog_receipt_node3.sh',
             'posthog_receipt_node4.sh','posthog_receipt_post_node.sh',
             'posthog_receipt_compiler2.template.sh','posthog_receipt_compiler4.sh']:
    retain(tools/name, Path('recorded-verifier')/name)

final = json.loads((artifacts/'compiler-1793264871810743273-receipt.json').read_text())
baseline = json.loads((artifacts/'compiler-1793263458419267176-receipt.json').read_text())
assert final['success'] and final['production_unchanged']
snapshot = final['source_hashes']
paths = [p for p in snapshot if not p.startswith('verification/')]
batch = subprocess.check_output(['git','cat-file','--batch'],
    input=''.join(commit+':'+p+'\n' for p in paths).encode())
offset = 0
git_hashes = {}
for path in paths:
    end = batch.index(b'\n',offset)
    header = batch[offset:end].decode().split()
    assert len(header)==3 and header[1]=='blob', (path,header)
    size = int(header[2])
    raw = batch[end+1:end+1+size]
    assert len(raw)==size and batch[end+1+size:end+2+size]==b'\n'
    git_hashes[path] = digest(raw)
    assert git_hashes[path] == snapshot[path], path
    offset = end+2+size
assert offset == len(batch)
sdk = {p:h for p,h in snapshot.items() if p.startswith('verification/')}
assert len(sdk)==10
for p,h in sdk.items():
    assert digest((state/'source'/p).read_bytes())==h
write(destination/'source-binding.json', {'sourceTreeSha256':final['source_tree_sha256'],
    'gitCommit':commit, 'gitFileHashes':git_hashes,'archiveVerifiedSdkReferenceHashes':sdk})

baseline_git = {}
baseline_retained = {}
for p,h in baseline['source_hashes'].items():
    if p.startswith('verification/'):
        assert sdk[p]==h
    elif git_hashes.get(p)==h:
        baseline_git[p]=h
    else:
        source = wave/'baseline-native-sources'/p
        assert source.is_file() and digest(source.read_bytes())==h, p
        baseline_retained[p]={'sha256':h,
            'retainedPath':retained[str(Path('artifacts/baseline-native-sources')/p)]['storedPath']}
assert len(baseline_retained)==4
write(destination/'runtime-baseline-source-binding.json', {
    'sourceTreeSha256':baseline['source_tree_sha256'], 'gitCommitForUnchangedFiles':commit,
    'gitFileHashes':baseline_git,'retainedNativeFiles':baseline_retained,
    'archiveVerifiedSdkReferenceHashes':sdk,
    'recoveryMethod':'Two native files recovered verbatim from contemporaneous source oracle; two test files reconstructed by reversing only lint changes. All four match original frozen runtime receipt SHA-256 exactly.'})

log = (artifacts/'compiler-1793264871810743273.log').read_text()
counts = list(map(int,re.findall(r'test result: ok\. (\d+) passed',log)))
assert sum(counts)==144
post = json.loads((artifacts/'node-1793265499179357802-receipt.json').read_text())
assert post['success'] and post['source_tree_sha256']==final['source_tree_sha256']
summary = {'status':'Initial behavior-verified baseline; four small-payload performance regressions remain open.',
    'sourceTreeSha256':final['source_tree_sha256'],'codeCommit':commit,
    'compilerRun':'compiler-1793264871810743273','postNodeRun':'node-1793265499179357802',
    'finalReportedExecutions':sum(counts),'finalTargetPassedCounts':counts,
    'countsAreUnique':False,'fullFiveTimezoneRuntimeRun':'compiler-1793263458419267176',
    'receiptCasesPerZone':1362,'receiptTimezoneCount':5,'posthogWrapperRecords':1042,
    'installedSdkPayloadCases':1,'installedSdkPayloads':2,'installedSdkLifecycleRecords':18,
    'limits':final['limits'],'peakPrivateCacheBytes':final['peak_cache_bytes'],
    'minimumHostAvailableBytes':final['minimum_available_bytes'],
    'compilerSeconds':final['steps'][-1]['seconds'],'compilerTotalSeconds':final['elapsed_seconds'],
    'runs':runs,'sourceBindingFiles':len(snapshot),'unchangedBaselineGitFiles':len(baseline_git),
    'baselineNativeFilesRetained':len(baseline_retained),'compressedPayloads':len(compressed),
    'readback':'artifacts/initial-final-readback.json','performance':'artifacts/initial-benchmark-comparison.json',
    'noPushDeploymentRetirementOrCallerAdoption':True}
write(destination/'verification-summary.json',summary)
write(destination/'compressed-artifacts.json',compressed)
write(destination/'retained-artifacts.json',retained)
write(destination/'runtime-provenance-exclusions.json',{
    'scope':'Public installed package files and Node executable retained privately for independent hash validation; raw copies intentionally excluded from Git.',
    'files':excluded})
(destination/'README.md').write_text(
    '# Initial PostHog and receipt parser evidence\n\n'
    'This behavior-verified baseline retains four small-payload performance regressions. '
    'It is not total dimabot migration completion or a production release.\n\n'
    'The [verification summary](verification-summary.json) identifies the exact runs, resource limits and counts. '
    'The [source binding](source-binding.json) verifies all 1,267 frozen inputs against commit '+commit+
    ' and ten archive-verified SDK references. The [earlier runtime binding](runtime-baseline-source-binding.json) '
    'also preserves the four exact pre-lint native files needed for the five-timezone proof.\n\n'
    'The receipt fixture has 1,362 cases per time zone. All five Rust replays passed before lint-only corrections; '
    'the final UTC replay passed afterward. A byte-exact oracle comparison permits only one changed test-source hash; '
    'all production parser inputs, cases, BSON projections and producer recipes are unchanged.\n\n'
    'The [initial comparison](artifacts/initial-benchmark-comparison.json) and '
    '[interactive chart](artifacts/initial-posthog-benchmark.html) retain every measured regression and speedup. '
    'The workload is prepared event construction, ordered JSON and UTF-8 checksums; HTTP, queueing, databases, '
    'input setup and SDK metadata are excluded. The saved TypeScript timing trials are reused byte-for-byte '
    'only where all fifteen bound benchmark sources and the input remain identical. There is no CPU, RSS or whole-app claim.\n\n'
    'Raw fixtures, checksums, recovered source and source-reuse audits are under artifacts/. '
    'Every run receipt and log, including failed cache/lint attempts, is under runs/. '
    'The [compressed manifest](compressed-artifacts.json) records raw hashes and byte lengths. '
    'Public runtime/package byte copies are excluded, with hashes and sizes recorded. '
    'Recorded verifier scripts include a clearly named reconstructed first command script; it is not a contemporaneous signed record.\n\n'
    'The final readback found 19 unchanged production records and zero remaining task-owned containers, networks or volumes. '
    'No production mutation, caller adoption, deployment, TypeScript retirement or push occurred.\n')
write(destination/'artifact-sha256.json', {
    str(p.relative_to(destination)):digest(p.read_bytes())
    for p in sorted(destination.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(1 for p in destination.rglob('*') if p.is_file()),
                  'sourceInputsVerified':len(snapshot),'runs':len(runs),
                  'reportedFinalExecutions':sum(counts),'compressed':len(compressed)}))
