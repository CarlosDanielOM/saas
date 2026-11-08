#!/usr/bin/env python3
"""Summarize a frozen synthetic Decisions benchmark from raw JSONL, offline only."""
import argparse
import hashlib
import importlib.util
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path


MODELS = ('respan/span-01', 'respan/span-02', 'typesafe/jev-1.13', 'typesafe/jev-1.14',
          'perplexity/pplx-decider-v1.2', 'liquid/d1.1', 'openai/gpt-6-luna-decisions')
BASELINE = 'typesafe/jev-1.13'
REPEATS = {'legacy': 2, 'expanded': 3, 'obfuscation': 3}
USER = 'decision-benchmark-2026-11-08'
NOTICE = ('Synthetic labels are not moderator ground truth. Repeats and obfuscation variants are not independent '
          'original scenarios. Zero observed false bans does not prove safety or authorize production use. '
          'Legacy labels include historical policy disagreements and are a separate regression reference.')


def sha_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def attempt_key(row):
    return (row.get('requested_model'), row.get('suite'), row.get('case'), row.get('round'))


def byok_usage(raw, s):
    usage = raw.get('usage') if isinstance(raw,dict) else None
    if not isinstance(usage,dict) or type(usage.get('is_byok')) is not bool:
        return 'unknown_status', None
    if not usage['is_byok']:
        return 'not_byok', None
    details = usage.get('cost_details')
    cost = details.get('upstream_inference_cost') if isinstance(details,dict) else None
    if not s.numeric(cost) or cost < 0:
        return 'unknown_cost', None
    return 'known', cost


def classify(row, case, s):
    """Match suite.score and strict deadline; preserve independent failure/latency signals."""
    raw, latency = row.get('raw'), row['latency_ms']
    parsed = s.score(raw, case['categories'])
    http = row.get('http_status')
    error = row.get('error')
    if type(http) is int and http != 200:
        failure = 'http_error'
    elif error and error != 'invalid_schema' and error != 'invalid_json':
        failure = 'transport_error'
    elif http != 200:
        failure = 'transport_error'
    elif error or parsed is None:
        failure = 'invalid_response'
    else:
        failure = None
    verdict = parsed[0] if failure is None else 'error'
    answers = raw.get('answers', {}) if isinstance(raw, dict) else {}
    def score_value(key):
        answer = answers.get(key)
        value = answer.get('noul') if isinstance(answer, dict) else answer
        return value if s.numeric(value) else (None if value is None else repr(value)[:120])
    scores = {k: score_value(k) for k in [*case['categories'], 'unsafe']} if isinstance(answers, dict) else {}
    metadata = {dest: (raw.get(src) if isinstance(raw, dict) and isinstance(raw.get(src), str) and raw.get(src) else '<missing>')
                for dest, src in [('provider', 'provider'), ('resolved_model', 'model'), ('source_model', 'source_model')]}
    byok_status, byok_cost = byok_usage(raw,s)
    return {'byok_status':byok_status, 'byok_cost':byok_cost, 'verdict': verdict, 'failure': failure, 'late': latency >= 4000,
            'timely_ban': failure is None and latency < 4000 and verdict == 'violation',
            'returned_ban': failure is None and verdict == 'violation', 'scores': scores,
            'cost': s.returned_cost(raw), 'metadata': metadata, 'latency_ms': latency}


def build_plan(s):
    cases = {}
    group_cases = defaultdict(list)
    for suite, repeats in REPEATS.items():
        for case, phase in s.cases_for(suite):
            key = (suite, case['id'])
            if key in cases:
                raise ValueError(f'duplicate case in {suite}: {case["id"]}')
            cases[key] = (case, phase)
            group_cases[(suite, phase)].append(case)
    grid = {(model, suite, case['id'], r)
            for model in MODELS for (suite, _), group in group_cases.items()
            for case in group for r in range(1, REPEATS[suite] + 1)}
    smoke = next(c for c, phase in s.cases_for('legacy') if phase == 'primary' and not c['expected'])
    return cases, group_cases, grid, smoke


def metrics(cases, observed, model, suite, s):
    repeats = REPEATS[suite]
    records = [(c, observed.get((model, suite, c['id'], r))) for c in cases for r in range(1, repeats + 1)]
    present = [(c, rec) for c, rec in records if rec is not None]
    latency = [rec['result']['latency_ms'] for _, rec in present]
    def ids(pred):
        return sorted({c['id'] for c, rec in present if pred(c, rec['result'])})
    tp = ids(lambda c, r: c['expected'] and r['timely_ban'])
    tfp = ids(lambda c, r: not c['expected'] and r['timely_ban'])
    rfp = ids(lambda c, r: not c['expected'] and r['returned_ban'])
    flips = []
    for c in cases:
        vals = [observed.get((model, suite, c['id'], r)) for r in range(1, repeats + 1)]
        vals = [v['result']['timely_ban'] for v in vals if v is not None]
        if len(set(vals)) > 1:
            flips.append(c['id'])
    costs = [r['result']['cost'] for _, r in present]
    pos = sum(c['expected'] for c in cases) * repeats
    neg = (len(cases) - sum(c['expected'] for c in cases)) * repeats
    counts = Counter(r['result']['failure'] for _, r in present if r['result']['failure'])
    result = {'cases': len(cases), 'scheduled_attempts': len(records), 'scheduled_positive_attempts': pos,
              'scheduled_benign_attempts': neg, 'observed_attempts': len(present), 'missing_attempts': len(records)-len(present),
              'timely_tp_attempts': sum(c['expected'] and r['result']['timely_ban'] for c, r in present),
              'returned_tp_attempts': sum(c['expected'] and r['result']['returned_ban'] for c, r in present),
              'timely_fp_attempts': sum(not c['expected'] and r['result']['timely_ban'] for c, r in present),
              'returned_fp_attempts': sum(not c['expected'] and r['result']['returned_ban'] for c, r in present),
              'timely_tp_case_ids': tp, 'timely_fp_case_ids': tfp, 'returned_fp_case_ids': rfp,
              'deadline_failures': sum(r['result']['late'] for _, r in present),
              'transport_errors': counts['transport_error'], 'http_errors': counts['http_error'],
              'invalid_responses': counts['invalid_response'],
              'valid_responses': sum(r['result']['failure'] is None for _, r in present),
              'uncertain_responses': sum(r['result']['verdict']=='uncertain' for _, r in present),
              'stable_flip_case_count': len(flips), 'flipping_case_ids': sorted(flips),
              'latency_ms': {'median': statistics.median(latency) if latency else None,
                             'p95': s.percentile(latency,.95), 'max': max(latency, default=None)},
              'openrouter_cost': {'known_sum_usd': math.fsum(c for c in costs if c is not None),
                                  'unknown_usage_cost_attempts': sum(c is None for c in costs)},
              'response_metadata_counts': {key: dict(Counter(r['result']['metadata'][key] for _,r in present))
                                           for key in ('provider','resolved_model','source_model')},
              'provider_error_messages': dict(Counter(
                  str(r['row']['raw']['error']['message']) for _,r in present
                  if isinstance(r['row'].get('raw'),dict)
                  and isinstance(r['row']['raw'].get('error'),dict)
                  and isinstance(r['row']['raw']['error'].get('message'),str)))}
    result['chart'] = {'returned_false_bans': result['returned_fp_attempts'], 'benign_attempts': neg,
                       'returned_false_ban_percent': 100*result['returned_fp_attempts']/neg if neg else None,
                       'timely_catches': result['timely_tp_attempts'], 'positive_attempts': pos,
                       'timely_recall_percent': 100*result['timely_tp_attempts']/pos if pos else None,
                       'incomplete': result['missing_attempts']>0}
    return result


def slices(cases, observed, model, suite, s):
    result = {}
    for key in ('language','family','categories','variant'):
        values = sorted({v for c in cases for v in (c.get(key, []) if key == 'categories' else [c.get(key, 'unspecified')])})
        result[key] = {}
        for v in values:
            subset = [c for c in cases if v in c.get(key, [])] if key == 'categories' else [c for c in cases if c.get(key, 'unspecified') == v]
            m = metrics(subset, observed, model, suite, s)
            result[key][v] = {k:m[k] for k in ('cases','scheduled_attempts','missing_attempts','timely_tp_attempts',
                                                 'returned_tp_attempts','timely_fp_attempts','returned_fp_attempts',
                                                 'latency_ms','transport_errors','http_errors','invalid_responses',
                                                 'valid_responses','deadline_failures','chart')}
    return result


def obfuscation_pairs(cases, observed, model):
    """Count repeated observations and distinct clean/obfuscated transformations separately."""
    clean = [c for c in cases if c.get('variant') == 'plain']
    twins = {c['clean_case_id']:c for c in cases if c.get('variant') == 'obfuscated'}
    counters = Counter()
    affected = defaultdict(set)
    for plain in clean:
        obfuscated = twins.get(plain['id'])
        if obfuscated is None:
            continue
        counters['scheduled_pairs'] += 1
        for r in range(1, REPEATS['obfuscation'] + 1):
            counters['scheduled_pair_attempts'] += 1
            left = observed.get((model,'obfuscation',plain['id'],r))
            right = observed.get((model,'obfuscation',obfuscated['id'],r))
            if left is None or right is None:
                continue
            counters['observed_pair_attempts'] += 1
            l, rr = left['result'], right['result']
            events = {}
            if plain['expected']:
                events = {'positive_plain_caught':l['timely_ban'], 'positive_obfuscated_caught':rr['timely_ban'],
                          'positive_plain_caught_obfuscated_missed':l['timely_ban'] and not rr['timely_ban'],
                          'positive_obfuscated_caught_plain_missed':rr['timely_ban'] and not l['timely_ban']}
            else:
                events = {'benign_plain_timely_false_ban':l['timely_ban'], 'benign_obfuscated_timely_false_ban':rr['timely_ban'],
                          'benign_plain_returned_false_ban':l['returned_ban'], 'benign_obfuscated_returned_false_ban':rr['returned_ban']}
            for event, yes in events.items():
                if yes:
                    counters[event+'_attempts'] += 1
                    affected[event].add(plain['id'])
    event_names = ('positive_plain_caught','positive_obfuscated_caught','positive_plain_caught_obfuscated_missed',
                   'positive_obfuscated_caught_plain_missed','benign_plain_timely_false_ban',
                   'benign_obfuscated_timely_false_ban','benign_plain_returned_false_ban','benign_obfuscated_returned_false_ban')
    return {'scheduled_pairs':counters['scheduled_pairs'], 'scheduled_pair_attempts':counters['scheduled_pair_attempts'],
            'observed_pair_attempts':counters['observed_pair_attempts'],
            'attempt_counts':{k:counters[k+'_attempts'] for k in event_names},
            'distinct_transformation_pair_counts':{k:len(affected[k]) for k in event_names},
            'affected_clean_case_ids':{k:sorted(affected[k]) for k in event_names},
            'note':'A clean case ID identifies one transformation pair; repeated rounds are not independent scenarios.'}


def failure_cases(cases, observed, grid):
    results = []
    for model, suite, cid in sorted({(m, su, c) for m,su,c,_ in grid}):
        case, phase = cases[(suite,cid)]
        affected = []
        for r in range(1, REPEATS[suite]+1):
            item = observed.get((model,suite,cid,r))
            if item is None:
                affected.append({'round':r, 'attempt_id':None, 'reason':['missing_attempt']})
                continue
            data, row = item['result'], item['row']
            reasons = []
            if not case['expected'] and data['returned_ban']:
                reasons.append('returned_false_positive')
            if case['expected'] and not data['timely_ban']:
                reasons.append('missed_timely_positive')
            if data['failure']:
                reasons.append(data['failure'])
            if data['late']:
                reasons.append('deadline')
            if reasons:
                affected.append({'round':r,'attempt_id':row.get('attempt_id'),'reason':reasons,
                                 'scores':data['scores'],'verdict':data['verdict'],'timely_ban':data['timely_ban'],
                                 'returned_ban':data['returned_ban'],'latency_ms':data['latency_ms'],
                                 'http_status':row.get('http_status'),'error':row.get('error')})
                raw = row.get('raw')
                if isinstance(raw,dict) and isinstance(raw.get('error'),dict):
                    affected[-1]['provider_error'] = raw['error']
        if affected:
            results.append({'requested_model':model,'suite':suite,'phase':phase,'case':cid,
                            'message':case['message'],'context':case['context'],'categories':case['categories'],
                            'expected':case['expected'],'expected_categories':case.get('expected_categories'),
                            'family':case.get('family'),'language':case.get('language'),
                            'variant':case.get('variant'),'affected_attempts':affected})
    return {'notice': NOTICE, 'cases': results}


def paired_comparisons(cases, observed, s):
    out = {}
    for suite in ('expanded','obfuscation'):
        items = [(case,phase) for (su,_),(case,phase) in cases.items() if su==suite and phase=='holdout']
        comparisons = {}
        for model in MODELS:
            if model == BASELINE:
                continue
            rows = [v['row'] for (m,su,_,_),v in observed.items() if su==suite and m in (BASELINE,model) and v['row']['phase']=='holdout']
            report = s.evaluate(items, rows, BASELINE, model, REPEATS[suite])
            group = report['groups']['holdout']
            comparisons[model] = {'qualification':report['qualification'],'qualification_basis':report['qualification_basis'],
                                  'paired_attempts':group['paired_attempts'],'paired_affected_cases':group['paired_affected_cases'],
                                  'paired_obfuscation_diagnostics':group['paired_obfuscation_diagnostics']}
        out[suite] = comparisons
    return out


class FreezeError(ValueError):
    """The run snapshot failed integrity checks and must not be executed."""


def load_frozen_suite(run_dir):
    """Check manifest and every listed file before importing any snapshot code."""
    snapshot = Path(run_dir) / 'frozen-inputs'
    try:
        meta = json.loads((Path(run_dir)/'run-meta.json').read_text(encoding='utf-8'))
        manifest_path = snapshot/'manifest.json'
        actual = sha_file(manifest_path)
        if meta.get('manifest_sha256') != actual:
            raise FreezeError('snapshot manifest hash does not match run metadata')
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        files = manifest.get('files')
        required = {'suite.py','legacy/cases.json','legacy/supplemental-cases.json','legacy/policy.json',
                    'legacy/native_contract.py','legacy/provenance.json','scenarios.json','obfuscation.json'}
        if not isinstance(files,dict) or not required <= set(files):
            raise FreezeError('snapshot manifest missing required frozen inputs')
        for rel, expected in files.items():
            if not isinstance(rel,str) or not isinstance(expected,str):
                raise FreezeError('invalid manifest file entry')
            target = (snapshot/rel).resolve()
            if not target.is_relative_to(snapshot.resolve()) or not target.is_file() or sha_file(target) != expected:
                raise FreezeError(f'frozen input missing or mismatched: {rel}')
        spec = importlib.util.spec_from_file_location('decision_benchmark_frozen_suite', snapshot/'suite.py')
        if spec is None or spec.loader is None:
            raise FreezeError('cannot load verified frozen suite')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, meta, actual
    except FreezeError:
        raise
    except (OSError,ValueError,TypeError,KeyError,json.JSONDecodeError) as exc:
        raise FreezeError(f'cannot verify run snapshot: {exc}') from exc


def analyze(run_dir):
    run_dir = Path(run_dir)
    frozen, meta, manifest_hash = load_frozen_suite(run_dir)
    return analyze_verified(run_dir, frozen, meta, manifest_hash)


def analyze_verified(run_dir, s, meta, manifest_hash):
    """Analyze using a previously hash-verified run-local suite, never workspace fixtures."""
    run_dir = Path(run_dir)
    issues = []
    cases, groups, grid, smoke = build_plan(s)
    expected_distribution = {('legacy','primary',True):55,('legacy','primary',False):80,
                             ('legacy','supplemental',True):6,('legacy','supplemental',False):6,
                             ('expanded','development',True):60,('expanded','development',False):60,
                             ('expanded','holdout',True):60,('expanded','holdout',False):60,
                             ('expanded','diagnostic',False):24,
                             ('obfuscation','development',True):24,('obfuscation','development',False):24,
                             ('obfuscation','holdout',True):24,('obfuscation','holdout',False):24}
    actual_distribution = Counter((su,phase,c['expected']) for (su,_),(c,phase) in cases.items())
    if actual_distribution != expected_distribution or len(grid) != 9618:
        raise FreezeError('verified frozen inputs do not match the fixed benchmark distribution')
    s.validate_obfuscation_pairs([c for (su,_),(c,_) in cases.items() if su=='obfuscation'])
    validation = {'manifest_verified':True,'dataset_distribution_verified':True,
                  'source_files':'Original workspace source hashes are historical references; this analysis uses the run snapshot.'}
    schedule = []
    try:
        schedule = s.load_json(run_dir/'schedule.json')
        expected_schedule = {(su,cid,phase,r) for (su,cid),(case,phase) in cases.items() for r in range(1,REPEATS[su]+1)}
        actual_schedule = [(x['suite'],x['case'],x['phase'],x['round']) for x in schedule]
        if (len(actual_schedule) != len(expected_schedule) or set(actual_schedule) != expected_schedule
                or meta.get('schedule_sha256') != s.digest(schedule)):
            issues.append('schedule is incomplete, duplicated, unknown, or hash mismatched')
        if (meta.get('schema_version') != 2 or meta.get('models') != list(MODELS)
                or meta.get('repeats') != REPEATS or meta.get('transport_user') != USER
                or meta.get('grid_attempts_per_model') != len(expected_schedule)):
            issues.append('run metadata does not match the fixed seven-model plan')
    except (OSError, ValueError, TypeError, KeyError) as exc:
        issues.append(f'run metadata or schedule unavailable/invalid: {exc}')
    observed, smoke_rows, ids = {}, {}, set()
    row_issues = []
    try:
        with (run_dir/'raw.jsonl').open(encoding='utf-8') as stream:
            for lineno, line in enumerate(stream,1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict):
                        raise ValueError('row is not an object')
                    model, suite, cid, rnd = attempt_key(row)
                    aid = row.get('attempt_id')
                    if not isinstance(aid,str) or not aid or aid in ids:
                        raise ValueError('missing or duplicate attempt_id')
                    ids.add(aid)
                    if suite == 'smoke':
                        if model not in MODELS or cid != smoke['id'] or rnd != 1 or row.get('phase') != 'smoke' or model in smoke_rows:
                            raise ValueError('unplanned or duplicate smoke attempt')
                        case, phase = smoke, 'smoke'
                    else:
                        key = (model,suite,cid,rnd)
                        if key not in grid or key in observed:
                            raise ValueError('unknown, duplicate, or unplanned main attempt')
                        case, phase = cases[(suite,cid)]
                        if row.get('phase') != phase:
                            raise ValueError('phase mismatch')
                    if type(rnd) is not int or not s.numeric(row.get('latency_ms')) or row['latency_ms'] < 0:
                        raise ValueError('invalid round or latency')
                    req = s.request(case,model)
                    if row.get('request_sha256') != s.digest(req):
                        raise ValueError('request hash mismatch')
                    wire_hash = row.get('wire_request_sha256')
                    if wire_hash is not None and wire_hash != s.digest({**req,'user':USER}):
                        raise ValueError('wire request hash mismatch')
                    rec = {'row':row,'result':classify(row,case,s)}
                    if suite == 'smoke':
                        smoke_rows[model] = rec
                    else:
                        observed[key] = rec
                except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
                    row_issues.append({'line':lineno,'error':str(exc)})
    except OSError as exc:
        issues.append(f'raw results unavailable: {exc}')
    if row_issues:
        issues.append(f'{len(row_issues)} raw rows rejected; see coverage.json')
    missing = sorted(grid-set(observed))
    smoke_missing = sorted(set(MODELS)-set(smoke_rows))
    complete = not issues and not missing and not smoke_missing
    counts = {}
    for model in MODELS:
        counts[model] = {}
        for (suite,phase), subset in sorted(groups.items()):
            expected_keys = {(model,suite,c['id'],r) for c in subset for r in range(1,REPEATS[suite]+1)}
            counts[model][f'{suite}/{phase}'] = {'planned':len(expected_keys),'observed':len(expected_keys & set(observed)),
                                                'missing':len(expected_keys-set(observed))}
    coverage = {'status':'COMPLETE' if complete else 'INCOMPLETE','issues':issues,'rejected_rows':row_issues,
                'planned_main_attempts':len(grid),'observed_main_attempts':len(observed),'missing_main_attempts':len(missing),
                'missing_main_keys':[{'model':m,'suite':su,'case':cid,'round':rnd} for m,su,cid,rnd in missing],
                'planned_smoke_attempts':len(MODELS),'observed_smoke_attempts':len(smoke_rows),'missing_smoke_models':smoke_missing,
                'groups':counts,'frozen_validation':validation}
    model_groups = {}
    for model in MODELS:
        model_groups[model] = {}
        for (suite,phase), subset in sorted(groups.items()):
            model_groups[model][f'{suite}/{phase}'] = {'metrics':metrics(subset,observed,model,suite,s),
                                                        'slices':slices(subset,observed,model,suite,s)}
            if suite == 'obfuscation':
                model_groups[model][f'{suite}/{phase}']['transformation_pairs'] = obfuscation_pairs(subset,observed,model)
    comparisons = paired_comparisons(cases,observed,s)
    if issues:
        for group in comparisons.values():
            for comparison in group.values():
                comparison['qualification'] = 'incomplete'
                comparison['qualification_blocked_by'] = 'run integrity or metadata error'
    # The ledger is computed once over unique accepted attempts, not over comparisons or slices.
    accepted = [v for v in observed.values()] + [v for v in smoke_rows.values()]
    costs = [v['result']['cost'] for v in accepted]
    byok_costs = [v['result']['byok_cost'] for v in accepted if v['result']['byok_status']=='known']
    unknown_byok = sum(v['result']['byok_status']=='unknown_cost' for v in accepted)
    unknown_status = sum(v['result']['byok_status']=='unknown_status' for v in accepted)
    known_or = math.fsum(c for c in costs if c is not None)
    known_byok = math.fsum(byok_costs)
    cost_report = {'known_returned_sum_usd':known_or,
                   'known_byok_upstream_sum_usd':known_byok,
                   'combined_known_or_and_byok_estimate_usd':known_or+known_byok,
                   'unknown_usage_cost_attempts':sum(c is None for c in costs),
                   'known_byok_attempts':len(byok_costs),
                   'unknown_byok_cost_attempts':unknown_byok,
                   'unknown_byok_status_attempts':unknown_status,
                   'observed_attempts_including_smoke':len(accepted),
                   'planned_attempts_including_smoke':len(grid)+len(MODELS),
                   'total_known_only':not complete or bool(row_issues) or any(c is None for c in costs) or bool(unknown_byok or unknown_status),
                   'byok_note':'BYOK upstream inference cost is added only when usage.is_byok is true; non-BYOK upstream cost is already included in returned OpenRouter cost. A shared account ledger may include unrelated usage.'}
    provenance = {'manifest_sha256':manifest_hash,
                  'run_frozen_manifest':str(run_dir/'frozen-inputs'/'manifest.json'),
                  'source_dataset_sha256':{rel:sha_file(run_dir/'frozen-inputs'/rel) for rel in ('legacy/cases.json','legacy/supplemental-cases.json','scenarios.json','obfuscation.json','legacy/policy.json','legacy/native_contract.py')},
                  'prompt_contract':'Frozen legacy/native_contract.py and legacy/policy.json; no prompt changes in this analysis.',
                  'transport_user':USER,'run_meta':str(run_dir/'run-meta.json'),'schedule':str(run_dir/'schedule.json')}
    summary = {'status':coverage['status'],'notice':NOTICE,'deadline_ms_strictly_less_than':4000,
               'provenance':provenance,'openrouter_and_byok_cost':cost_report,'models':model_groups,
               'qualifications_vs_jev_separate_holdouts':comparisons,
               'notes':['Legacy primary and supplemental are reported separately; historical labels are not used for qualification.',
                        'Returned false positives include valid responses at or after 4000 ms; timely enforcement does not.',
                        'Deadline and response failure counts may overlap; error and late requests fail open.',
                        'Response timing measures HTTP request to full response, not production queue and action time.']}
    failures = failure_cases(cases,observed,grid)
    return summary, failures, coverage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir',type=Path,required=True)
    args = parser.parse_args()
    try:
        summary, failures, coverage = analyze(args.run_dir)
        for name, data in [('summary.json',summary),('case-failures.json',failures),('coverage.json',coverage)]:
            (args.run_dir/name).write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
        print(json.dumps({'status':coverage['status'],'observed_main':coverage['observed_main_attempts'],
                          'planned_main':coverage['planned_main_attempts'],'outputs':['summary.json','case-failures.json','coverage.json']}))
        return 0 if coverage['status']=='COMPLETE' else 1
    except FreezeError as exc:
        coverage = {'status':'INCOMPLETE','issues':[str(exc)],'frozen_snapshot_valid':False}
        args.run_dir.mkdir(parents=True,exist_ok=True)
        for filename in ('coverage.json','summary.json','case-failures.json'):
            (args.run_dir/filename).write_text(json.dumps(coverage,indent=2)+'\n',encoding='utf-8')
        print(f'INCOMPLETE: {exc}',file=__import__('sys').stderr)
        return 1
    except (ValueError,KeyError,TypeError,OSError,json.JSONDecodeError) as exc:
        print(f'error: {exc}',file=__import__('sys').stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
