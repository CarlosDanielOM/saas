#!/usr/bin/env python3
"""Offline request export and evaluation; this program never calls a model."""
import argparse
import hashlib
import importlib.util
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATEGORIES = {'spam', 'ads', 'self_promotion', 'profanity', 'insults'}
MAX_SAFE = 2**53 - 1
HEADERS = {'HTTP-Referer':'https://domdimabot.com', 'X-OpenRouter-Title':'DomDimaBot', 'X-OpenRouter-Description':'DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.', 'X-OpenRouter-Categories':'general-chat, roleplay', 'Content-Type':'application/json'}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def contract():
    spec = importlib.util.spec_from_file_location('native_contract', ROOT / 'legacy' / 'native_contract.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cases_for(suite, split=None):
    if suite == 'legacy':
        items = []
        for name, phase in [('cases.json', 'primary'), ('supplemental-cases.json', 'supplemental')]:
            for case in load_json(ROOT / 'legacy' / name):
                items.append((case, phase))
    else:
        items = [(c, c['split']) for c in load_json(ROOT / 'scenarios.json')]
    if split:
        items = [(c, p) for c, p in items if p == split]
    if not items:
        raise ValueError('suite/split contains no cases')
    return items


def request(case, model):
    return contract().request_for(case, model)


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def score(raw, categories):
    """Recompute the app's independent-probability safe veto, never saved scores."""
    if not isinstance(raw, dict) or not categories:
        return None
    answers, usage = raw.get('answers'), raw.get('usage')
    if not isinstance(answers, dict) or not isinstance(usage, dict):
        return None
    cost, tokens = usage.get('cost'), usage.get('input_tokens')
    if not numeric(cost) or cost < 0 or type(tokens) is not int or not 0 <= tokens <= MAX_SAFE:
        return None
    values = {}
    for key in [*categories, 'unsafe']:
        a = answers.get(key)
        if not isinstance(a, dict) or a.get('type') != 'noul' or not numeric(a.get('noul')) or not 0 <= a['noul'] <= 1:
            return None
        values[key] = a['noul']
    highest = max(values[k] for k in categories)
    safe = 1 - values['unsafe']
    return ('allow' if safe > highest else 'violation' if safe < highest and highest >= .85 else 'uncertain', cost)


def returned_cost(raw):
    usage = raw.get('usage') if isinstance(raw, dict) else None
    cost = usage.get('cost') if isinstance(usage, dict) else None
    return cost if numeric(cost) and cost >= 0 else None


def export_rows(items, model, repeats):
    for case, phase in items:
        req = request(case, model)
        for round_no in range(1, repeats + 1):
            yield {'case': case['id'], 'requested_model': model, 'round': round_no,
                   'phase': phase, 'headers': HEADERS.copy(), 'request': req, 'request_sha256': digest(req)}


def percentile(values, q):
    if not values:
        return None
    return sorted(values)[math.ceil(q * len(values)) - 1]


def evaluate(items, rows, baseline, candidate, repeats):
    if baseline == candidate or not baseline or not candidate or repeats < 1:
        raise ValueError('distinct model IDs and positive repeats required')
    case_map = {c['id']: (c, p) for c, p in items}
    if len(case_map) != len(items):
        raise ValueError('duplicate case IDs')
    models = [baseline, candidate]
    seen = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('JSONL row must be an object')
        model, cid, rnd = row.get('requested_model'), row.get('case'), row.get('round')
        row_phase = row.get('phase')
        if row_phase in ('round1', 'round2'):
            if rnd != int(row_phase[-1]):
                raise ValueError('historical phase and round disagree')
            row_phase = 'primary'
        elif row_phase == 'supplemental' and rnd == 3 and repeats <= 2:
            rnd = 1
        if model not in models or cid not in case_map or type(rnd) is not int or not 1 <= rnd <= repeats:
            raise ValueError('unknown model, case, or round')
        case, phase = case_map[cid]
        if row_phase != phase or row.get('request_sha256') != digest(request(case, model)):
            raise ValueError('wrong phase or request hash')
        key = (model, cid, rnd)
        if key in seen:
            raise ValueError('duplicate row')
        latency = row.get('latency_ms')
        if not numeric(latency) or latency < 0:
            raise ValueError('invalid latency')
        parsed = score(row.get('raw'), case['categories'])
        ok = row.get('http_status') == 200 and not row.get('error') and parsed is not None
        verdict = parsed[0] if ok else 'error'
        raw = row.get('raw')
        answers = raw['answers'] if ok else None
        scores = {name: answers[name]['noul'] for name in [*case['categories'], 'unsafe']} if answers else None
        metadata = {key: raw.get(source) if isinstance(raw, dict) and isinstance(raw.get(source), str) and raw.get(source) else '<missing>' for key, source in (('source_model', 'source_model'), ('resolved_model', 'model'), ('provider', 'provider'))}
        seen[key] = {'verdict': verdict, 'timely_ban': ok and latency < 4000 and verdict == 'violation',
                     'returned_ban': ok and verdict == 'violation', 'latency': latency,
                     'late': latency >= 4000, 'cost': returned_cost(raw), 'scores': scores, 'metadata': metadata}

    def summary(subset, model):
        records = [(c, seen.get((model, c['id'], r))) for c in subset for r in range(1, repeats + 1)]
        present = [(c, v) for c, v in records if v is not None]
        lat = [v['latency'] for _, v in present]
        def ids(predicate):
            return sorted({c['id'] for c, v in present if predicate(c, v)})
        consistency = {}
        for c in subset:
            vals = [seen.get((model, c['id'], r)) for r in range(1, repeats + 1)]
            observed = [v['timely_ban'] for v in vals if v is not None]
            consistency[c['id']] = {'timely_bans': sum(observed), 'observed': len(observed), 'scheduled': repeats,
                                     'flip': len(set(observed)) > 1}
        category_metrics = {}
        for category in sorted(CATEGORIES):
            eligible = [(c, v) for c, v in present if c.get('label_status') == 'synthetic_clear' and category in c['categories'] and v['scores'] is not None]
            if eligible:
                category_metrics[category] = {'eligible_attempts': len(eligible),
                    'predicted_positive_attempts': sum(v['scores'][category] >= .85 for c,v in eligible),
                    'expected_positive_attempts': sum(category in c['expected_categories'] for c,v in eligible),
                    'true_positive_attempts': sum(v['scores'][category] >= .85 and category in c['expected_categories'] for c,v in eligible),
                    'false_positive_attempts': sum(v['scores'][category] >= .85 and category not in c['expected_categories'] for c,v in eligible)}
        return {'positive_cases': sum(c['expected'] for c in subset), 'benign_cases': sum(not c['expected'] for c in subset), 'scheduled_attempts': len(records), 'scheduled_positive_attempts': repeats * sum(c['expected'] for c in subset), 'scheduled_benign_attempts': repeats * sum(not c['expected'] for c in subset), 'returned_attempts': len(present),
                'missing_attempts': len(records)-len(present), 'complete': len(records) == len(present),
                'timely_tp_attempts': sum(c['expected'] and v['timely_ban'] for c, v in present),
                'timely_fp_attempts': sum(not c['expected'] and v['timely_ban'] for c, v in present),
                'returned_fp_attempts': sum(not c['expected'] and v['returned_ban'] for c, v in present),
                'deadline_errors': sum(v['late'] for _, v in present),
                'response_errors': sum(v['verdict'] == 'error' for _, v in present),
                'uncertain_attempts': sum(v['verdict'] == 'uncertain' for _, v in present),
                'timely_tp_cases': ids(lambda c,v: c['expected'] and v['timely_ban']),
                'timely_fp_cases': ids(lambda c,v: not c['expected'] and v['timely_ban']),
                'returned_fp_cases': ids(lambda c,v: not c['expected'] and v['returned_ban']),
                'flipping_cases': sorted(cid for cid, v in consistency.items() if v['flip']),
                'case_consistency': consistency,
                'latency_ms': {'p50': percentile(lat,.5), 'p95': percentile(lat,.95), 'max': max(lat, default=None)},
                'known_returned_cost': sum(v['cost'] for _, v in present if v['cost'] is not None),
                'unknown_returned_cost_attempts': sum(v['cost'] is None for _, v in present),
                'byok_upstream_cost': 'unknown',
                'response_metadata_counts': {key: dict(Counter(v['metadata'][key] for _, v in present)) for key in ('source_model','resolved_model','provider')},
                'mechanism_diagnostics': {
                    'eligible_valid_responses': sum(v['scores'] is not None for _, v in present),
                    'unsafe_below_highest_category': sum(v['scores'] is not None and v['scores']['unsafe'] < max(v['scores'][k] for k in c['categories']) for c,v in present),
                    'high_category_safe_veto': sum(v['scores'] is not None and max(v['scores'][k] for k in c['categories']) >= .85 and 1-v['scores']['unsafe'] > max(v['scores'][k] for k in c['categories']) for c,v in present),
                    'note': 'Valid successful responses, including late responses; independent scores, not enforcement.',
                    'exploratory_category_scores_not_enforcement': category_metrics}}

    groups = {}
    for phase in sorted({p for _, p in items}):
        subset = [c for c,p in items if p == phase]
        summaries = {m: summary(subset,m) for m in models}
        paired = Counter()
        paired_ids = {'candidate_only_catches': set(), 'baseline_only_catches': set()}
        case_wins = {'candidate': [], 'baseline': [], 'ties': []}
        for c in subset:
            if not c['expected']:
                continue
            diffs = []
            for r in range(1,repeats+1):
                b, a = seen.get((baseline,c['id'],r)), seen.get((candidate,c['id'],r))
                if b is None or a is None:
                    continue
                paired['candidate_only_catches'] += a['timely_ban'] and not b['timely_ban']
                paired['baseline_only_catches'] += b['timely_ban'] and not a['timely_ban']
                if a['timely_ban'] and not b['timely_ban']:
                    paired_ids['candidate_only_catches'].add(c['id'])
                if b['timely_ban'] and not a['timely_ban']:
                    paired_ids['baseline_only_catches'].add(c['id'])
                diffs.append(int(a['timely_ban']) - int(b['timely_ban']))
            if len(diffs) == repeats:
                case_wins['candidate' if sum(diffs)>0 else 'baseline' if sum(diffs)<0 else 'ties'].append(c['id'])
        slices = {}
        for key in ('family','language','categories'):
            values = sorted({v for c in subset for v in (c.get(key, []) if key == 'categories' else [c.get(key, 'unspecified')])})
            slices[key] = {v: {m: summary([c for c in subset if v in c.get(key, [])] if key == 'categories' else [c for c in subset if c.get(key,'unspecified') == v],m) for m in models} for v in values}
        groups[phase] = {'models': summaries, 'paired_attempts': dict(paired), 'paired_affected_cases': {k: sorted(v) for k,v in paired_ids.items()}, 'paired_case_repeat_wins': case_wins, 'slices': slices}
    qualification = 'not_evaluated_holdout'
    if 'holdout' in groups:
        h = groups['holdout']['models']; b, a = h[baseline],h[candidate]
        if not a['complete'] or not b['complete']:
            qualification = 'incomplete'
        elif baseline != 'typesafe/jev-1.13':
            qualification = 'baseline_not_jev'
        elif a['timely_fp_cases'] or a['returned_fp_cases']:
            qualification = 'false_bans_observed'
        elif len(a['timely_tp_cases']) > len(b['timely_tp_cases']) and a['timely_tp_attempts'] > b['timely_tp_attempts']:
            qualification = 'synthetic_holdout_candidate'
        elif len(a['timely_tp_cases']) == len(b['timely_tp_cases']) and a['timely_tp_attempts'] == b['timely_tp_attempts']:
            qualification = 'tie'
        else:
            qualification = 'no_strict_improvement_or_regression'
    return {'notice': 'Synthetic labels; calibration is unproven. Zero observed false positives is insufficient proof of safety. This is not production approval.',
            'baseline': baseline, 'candidate': candidate, 'repeats': repeats, 'qualification': qualification, 'groups': groups}


def validate():
    for path, ref in [(ROOT/'legacy'/'provenance.json', ROOT/'legacy'), (ROOT/'manifest.json', ROOT)]:
        if not path.exists():
            if path.name == 'manifest.json':
                continue
            raise ValueError('missing legacy provenance')
        doc = load_json(path)
        for rel, expected in doc['files'].items():
            target = (ref / rel).resolve()
            if not target.is_relative_to(ref.resolve()) or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                raise ValueError(f'hash mismatch: {rel}')
        for rel, expected in doc.get('source_files', {}).items():
            repo = ROOT.parents[1]
            target = (repo / rel).resolve()
            if not target.is_relative_to(repo) or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                raise ValueError(f'source hash mismatch: {rel}')
    legacy = cases_for('legacy')
    expanded = cases_for('expanded')
    all_cases = legacy + expanded
    ids = set()
    payloads = {}
    known_duplicate = {'hard-injection-role', 'followup-role-original'}
    duplicate_legacy = []
    for c, phase in all_cases:
        if not isinstance(c, dict) or not isinstance(c.get('id'), str) or not c['id'] or c['id'] in ids:
            raise ValueError('missing or duplicate case ID')
        ids.add(c['id'])
        if not isinstance(c.get('message'), str) or not c['message'] or len(c['message']) > 500:
            raise ValueError(f"invalid message: {c['id']}")
        if type(c.get('expected')) is not bool or not isinstance(c.get('context'), list) or len(c['context']) > 7:
            raise ValueError(f"invalid label or context: {c['id']}")
        cats = c.get('categories')
        if not isinstance(cats, list) or not cats or len(cats) != len(set(cats)) or not set(cats) <= CATEGORIES:
            raise ValueError(f"invalid categories: {c['id']}")
        payload = canonical([c['message'], c['context'], cats])
        if payload in payloads:
            pair = {payloads[payload], c['id']}
            if pair != known_duplicate:
                raise ValueError(f"duplicate payload: {c['id']}")
            duplicate_legacy.append(sorted(pair))
        else:
            payloads[payload] = c['id']
        if phase in ('development','holdout','diagnostic'):
            for ctx in c['context']:
                if not isinstance(ctx, dict) or set(ctx) != {'messageID','username','message','timestamp','isBroadcaster'} or type(ctx['isBroadcaster']) is not bool or not all(isinstance(ctx[k], str) and len(ctx[k]) <= 500 for k in ('messageID','username','message')) or not ((isinstance(ctx['timestamp'], str) and len(ctx['timestamp']) <= 500) or numeric(ctx['timestamp'])):
                    raise ValueError(f"invalid context item: {c['id']}")
            expected_cats = c.get('expected_categories')
            if (not isinstance(expected_cats,list) or len(expected_cats)!=len(set(expected_cats)) or not set(expected_cats) <= set(cats) or bool(expected_cats) != c['expected'] or c.get('group') != 'expanded' or not isinstance(c.get('language'), str) or not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|mixed', c['language']) or not isinstance(c.get('family'),str) or not c['family'] or not isinstance(c.get('scenario_group'),str) or not c['scenario_group'] or not isinstance(c.get('tags'),list) or not all(isinstance(t,str) for t in c['tags']) or not isinstance(c.get('rationale'),str) or not c['rationale'] or c.get('label_status') != ('synthetic_ambiguous' if phase == 'diagnostic' else 'synthetic_clear') or (phase == 'diagnostic' and c['expected'])):
                raise ValueError(f"invalid expanded fields: {c['id']}")
        req = request(c, 'offline/contract-check')
        if req['model'] != 'offline/contract-check' or set(req['questions']) != set(cats) | {'unsafe'} or req['state']['output'] != {'role':'assistant','content':c['message']} or len(req['state']['input']) != len(c['context']):
            raise ValueError(f"invalid request contract: {c['id']}")
        for ctx, item in zip(c['context'], req['state']['input']):
            if item['role'] != 'user' or json.loads(item['content']) != ctx:
                raise ValueError(f"invalid context serialization: {c['id']}")
    if len(legacy) != 147 or len(expanded) != 264:
        raise ValueError('unexpected corpus sizes')
    distribution = Counter((p,c['expected']) for c,p in expanded)
    if distribution != {('development',True):60,('development',False):60,('holdout',True):60,('holdout',False):60,('diagnostic',False):24}:
        raise ValueError(f'unexpected expanded distribution: {distribution}')
    for field in ('family','scenario_group','message'):
        locations = defaultdict(set)
        for c, phase in expanded:
            locations[c[field]].add(phase)
        if any(len(v)>1 for v in locations.values()):
            raise ValueError(f'{field} crosses splits')
    if len({c['family'] for c,p in expanded if p != 'diagnostic'}) != 24:
        raise ValueError('expected 24 clear families')
    # Independent boundary checks guard the frozen parser contract.
    native = contract()
    for scores in ({'spam':.85,'unsafe':.15}, {'spam':.85,'unsafe':.16}, {'spam':.849,'unsafe':1}, {'spam':.2,'unsafe':.1}):
        raw = {'answers': {k:{'type':'noul','noul':v} for k,v in scores.items()}, 'usage':{'cost':0,'input_tokens':0}}
        if score(raw,['spam'])[0] != native.verdict(scores):
            raise ValueError('native verdict parity failure')
    return {'legacy_duplicate_payloads': duplicate_legacy, 'legacy_cases': len(legacy), 'expanded_cases':len(expanded), 'expanded_distribution': {f'{p}:{v}': n for (p,v),n in sorted(distribution.items())}, 'manifest_verified':(ROOT/'manifest.json').exists()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('validate')
    for name in ('export','evaluate'):
        p = sub.add_parser(name)
        p.add_argument('--suite', choices=('legacy','expanded'), required=True)
        p.add_argument('--split', choices=('primary','supplemental','development','holdout','diagnostic'))
        p.add_argument('--repeats', type=int)
        p.add_argument('--output', type=Path, required=(name == 'export'))
        if name == 'export':
            p.add_argument('--model', required=True)
        else:
            p.add_argument('--baseline', required=True)
            p.add_argument('--candidate', required=True)
            p.add_argument('input', type=Path)
    args = parser.parse_args()
    try:
        validation = validate()
        if args.command == 'validate':
            print(json.dumps(validation, indent=2, ensure_ascii=False))
            return
        repeats = args.repeats if args.repeats is not None else (2 if args.suite == 'legacy' else 3)
        if repeats < 1:
            raise ValueError('repeats must be positive')
        items = cases_for(args.suite, args.split)
        if args.command == 'export':
            with args.output.open('w', encoding='utf-8') as out:
                for row in export_rows(items, args.model, repeats):
                    out.write(json.dumps(row, ensure_ascii=False) + '\n')
        else:
            with args.input.open(encoding='utf-8') as f:
                rows = [json.loads(line) for line in f if line.strip()]
            result = json.dumps(evaluate(items, rows, args.baseline, args.candidate, repeats), indent=2, ensure_ascii=False) + '\n'
            if args.output:
                args.output.write_text(result, encoding='utf-8')
            else:
                print(result, end='')
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
