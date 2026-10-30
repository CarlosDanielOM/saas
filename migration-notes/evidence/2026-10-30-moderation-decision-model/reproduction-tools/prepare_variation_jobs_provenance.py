import hashlib,json,shutil
from pathlib import Path
state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');root=Path('/root/saas-rust/dimabot');wave=state/'artifacts/moderation-variation-jobs/attempt1';file=wave/'reference/moderation-variation-jobs-reference.json'
sha=lambda b:hashlib.sha256(b).hexdigest()
assert sha(file.read_bytes())=='4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b'
r=json.loads(file.read_text());assert len(r['cases'])==38 and len({v['name'] for v in r['cases']})==38
pins=dict(r['provenance']['pins'])
pins.update({'src/utils/moderation/variation_jobs.ts':r['provenance']['sourceSha256'],'tests/fixtures/moderation_variation_jobs_reference.cjs':r['provenance']['readerSha256'],'tests/fixtures/moderation_variations_source.cjs':r['provenance']['loaderSha256']})
out=wave/'source-provenance';assert not out.exists();out.mkdir()
for name,pin in pins.items():
 assert not Path(name).is_absolute() and '..' not in Path(name).parts
 source=(root if name.startswith('node_modules/') else state/'source/dimabot')/name
 raw=source.read_bytes();assert sha(raw)==pin,name
 dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);dest.chmod(0o444)
(wave/'source-provenance-manifest.json').write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps({'caseCount':38,'sourceAndSdkPins':len(pins),'referenceSha256':sha(file.read_bytes())}))
