set -eu
node tests/fixtures/ai_usage_classification_reference.cjs --write /artifacts/ai-classification/attempt1/reference
node tests/fixtures/ai_usage_classification_reference.cjs --check /artifacts/ai-classification/attempt1/reference
