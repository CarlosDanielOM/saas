node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --write /artifacts/tts-credit-fallback
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check /artifacts/tts-credit-fallback
# The inventory generator writes its adjacent JSON in the disposable snapshot.
node /source/migration-notes/dimabot-dependency-matrix-2026-10-28.mjs
mv /source/migration-notes/dimabot-dependency-matrix-2026-10-28.json /artifacts/credit-dependency-matrix.json
