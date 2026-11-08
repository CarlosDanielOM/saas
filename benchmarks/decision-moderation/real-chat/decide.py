#!/usr/bin/env python3
"""Apply the frozen, case-free final benchmark comparison gate."""
import argparse
import hashlib
import json
import math
from pathlib import Path

JEV = 'typesafe/jev-1.13'
LUNA = 'openai/gpt-6-luna-decisions'
MODELS = [JEV, LUNA]
LIMITATIONS = ['AI consensus labels, not moderator truth', 'real holdout no positive cases; superior real spam recall not established']


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def phase(root, name, variant):
    directory = root / name
    audit, summary, meta = (load(directory / f) for f in ('audit.json', 'summary.json', 'meta.json'))
    if (audit.get('complete') is not True or audit.get('mismatch_count') != 0
        or type(audit.get('mismatch_count')) is not int
        or audit.get('native_mismatch_count') != 0 or audit.get('metric_mismatch_count') != 0
        or audit.get('missing_rows') != 0 or audit.get('observed_rows') != audit.get('expected_rows')):
        raise ValueError(name + ': complete zero-mismatch native audit required')
    for key, filename in [('meta_sha256', 'meta.json'), ('raw_sha256', 'raw.jsonl'),
                          ('intents_sha256', 'intents.jsonl'), ('requests_file_sha256', 'requests.json')]:
        if audit.get(key) != sha(directory / filename):
            raise ValueError(name + ': stale audit ' + key)
    if meta.get('models') != MODELS or meta.get('phase') != name or audit.get('phase') != name:
        raise ValueError(name + ': phase/model mismatch')
    if set(meta.get('model_variants', {}).get(JEV, [])) != {'baseline'} or variant not in meta.get('model_variants', {}).get(LUNA, []):
        raise ValueError(name + ': frozen variants mismatch')
    output = {}
    for model, version in ((JEV, 'baseline'), (LUNA, variant)):
        metrics = audit['metrics'][model][version]
        overall = summary['models'][model][version]['overall']
        for key in ('observed', 'scheduled', 'returned_tp', 'returned_fp', 'timely_tp', 'timely_fp', 'errors', 'latency_p95_ms'):
            if metrics.get(key) != overall.get(key):
                raise ValueError(name + ': summary differs from audited ' + key)
        for key in ('observed', 'scheduled', 'returned_tp', 'returned_fp', 'timely_tp', 'timely_fp', 'errors', 'late'):
            if type(metrics.get(key)) is not int or metrics[key] < 0:
                raise ValueError(name + ': invalid metric ' + key)
        if metrics['observed'] != metrics['scheduled'] or overall.get('complete') is not True or metrics['scheduled'] == 0:
            raise ValueError(name + ': incomplete metric coverage')
        p95 = metrics.get('latency_p95_ms')
        if type(p95) not in (int, float) or not math.isfinite(p95) or p95 < 0:
            raise ValueError(name + ': invalid latency')
        positive = overall.get('positive_attempts')
        if type(positive) is not int or not 0 <= positive <= metrics['scheduled']:
            raise ValueError(name + ': invalid positive count')
        cases = overall['affected_cases']['timely_tp']
        if not isinstance(cases, list) or any(not isinstance(c, str) for c in cases) or len(cases) != len(set(cases)) or len(cases) > metrics['timely_tp'] or metrics['timely_tp'] > positive:
            raise ValueError(name + ': invalid timely positive case set')
        output[model] = {**metrics, 'positive_attempts': positive, 'timely_tp_cases': len(cases)}
    a, b = output[JEV], output[LUNA]
    if a['scheduled'] != b['scheduled'] or a['positive_attempts'] != b['positive_attempts']:
        raise ValueError(name + ': compared cohorts differ')
    if name == 'real-holdout' and a['positive_attempts'] != 0:
        raise ValueError(name + ': expected a benign-only holdout')
    return output


def decide(root):
    root = Path(root)
    selection = load(root / 'selection.json')
    selection = selection.get('selection', selection)
    if not isinstance(selection, dict) or set(selection) != set(MODELS) or selection[JEV] != 'baseline' or not isinstance(selection[LUNA], str) or not selection[LUNA]:
        raise ValueError('invalid frozen selection')
    variant = selection[LUNA]
    checks = {}
    strict = False
    for name in ('real-holdout', 'fresh-challenge'):
        data = phase(root, name, variant)
        jev, luna = data[JEV], data[LUNA]
        fields = ['returned_fp', 'timely_fp', 'errors', 'late']
        if name == 'fresh-challenge': fields += ['timely_tp', 'timely_tp_cases']
        phase_checks = {}
        for field in fields:
            higher_is_better = field in ('timely_tp', 'timely_tp_cases')
            a, b = jev[field], luna[field]
            passed = b >= a if higher_is_better else b <= a
            phase_checks[field] = {'jev': a, 'luna': b, 'passed': passed}
            if field in ('returned_fp', 'timely_fp', 'timely_tp', 'timely_tp_cases'):
                strict |= b > a if higher_is_better else b < a
        phase_checks['luna_latency_p95_ms'] = {'value': luna['latency_p95_ms'], 'limit_exclusive': 4000, 'passed': luna['latency_p95_ms'] < 4000}
        checks[name] = phase_checks
    passed = strict and all(check['passed'] for phase_checks in checks.values() for check in phase_checks.values())
    return {'recommendation': 'luna_candidate_on_this_benchmark' if passed else 'keep_jev_1_13', 'selected_luna_variant': variant,
            'checks': checks, 'strict_improvement': strict, 'gate_passed': passed, 'limitations': LIMITATIONS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = decide(args.root)
        path = args.root / 'decision.json'
        temp = path.with_suffix('.json.tmp')
        temp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temp.replace(path)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(2, 'error: ' + str(exc) + '\n')


if __name__ == '__main__': main()
