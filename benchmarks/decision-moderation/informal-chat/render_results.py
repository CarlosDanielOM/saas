#!/usr/bin/env python3
"""Reuse the audited comparison renderer for the fixed informal-chat check."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tuning'))
import render_comparison as renderer

renderer.PHASES = ('validation',)
renderer.GROUPS = (
    ('informal_chat', 'validation', None, 'Informal viewer chat',
     'Short viewer messages without quotation marks or broadcaster chat. '
     'Fixed production and previously selected prompts; no retuning. '
     'Balanced synthetic stress cases, not a traffic-weighted accuracy estimate.'),
)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    args = parser.parse_args()
    data = renderer.render(args.root, args.selection)
    print(json.dumps({'groups': list(data['groups']), 'calls': data['cost']['attempts']}))
