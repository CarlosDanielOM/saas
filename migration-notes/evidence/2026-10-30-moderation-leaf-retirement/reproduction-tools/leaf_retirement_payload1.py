#!/usr/bin/env python3
import json
from pathlib import Path
base = Path('/artifacts/moderation-leaf-retirement/attempt1')
art = Path('/artifacts')
def read(path):
    with path.open(encoding='utf-8') as file:
        return json.load(file)
checks = [
 ('normalize', base/'moderation_normalize_reference/moderation-normalize-reference.json', art/'moderation-text/attempt2/normalize-reference/moderation-normalize-reference.json', {'cases': 228, 'nullish': 2}),
 ('links', base/'moderation_links_reference/moderation_links_reference.json', art/'moderation-text/attempt2/links-reference/moderation_links_reference.json', {'cases': 45057}),
 ('categories', base/'moderation_spam_categories_reference/moderation_spam_categories_reference.json', art/'moderation-spam-categories/attempt2/reference/moderation_spam_categories_reference.json', {'cases': 752}),
 ('text benchmark', base/'moderation_text_benchmark/moderation-text-benchmark-input.json', art/'moderation-text-benchmark/attempt2/prepared/moderation-text-benchmark-input.json', {'pools': 4}),
]
for name, candidate, prior, fields in checks:
    current, original = read(candidate), read(prior)
    for field, count in fields.items():
        assert len(current[field]) == count, (name, field, len(current[field]))
        assert current[field] == original[field], (name, field, 'payload changed')
    if name == 'categories':
        assert current['metadata']['constants'] == original['metadata']['constants']
    print(f'{name}: payload matches prior evidence')
