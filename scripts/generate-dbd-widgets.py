#!/usr/bin/env python3
"""Rebuild the widget catalog from the researched bilingual dataset (no network)."""
from pathlib import Path
import json
root = Path(__file__).resolve().parent.parent
source = json.loads((root / 'datasets/games/dead-by-daylight.json').read_text())
entries = []
for role, key in [('killer', 'killers'), ('survivor', 'survivors')]:
    for kind, rows in [('character', source[key]), ('perk', source['perks'][key])]:
        for row in rows:
            entries.append({'id': f"{role}:{kind}:{row['id']}", 'english': row['english'],
                            'spanish': row['spanish'], 'image_url': row['image_url'],
                            'role': role, 'kind': kind,
                            'available': row.get('available_to_unlock', True)})
assert len(entries) == len({entry['id'] for entry in entries})
out = {'source': 'datasets/games/dead-by-daylight.json',
       'researched_at': source['meta']['researched_at'], 'entries': entries}
(root / 'dimabot/src/widgets/dbd.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
