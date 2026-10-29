export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-20261029validation1:
mkdir -p /artifacts/ai-credit-receipt/projection /artifacts/ai-credit-receipt/producer /artifacts/ai-credit-receipt/producer-benchmark /artifacts/ai-credit-receipt/runtime-provenance
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const base="/artifacts/ai-credit-receipt/runtime-provenance/"; const files={node:process.execPath,typescript:require.resolve("typescript"),typescriptPackage:require.resolve("typescript/package.json")}; const out={}; for(const [name,file] of Object.entries(files)){fs.copyFileSync(file,base+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(base+name,0o444);const bytes=fs.readFileSync(base+name);out[name]={sha256:crypto.createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};} fs.writeFileSync(base+"files.json",JSON.stringify(out,null,2)+"\n",{flag:"wx"});'
node tests/fixtures/ai_credit_projection_reference.cjs --write /artifacts/ai-credit-receipt/projection
node tests/fixtures/ai_credit_projection_reference.cjs --check /artifacts/ai-credit-receipt/projection
node tests/fixtures/ai_usage_producer_reference.cjs --write /artifacts/ai-credit-receipt/producer
node tests/fixtures/ai_usage_producer_reference.cjs --check /artifacts/ai-credit-receipt/producer
node tests/fixtures/ai_usage_producer_benchmark.cjs --write /artifacts/ai-credit-receipt/producer-benchmark
node /task-tools/ai_credit_receipt_provenance.cjs
