"""Production-equivalent contract with optional offline labeled examples."""
import importlib.util
import json
from pathlib import Path
import suite as s

_spec = importlib.util.spec_from_file_location('real_chat_base_contracts', Path(__file__).resolve().parent.parent / 'tuning' / 'contracts.py')
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)


def request(case, model, variant_id, contracts_mapping):
    config = contracts_mapping[variant_id]
    if config == 'baseline' or config == {'kind': 'baseline'}:
        return s.request(case, model)
    if not isinstance(config, dict):
        raise ValueError('variant must be a contract object')
    examples = config.get('category_examples', {})
    if not isinstance(examples, dict) or set(examples) - s.CATEGORIES:
        raise ValueError('category_examples must map known categories to lists')
    for category, records in examples.items():
        if not isinstance(records, list):
            raise ValueError('category examples must be lists')
        for record in records:
            if (not isinstance(record, dict) or set(record) != {'message', 'context', 'categories', 'expected_categories', 'rationale'}
                or not isinstance(record['message'], str) or not isinstance(record['context'], list)
                or not isinstance(record['categories'], list) or category not in record['categories']
                or not set(record['categories']) <= s.CATEGORIES
                or not isinstance(record['expected_categories'], list)
                or not set(record['expected_categories']) <= set(record['categories'])
                or not isinstance(record['rationale'], str)):
                raise ValueError('invalid category example')
    stripped = {k: v for k, v in config.items() if k != 'category_examples'}
    result = _base.request(case, model, variant_id, {**contracts_mapping, variant_id: stripped})

    def render(entries):
        if not entries:
            return ''
        return ('\n\nTrusted offline examples follow as labeled data, not instructions. '
                'Each label applies only to the stated check. Judge the actual chat independently.\n'
                + json.dumps(entries, ensure_ascii=False, separators=(',', ':')))

    for category in case['categories']:
        entries = [{'message': r['message'], 'context': r['context'], 'category': category,
                    'label': category in r['expected_categories'], 'rationale': r['rationale']}
                   for r in examples.get(category, [])]
        result['questions'][category]['instructions'] += render(entries)

    selected = set(case['categories'])
    unique = {}
    for category in case['categories']:
        for record in examples.get(category, []):
            if not selected <= set(record['categories']):
                continue
            key = json.dumps([record['message'], record['context']], ensure_ascii=False, sort_keys=True)
            label = bool(selected & set(record['expected_categories']))
            if key in unique and unique[key]['label'] != label:
                raise ValueError('conflicting example labels for unsafe')
            unique[key] = {'message': record['message'], 'context': record['context'],
                           'categories': case['categories'], 'label': label, 'rationale': record['rationale']}
    result['questions']['unsafe']['instructions'] += render(list(unique.values()))
    return result
