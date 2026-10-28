import hashlib
import json
from pathlib import Path

root = Path('/artifacts/tts-session-playback')
metadata = json.loads((root / 'tts_session_playback_sources.json').read_text())
for name, expected in metadata['fixtureHashes'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
assert not (root / 'missing.wav').exists()
print('Immutable source-oracle audio fixtures verified:', len(metadata['fixtureHashes']))
