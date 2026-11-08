#!/usr/bin/env python3
"""Render saved tuning results; never runs inference or chooses a prompt."""
import argparse
import csv
from decimal import Decimal
import hashlib
import io
import json
import math
from pathlib import Path


MODELS = {
    'respan/span-01': 'Span-01',
    'typesafe/jev-1.13': 'Jev 1.13',
    'openai/gpt-6-luna-decisions': 'Luna',
}
PHASES = ('development', 'fresh-validation', 'legacy-regression')
GROUPS = (
    ('fresh_validation', 'fresh-validation', None, 'Fresh validation',
     'Reserved contemporaneous synthetic validation. Selection was frozen using development only.'),
    ('legacy_regression', 'legacy-regression', None, 'Legacy regression',
     'Separate historical reference: 135 synthetic cases with known policy disagreements. Not the main improvement test.'),
    ('expanded_development', 'development', 'expanded_development', 'Development · expanded',
     'Prompt selection data: expanded development cases. This is not reserved validation.'),
    ('obfuscation_development', 'development', 'obfuscation_development', 'Development · obfuscation',
     'Prompt selection data: obfuscation development cases. This is not reserved validation.'),
)
COUNTS = ('observed', 'scheduled', 'positive_cases', 'benign_cases',
          'positive_attempts', 'benign_attempts', 'timely_tp', 'timely_fp', 'returned_fp', 'errors')


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def metrics(value, context):
    if not isinstance(value, dict) or value.get('complete') is not True:
        raise ValueError(context + ': complete metrics required')
    for key in COUNTS:
        if type(value.get(key)) is not int or value[key] < 0:
            raise ValueError(context + ': missing or invalid ' + key)
    if not numeric(value.get('latency_p95_ms')):
        raise ValueError(context + ': missing or invalid latency_p95_ms')
    if value['observed'] != value['scheduled'] or value['observed'] != value['positive_attempts'] + value['benign_attempts']:
        raise ValueError(context + ': inconsistent attempt coverage')
    if not value['positive_cases'] or not value['benign_cases']:
        raise ValueError(context + ': positive and benign cases required')
    repeats = value['positive_attempts'] / value['positive_cases']
    if repeats <= 0 or not repeats.is_integer() or value['benign_attempts'] != value['benign_cases'] * repeats:
        raise ValueError(context + ': inconsistent repeat counts')
    if value['timely_tp'] > value['positive_attempts'] or not value['timely_fp'] <= value['returned_fp'] <= value['benign_attempts'] or value['errors'] > value['observed']:
        raise ValueError(context + ': invalid outcome counts')
    return {**{key: value[key] for key in COUNTS}, 'p95_ms': value['latency_p95_ms'],
            'repeats': int(repeats), 'complete': True}


def cost_rows(root):
    totals = {key: 0 for key in ('attempts', 'byok_attempts', 'unknown_returned_cost_attempts',
              'unknown_byok_upstream_attempts', 'unknown_byok_status_attempts', 'unknown_attempts')}
    returned = Decimal(0)
    upstream = Decimal(0)
    phase_counts = {}
    source_hashes = {}
    for phase in PHASES:
        path = root / phase / 'raw.jsonl'
        if not path.exists():
            continue
        source_hashes[str(path.relative_to(root))] = sha(path)
        seen_ids, seen_tasks = set(), set()
        counts = {}
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get('model') not in MODELS:
                raise ValueError(f'{path}:{line_number}: unauthorized model')
            task = tuple(row.get(key) for key in ('model', 'variant', 'case', 'repeat'))
            attempt = row.get('attempt_id')
            if not isinstance(attempt, str) or not attempt or attempt in seen_ids or task in seen_tasks or any(v is None for v in task):
                raise ValueError(f'{path}:{line_number}: missing or duplicate attempt')
            seen_ids.add(attempt)
            seen_tasks.add(task)
            pair = (row['model'], row['variant'])
            counts[pair] = counts.get(pair, 0) + 1
            raw = row.get('raw')
            usage = raw.get('usage') if isinstance(raw, dict) else None
            usage = usage if isinstance(usage, dict) else {}
            cost = usage.get('cost')
            known_returned = numeric(cost)
            byok = usage.get('is_byok')
            details = usage.get('cost_details')
            estimate = details.get('upstream_inference_cost') if isinstance(details, dict) else None
            known_upstream = numeric(estimate)
            totals['attempts'] += 1
            totals['byok_attempts'] += byok is True
            totals['unknown_returned_cost_attempts'] += not known_returned
            totals['unknown_byok_upstream_attempts'] += byok is True and not known_upstream
            totals['unknown_byok_status_attempts'] += type(byok) is not bool
            totals['unknown_attempts'] += not known_returned or type(byok) is not bool or (byok is True and not known_upstream)
            if known_returned:
                returned += Decimal(str(cost))
            if byok is True and known_upstream:
                upstream += Decimal(str(estimate))
        phase_counts[phase] = counts
    totals.update(openrouter_usd=float(returned), byok_usd=float(upstream),
                  combined_known_usd=float(returned + upstream),
                  phase_attempts={phase: sum(counts.values()) for phase, counts in phase_counts.items()},
                  scope='All actual raw attempts across available phases and variants; each stored attempt counted once.')
    return totals, phase_counts, source_hashes


def build_data(root, selection_path):
    frozen = load(selection_path)
    if not isinstance(frozen, dict):
        raise ValueError('selection JSON must be an object')
    selection = frozen.get('selection', frozen)
    if not isinstance(selection, dict) or set(selection) != set(MODELS) or any(v not in ('baseline', 'context_v1', 'policy_v2') for v in selection.values()):
        raise ValueError('selection must map exactly the three authorized models to frozen variant IDs')
    summaries, source_meta, hashes = {}, {}, {}
    for phase in PHASES:
        directory = root / phase
        path = directory / 'summary.json'
        if not path.exists():
            continue
        summaries[phase] = load(path)
        hashes[str(path.relative_to(root))] = sha(path)
        meta_path = directory / 'meta.json'
        if not meta_path.exists():
            raise ValueError(str(meta_path) + ': required frozen source metadata missing')
        meta = load(meta_path)
        if not isinstance(meta.get('source_hashes'), dict) or not meta['source_hashes']:
            raise ValueError(str(meta_path) + ': frozen source hashes required')
        source_meta[phase] = meta
        hashes[str(meta_path.relative_to(root))] = sha(meta_path)
    if not summaries:
        raise ValueError('no completed phase summaries available')
    if 'development' in summaries and summaries['development'].get('selection') != selection:
        raise ValueError('frozen selection differs from development-only summary selection')
    rows = []
    for model, label in MODELS.items():
        for role, variant in (('baseline', 'baseline'), ('selected', selection[model])):
            retained = role == 'selected' and variant == 'baseline'
            rows.append({'id': model + ':' + role, 'model': model, 'label': label,
                         'role': role, 'variant': variant, 'retained_baseline': retained,
                         'variant_label': 'baseline retained' if retained else variant,
                         'same_stored_metrics_as': model + ':baseline' if retained else None})
    cost, raw_counts, raw_hashes = cost_rows(root)
    hashes.update(raw_hashes)
    groups = {}
    for key, phase, subgroup, label, description in GROUPS:
        if phase not in summaries:
            continue
        results = {}
        for row in rows:
            context = phase + '/' + row['model'] + '/' + row['variant']
            try:
                source = summaries[phase]['models'][row['model']][row['variant']]
                value = source['overall'] if subgroup is None else source['evaluation_groups'][subgroup]
                overall = metrics(source['overall'], context)
            except KeyError as exc:
                raise ValueError(context + ': required metrics missing: ' + str(exc)) from exc
            if raw_counts.get(phase, {}).get((row['model'], row['variant'])) != overall['observed']:
                raise ValueError(context + ': raw attempt count differs from complete summary')
            results[row['id']] = metrics(value, context + '/' + key)
        reference = next(iter(results.values()))
        count_keys = ('positive_cases', 'benign_cases', 'positive_attempts', 'benign_attempts', 'repeats')
        if any(any(result[k] != reference[k] for k in count_keys) for result in results.values()):
            raise ValueError(phase + ': comparison rows have unequal group coverage')
        groups[key] = {'label': label, 'phase': phase, 'description': description,
                       **{k: reference[k] for k in count_keys}, 'rows': results}
    missing = [phase for phase in PHASES if phase not in summaries]
    notice = ('Unavailable completed phases: ' + ', '.join(missing) + '. ') if missing else ''
    notice += 'Selection is supplied by the frozen development-only selection file; this renderer never chooses or retunes a prompt. Retained-baseline rows reuse the same stored metrics and add no inference calls.'
    return {'schema_version': 1, 'title': 'Moderation prompt tuning', 'rows': rows, 'groups': groups,
            'default_group': 'fresh_validation' if 'fresh_validation' in groups else next(iter(groups)),
            'selection': selection, 'cost': cost, 'notice': notice,
            'metadata': {'selection_sha256': sha(selection_path), 'selection_file': str(selection_path.resolve()),
                         'source_hashes': hashes, 'frozen_phase_metadata': source_meta,
                         'generator_sha256': sha(Path(__file__)),
                         'template_sha256': sha(Path(__file__).with_name('comparison-template.html'))}}


def render(root, selection_path):
    data = build_data(root, selection_path)
    template = Path(__file__).with_name('comparison-template.html').read_text(encoding='utf-8')
    if template.count('__BENCHMARK_JSON__') != 1:
        raise ValueError('template must contain exactly one data placeholder')
    # Embedded JSON is code data, never markup. Escape script delimiters and JS separators.
    embedded = json.dumps(data, ensure_ascii=False, allow_nan=False).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    output = io.StringIO(newline='')
    fields = ['group', 'phase', 'model', 'role', 'variant', 'variant_label', 'same_stored_metrics_as',
              *COUNTS, 'repeats', 'p95_ms', 'timely_catch_percent', 'timely_false_ban_percent']
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for key, group in data['groups'].items():
        for row in data['rows']:
            result = group['rows'][row['id']]
            writer.writerow({'group': key, 'phase': group['phase'],
                             **{k: row[k] for k in ('model', 'role', 'variant', 'variant_label', 'same_stored_metrics_as')},
                             **{k: result[k] for k in (*COUNTS, 'repeats', 'p95_ms')},
                             'timely_catch_percent': result['timely_tp'] / result['positive_attempts'] * 100,
                             'timely_false_ban_percent': result['timely_fp'] / result['benign_attempts'] * 100})
    artifacts = {'comparison-data.json': json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + '\n',
                 'comparison.html': template.replace('__BENCHMARK_JSON__', embedded),
                 'results-table.csv': output.getvalue()}
    for name, content in artifacts.items():
        (root / name).write_text(content, encoding='utf-8')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Parent of development, fresh-validation, and legacy-regression runs')
    parser.add_argument('--selection', type=Path, required=True, help='Frozen development-only selection JSON')
    args = parser.parse_args()
    try:
        data = render(args.root, args.selection)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(2, 'error: ' + str(exc) + '\n')
    print(json.dumps({'groups': list(data['groups']), 'display_rows': len(data['rows']),
                      'actual_cost_attempts': data['cost']['attempts'], 'root': str(args.root)}))


if __name__ == '__main__':
    main()
