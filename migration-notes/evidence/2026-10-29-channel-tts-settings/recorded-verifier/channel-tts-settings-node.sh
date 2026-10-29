node tests/fixtures/channel_tts_settings_reference.mjs --write /artifacts/channel-tts-settings
node tests/fixtures/channel_tts_settings_reference.mjs --check /artifacts/channel-tts-settings
node tests/fixtures/channel_tts_settings_reference.mjs --write /artifacts/channel-tts-settings --mongo
node tests/fixtures/channel_tts_settings_reference.mjs --check /artifacts/channel-tts-settings --mongo
node tests/fixtures/channel_tts_settings_benchmark.mjs /artifacts/channel-tts-settings/channel-tts-settings-reference.json /artifacts/channel-tts-settings
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --write /artifacts/tts-credit-fallback
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check /artifacts/tts-credit-fallback
