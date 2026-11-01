"""Run inside an isolated or live embeddings container with a catalog batch fixture."""
import json
import math
import os
import urllib.error
import urllib.request


def request(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        'http://127.0.0.1:8080' + path,
        data=data,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        return json.load(response)


assert request('/health')['status'] == 'ok'
with open(os.environ.get('EMBEDDINGS_BATCH_FIXTURE', '/tmp/saas-fixtures/batch32.json')) as fixture:
    texts = json.load(fixture)
assert len(texts) == 32
for kind, inputs in [('document', texts), ('query', ['skip the current TTS message'])]:
    result = request('/v1/embeddings', {'input': inputs, 'kind': kind})
    assert len(result['data']) == len(inputs)
    for i, row in enumerate(result['data']):
        assert row['index'] == i
        vector = row['embedding']
        assert len(vector) == 1024 and all(math.isfinite(value) for value in vector)
        assert abs(sum(value * value for value in vector) - 1) < 0.0001
    print(f'PASS {kind}: {len(inputs)} normalized 1024-dimensional embeddings', flush=True)
try:
    request('/v1/embeddings', {'input': []})
    raise AssertionError('empty input accepted')
except urllib.error.HTTPError as error:
    assert error.code == 400
assert request('/health')['status'] == 'ok'
print('PASS empty-input rejection and readiness', flush=True)
