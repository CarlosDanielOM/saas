"""Piper baseline behavior check, executed INSIDE the isolated candidate.

Extend/copy this check for a feature change; it does not test custom IDs.
"""
import io
import json
import urllib.error
import urllib.request
import wave

base = "http://127.0.0.1:5000"
with urllib.request.urlopen(base + "/voices", timeout=10) as response:
    voices = json.load(response)
assert voices, "No fixture voices loaded"

def synthesize(payload):
    request = urllib.request.Request(base + "/synthesize", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(request, timeout=60)

for payload in ({"text": "Deployment verification."},
                {"text": "Deployment verification.", "voice": next(iter(voices))}):
    with synthesize(payload) as response:
        with wave.open(io.BytesIO(response.read()), "rb") as audio:
            assert audio.getnframes() > 0 and audio.getframerate() > 0

try:
    synthesize({"text": ""})
except urllib.error.HTTPError as error:
    assert 400 <= error.code < 600
else:
    raise AssertionError("Empty text was accepted")
print("Piper: voice listing, default/explicit voice synthesis, WAV data, and empty-input rejection passed")
