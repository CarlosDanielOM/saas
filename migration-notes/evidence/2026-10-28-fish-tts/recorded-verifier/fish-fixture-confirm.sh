set -eu
sha256sum /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json > /artifacts/fish-tts-fixtures-before.sha256
for behavior in sdk_source_fixture_matches_encoder_and_http_wire sdk_source_fixture_matches_direct_error_messages typescript_service_fixture_replay; do
  FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers "$behavior" -- --ignored --exact --nocapture
done
sha256sum /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json > /artifacts/fish-tts-fixtures-after.sha256
cmp /artifacts/fish-tts-fixtures-before.sha256 /artifacts/fish-tts-fixtures-after.sha256
