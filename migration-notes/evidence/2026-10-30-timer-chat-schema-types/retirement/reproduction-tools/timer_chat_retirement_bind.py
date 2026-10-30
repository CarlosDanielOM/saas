from pathlib import Path
import json,hashlib
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';out=art/'timer-chat-retirement';fresh=out/'attempt1';sha=lambda b:hashlib.sha256(b).hexdigest();checks=[]
def compare(label,before,after,keys):
 a=json.loads(before.read_bytes());b=json.loads(after.read_bytes());assert all(a[k]==b[k] for k in keys),label
 checks.append({'label':label,'before':str(before),'after':str(after),'before_sha256':sha(before.read_bytes()),'after_sha256':sha(after.read_bytes()),'equal_fields':keys,'equal':True})
compare('additional embedded 194-case Mongoose corpus',root/'dimabot/tests/fixtures/additional_schemas_cases.json',fresh/'additional/additional-schemas-reference.json',['fixedNow','timeZone','sources','definitions','cases'])
compare('timer/chat named types before source retirement',art/'timer-chat-schema-types/attempt1/oracle/timer-chat-schema-types-reference.json',fresh/'timer/timer-chat-schema-types-reference.json',['format','versions','nodePin','pins','sources','imports','hooks','declarations','signatures','bsonStrings','bsonNumbers'])
for sub,name,keys in [('application','application-schemas-reference.json',['sources','fixedNow','definitions','cases','workloads']),('named','schema-named-types-reference.json',['format','bsonStrings','bsonNumbers','versions','nodePin','sources','imports','declarations','signatures','catalogs']),('action','moderation-action-log-schema-reference.json',['versions','nodeExecutableSha256','compiledSha256','model','collection','indexes','now','cases','wire'])]:
 compare(sub+' regression corpus',art/'schema-named-retirement/attempt1'/sub/name,fresh/sub/name,keys)
a=json.loads((art/'schema-named-retirement/attempt1/action/moderation-action-log-schema-reference.json').read_text())['sourceSha256'];b=json.loads((fresh/'action/moderation-action-log-schema-reference.json').read_text())['sourceSha256'];changed=[k for k in a if a[k]!=b[k]];assert changed==['Cargo.toml','source-resolver','source-guard'],changed
(out/'oracle-semantic-comparison.json').write_text(json.dumps({'all_semantic_comparisons_match':True,'action_log_provenance_only_changes':changed,'action_log_cargo_change':'Accepted intervening feature wiring; no action-log behavior difference. Fresh replay validates current hashes.','comparisons':checks},indent=2)+'\n')
inputs=json.loads((state/'snapshot.json').read_text());assert len(inputs)==1491;assert sha(json.dumps(inputs,sort_keys=True).encode())=='06d19561a1f9a97ce0b4c7a8d442ce6ed841457f68dd0bec8a575941c41ac888'
(out/'source-final.json').write_bytes((state/'snapshot.json').read_bytes())
records=json.loads((out/'archive-verification.json').read_text())['sources'];removed=[r['logical_source'] for r in records]
paths=['archives/dimabot-typescript/2026-10-28/README.md','archives/dimabot-typescript/2026-10-28/manifest.json']+removed+[r['archived_source'] for r in records]+['dimabot/tests/'+p for p in ['additional_schemas.rs','application_schemas.rs','schema_named_types.rs','support/schema_source.rs','timer_chat_schema_types.rs','fixtures/additional_schemas_reference.mjs','fixtures/schema_source_resolver.cjs','fixtures/schema_source_resolver.test.cjs','fixtures/timer_chat_schema_types_reference.cjs']]
for p in paths:
 if p in removed:assert p not in inputs
 else:assert sha((root/p).read_bytes())==inputs[p],p
(out/'tested-delta-paths.json').write_text(json.dumps(paths,indent=2)+'\n');print({'archive_count':45,'semantic_comparisons':5,'tested_paths':len(paths),'inputs':len(inputs)})
