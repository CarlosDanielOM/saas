#!/usr/bin/env python3
"""Render audited real-chat experiment aggregates; never infers or selects a prompt."""
import argparse
import csv
from decimal import Decimal
import hashlib
import io
import json
import math
from pathlib import Path


MODELS = {
    'typesafe/jev-1.13': 'Jev 1.13',
    'openai/gpt-6-luna-decisions': 'Luna',
}
VARIANTS = ('baseline', 'policy_v2', 'concise_v3', 'fewshot_v4')
PHASES = ('development', 'real-holdout', 'fresh-challenge')
GROUPS = (
    ('fresh_challenge', 'fresh-challenge', None, 'Fresh synthetic challenge',
     'Reserved synthetic challenge, double AI reviewed. Both catch and false-ban rates are measured against AI-consensus labels.'),
    ('real_holdout', 'real-holdout', None, 'Real holdout · benign only',
     'Strict campaign/prior-overlap grouping left zero positive cases. This measures false bans on benign real chat; recall and overall accuracy are not measured.'),
    ('real_development', 'development', 'real_development', 'Real development',
     'Real-chat development data used for prompt selection. This is not reserved validation.'),
    ('synthetic_guardrail', 'development', 'synthetic_guardrail', 'Synthetic guardrail development',
     'Synthetic development guardrails used for prompt selection. This is not reserved validation.'),
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
    repeats = None
    for label in ('positive', 'benign'):
        cases, attempts = value[label + '_cases'], value[label + '_attempts']
        if cases == 0:
            if attempts != 0:
                raise ValueError(context + ': attempts without ' + label + ' cases')
            continue
        current = attempts / cases
        if current <= 0 or not current.is_integer() or (repeats is not None and current != repeats):
            raise ValueError(context + ': inconsistent repeat counts')
        repeats = int(current)
    if repeats is None:
        raise ValueError(context + ': empty evaluation group')
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
            if row.get('variant') not in VARIANTS or (row['model'] == 'typesafe/jev-1.13' and row['variant'] != 'baseline'):
                raise ValueError(f'{path}:{line_number}: unauthorized model variant')
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
    if not isinstance(selection, dict) or set(selection) != set(MODELS) or any(v not in VARIANTS for v in selection.values()) or selection.get('typesafe/jev-1.13') != 'baseline':
        raise ValueError('selection must map exactly the two authorized models (Jev baseline only) to frozen variant IDs')
    summaries, source_meta, hashes = {}, {}, {}
    for phase in PHASES:
        directory = root / phase
        path = directory / 'summary.json'
        if not path.exists():
            continue
        summary = load(path)
        if not isinstance(summary.get('models'), dict) or set(summary['models']) != set(MODELS):
            raise ValueError(str(path) + ': exactly the two authorized models required')
        for model, variants in summary['models'].items():
            if not isinstance(variants, dict) or not variants or any(v not in VARIANTS for v in variants) or (model == 'typesafe/jev-1.13' and set(variants) != {'baseline'}):
                raise ValueError(str(path) + ': unauthorized model variant')
            for variant, result in variants.items():
                metrics(result.get('overall'), phase + '/' + model + '/' + variant)
        summaries[phase] = summary
        hashes[str(path.relative_to(root))] = sha(path)
        meta_path = directory / 'meta.json'
        if not meta_path.exists():
            raise ValueError(str(meta_path) + ': required frozen source metadata missing')
        meta = load(meta_path)
        if not isinstance(meta, dict) or set(meta.get('models', [])) != set(MODELS):
            raise ValueError(str(meta_path) + ': exactly the two authorized models required')
        if not isinstance(meta.get('source_hashes'), dict) or not meta['source_hashes']:
            raise ValueError(str(meta_path) + ': frozen source hashes required')
        scheduled = meta.get('model_variants')
        if not isinstance(scheduled, dict) or set(scheduled) != set(MODELS):
            raise ValueError(str(meta_path) + ': frozen model variant schedule required')
        for model, variants in summary['models'].items():
            if set(scheduled[model]) != set(variants):
                raise ValueError(str(path) + ': summary differs from frozen variant schedule')
            for variant, result in variants.items():
                if metrics(result['overall'], phase)['repeats'] != meta.get('repeats'):
                    raise ValueError(str(path) + ': repeat count differs from frozen metadata')
        audit_path, raw_path = directory / 'audit.json', directory / 'raw.jsonl'
        if not audit_path.exists() or not raw_path.exists():
            raise ValueError(str(directory) + ': completed audit and raw attempts required')
        audit = load(audit_path)
        if audit.get('complete') is not True or type(audit.get('mismatch_count')) is not int or audit['mismatch_count'] != 0:
            raise ValueError(str(audit_path) + ': complete zero-mismatch audit required')
        if audit.get('meta_sha256') != sha(meta_path) or audit.get('raw_sha256') != sha(raw_path):
            raise ValueError(str(audit_path) + ': audit raw/meta hashes differ from current files')
        for model, variants in summary['models'].items():
            for variant, result in variants.items():
                audited = audit.get('metrics', {}).get(model, {}).get(variant, {})
                for name in ('observed', 'scheduled', 'timely_tp', 'timely_fp', 'returned_fp', 'errors', 'latency_p95_ms'):
                    if audited.get(name) != result['overall'].get(name):
                        raise ValueError(str(path) + ': summary differs from audited ' + name)
        hashes[str(audit_path.relative_to(root))] = sha(audit_path)
        source_meta[phase] = meta
        hashes[str(meta_path.relative_to(root))] = sha(meta_path)
    if not summaries:
        raise ValueError('no completed phase summaries available')
    if 'development' in summaries and summaries['development'].get('selection') != selection:
        raise ValueError('frozen selection differs from development-only summary selection')
    rows = []
    for model, label in MODELS.items():
        roles = (('baseline', 'baseline'),) if model == 'typesafe/jev-1.13' else (('baseline', 'baseline'), ('selected', selection[model]))
        for role, variant in roles:
            retained = role == 'selected' and variant == 'baseline'
            rows.append({'id': model + ':' + role, 'model': model, 'label': label,
                         'role': role, 'variant': variant, 'retained_baseline': retained,
                         'variant_label': 'baseline retained' if retained else variant,
                         'same_stored_metrics_as': model + ':baseline' if retained else None})
    cost, raw_counts, raw_hashes = cost_rows(root)
    hashes.update(raw_hashes)
    for phase, summary in summaries.items():
        expected = {(model, variant): metrics(result['overall'], phase)['observed']
                    for model, variants in summary['models'].items() for variant, result in variants.items()}
        if raw_counts.get(phase) != expected:
            raise ValueError(phase + ': raw attempt coverage differs from complete summary')
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
        if key == 'real_holdout' and reference['positive_cases'] != 0:
            raise ValueError(phase + ': expected benign-only real holdout')
        groups[key] = {'label': label, 'phase': phase, 'description': description,
                       **{k: reference[k] for k in count_keys}, 'rows': results}
    missing = [phase for phase in PHASES if phase not in summaries]
    notice = ('Unavailable completed phases: ' + ', '.join(missing) + '. ') if missing else ''
    notice += 'AI-consensus labels are not moderator ground truth. Selection is supplied by the frozen development-only selection file; this renderer never chooses or retunes a prompt. Retained-baseline rows reuse the same stored metrics and add no inference calls.'
    return {'schema_version': 1, 'title': 'Luna and Jev · real-chat experiment', 'rows': rows, 'groups': groups,
            'default_group': 'fresh_challenge' if 'fresh_challenge' in groups else next(iter(groups)),
            'selection': selection, 'cost': cost, 'notice': notice,
            'metadata': {'selection_sha256': sha(selection_path), 'selection_file': str(selection_path.resolve()),
                         'source_hashes': hashes, 'frozen_phase_metadata': source_meta,
                         'generator_sha256': sha(Path(__file__)),
                         'template_sha256': sha(Path(__file__).with_name('comparison-template.html'))}}


def percent(count, denominator):
    return count / denominator * 100 if denominator else None


def render(root, selection_path):
    data = build_data(root, selection_path)
    template = Path(__file__).with_name('comparison-template.html').read_text(encoding='utf-8')
    if template.count('__BENCHMARK_JSON__') != 1:
        raise ValueError('template must contain exactly one data placeholder')
    # Embedded JSON is code data, never markup. Escape script delimiters and JS separators.
    embedded = json.dumps(data, ensure_ascii=False, allow_nan=False).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    output = io.StringIO(newline='')
    fields = ['group', 'group_label', 'phase', 'model', 'model_label', 'role', 'variant', 'variant_label', 'same_stored_metrics_as',
              *COUNTS, 'repeats', 'p95_ms', 'timely_catch_percent', 'timely_false_ban_percent', 'returned_false_ban_percent', 'catch_status']
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for key, group in data['groups'].items():
        for row in data['rows']:
            result = group['rows'][row['id']]
            writer.writerow({'group': key, 'group_label': group['label'], 'phase': group['phase'], 'model_label': row['label'],
                             **{k: row[k] for k in ('model', 'role', 'variant', 'variant_label', 'same_stored_metrics_as')},
                             **{k: result[k] for k in (*COUNTS, 'repeats', 'p95_ms')},
                             'timely_catch_percent': percent(result['timely_tp'], result['positive_attempts']),
                             'timely_false_ban_percent': percent(result['timely_fp'], result['benign_attempts']),
                             'returned_false_ban_percent': percent(result['returned_fp'], result['benign_attempts']),
                             'catch_status': 'measured' if result['positive_attempts'] else 'not measured — no positive cases'})
    artifacts = {'comparison-data.json': json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + '\n',
                 'comparison.html': template.replace('__BENCHMARK_JSON__', embedded),
                 'results-table.csv': output.getvalue()}
    for name, content in artifacts.items():
        (root / name).write_text(content, encoding='utf-8')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Parent of development, real-holdout, and fresh-challenge runs')
    parser.add_argument('--selection', type=Path, help='Frozen development-only selection JSON')
    args = parser.parse_args()
    try:
        data = render(args.root, args.selection or args.root / 'selection.json')
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(2, 'error: ' + str(exc) + '\n')
    print(json.dumps({'groups': list(data['groups']), 'display_rows': len(data['rows']),
                      'actual_cost_attempts': data['cost']['attempts'], 'root': str(args.root)}))


if __name__ == '__main__':
    main()
