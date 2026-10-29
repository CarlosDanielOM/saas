import json,hashlib,sys
from pathlib import Path
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');a=s/'artifacts/moderation-schema'/sys.argv[1];root=s/'source/dimabot';live=Path('/root/saas-rust/dimabot');sha=lambda b:hashlib.sha256(b).hexdigest()
x=json.loads((a/'core-reference/schema-composite-defaults-reference.json').read_text());paths={'typescript-js':live/'node_modules/typescript/lib/typescript.js','typescript-package':live/'node_modules/typescript/package.json','mongoose-js':live/'node_modules/mongoose/index.js','mongoose-package':live/'node_modules/mongoose/package.json','oracle-script':root/'tests/fixtures/schema_composite_defaults_reference.cjs'}
for key,digest in x['sourceSha256'].items():
 if key.startswith('mongoose/'):p=live/'node_modules/mongoose'/key.removeprefix('mongoose/')
 elif key.startswith('bson-'):
  endings=['lib/bson.cjs','package.json'];candidates=[b/endings[key=='bson-package'] for b in [live/'node_modules/bson',live/'node_modules/mongoose/node_modules/bson',live/'node_modules/mongoose/node_modules/mongodb/node_modules/bson']];match=[p for p in candidates if p.is_file() and sha(p.read_bytes())==digest];assert len(match)==1,(key,match);p=match[0]
 else:p=paths.get(key,root/key)
 assert sha(p.read_bytes())==digest,key
 paths[key]=p
m=json.loads((a/'model-reference/channel-moderation-settings-reference.json').read_text())
for key,digest in {**m['metadata']['pins'],**m['metadata']['hashes']}.items():
 p=(live if key.startswith('node_modules/') else root)/key;assert sha(p.read_bytes())==digest,key
assert sha((s/'artifacts/posthog-receipt/attempt1/node-provenance/node').read_bytes())==x['nodeExecutableSha256']==m['metadata']['nodeSha']
report={'sourceTreeSha256':hashlib.sha256(json.dumps(json.loads((s/'snapshot.json').read_text()),sort_keys=True).encode()).hexdigest(),'coreFixtureSha256':sha((a/'core-reference/schema-composite-defaults-reference.json').read_bytes()),'coreCases':len(x['cases']),'coreSourceCases':len(x['actualCases']),'modelFixtureSha256':sha((a/'model-reference/channel-moderation-settings-reference.json').read_bytes()),'modelCases':len(m['cases']),'allSourceNativeSdkNodeHashesChecked':True,'coreResolvedHashPaths':{k:str(v) for k,v in paths.items()}}
(a/'independent-reference-readback.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='coreResolvedHashPaths'}))
