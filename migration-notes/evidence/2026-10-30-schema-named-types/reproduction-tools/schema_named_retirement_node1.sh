#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
base=/artifacts/schema-named-retirement/attempt1
mkdir -p "$base/named" "$base/application" "$base/action" "$base/date" "$base/date-repeat"
node tests/fixtures/schema_source_resolver.test.cjs
node tests/fixtures/schema_named_types_reference.cjs --write "$base/named"
node tests/fixtures/schema_named_types_reference.cjs --check "$base/named"
node tests/fixtures/application_schemas_reference.mjs --check
node tests/fixtures/application_schemas_reference.mjs --write "$base/application"
node tests/fixtures/application_schemas_reference.mjs --check "$base/application"
node tests/fixtures/moderation_action_log_schema_reference.cjs --write "$base/action"
node tests/fixtures/moderation_action_log_schema_reference.cjs --check "$base/action"
node tests/fixtures/mongoose_date_reference.mjs "$base/date"
node tests/fixtures/mongoose_date_reference.mjs "$base/date-repeat"
python3 - <<'PY'
import pathlib,json
base=pathlib.Path('/artifacts/schema-named-retirement/attempt1'); comparisons={}
for p in sorted((base/'date').glob('*.json')):
 assert p.read_bytes()==(base/'date-repeat'/p.name).read_bytes(),p.name
 new=json.loads(p.read_text());old=json.loads((pathlib.Path('/artifacts/mongoose-date-final')/p.name).read_text());assert new['cases']==old['cases'] and new['missing']==old['missing'],p.name
 comparisons[p.name]={'cases':len(new['cases']),'all_cases_and_missing_equal_prior':True,'repeat_generation_identical':True}
(base/'date-semantic-comparison.json').write_text(json.dumps(comparisons,indent=2)+'\n')
PY
