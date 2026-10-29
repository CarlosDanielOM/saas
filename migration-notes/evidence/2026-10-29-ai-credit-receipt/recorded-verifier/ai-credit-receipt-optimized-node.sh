export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-20261029validation1:
node tests/fixtures/ai_credit_projection_reference.cjs --check /artifacts/ai-credit-receipt/projection
node tests/fixtures/ai_usage_producer_reference.cjs --write /artifacts/ai-credit-receipt/producer
node tests/fixtures/ai_usage_producer_reference.cjs --check /artifacts/ai-credit-receipt/producer
node /task-tools/ai_credit_receipt_rebind.cjs
node /task-tools/ai_credit_receipt_provenance.cjs
