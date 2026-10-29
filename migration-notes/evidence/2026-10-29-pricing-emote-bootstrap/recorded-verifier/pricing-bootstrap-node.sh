mkdir -p /artifacts/pricing-emote-bootstrap/pricing /artifacts/pricing-emote-bootstrap/benchmark /artifacts/pricing-emote-bootstrap/emotes
node tests/fixtures/tts_usage_oracle.cjs --write /artifacts/pricing-emote-bootstrap/pricing
node tests/fixtures/tts_usage_oracle.cjs --check /artifacts/pricing-emote-bootstrap/pricing
node tests/fixtures/twitch_emotes_reference.cjs --write /artifacts/pricing-emote-bootstrap/emotes
node tests/fixtures/twitch_emotes_reference.cjs --check /artifacts/pricing-emote-bootstrap/emotes
node tests/fixtures/tts_usage_benchmark.cjs --write /artifacts/pricing-emote-bootstrap/benchmark
node /task-tools/pricing_bootstrap_provenance.cjs
