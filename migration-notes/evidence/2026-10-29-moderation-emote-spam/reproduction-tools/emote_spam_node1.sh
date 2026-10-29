set -eu
node tests/fixtures/moderation_emote_spam_reference.cjs --write /artifacts/moderation-emote-spam/attempt1/reference
node tests/fixtures/moderation_emote_spam_reference.cjs --check /artifacts/moderation-emote-spam/attempt1/reference
