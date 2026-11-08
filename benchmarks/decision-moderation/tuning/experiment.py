#!/usr/bin/env python3
"""Frozen, resumable, model-specific decision prompt experiment (no retries)."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import sys
import threading
import time
import types
import uuid
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import suite as s
from run_openrouter import Client, append, get_key, read_lines, wire, write_json

MODELS = ['respan/span-01', 'typesafe/jev-1.13', 'openai/gpt-6-luna-decisions']
RULE = 'development: within each evaluation_group returned FP <= baseline, timely TP >= baseline, errors <= baseline; at least one strict overall TP/FP improvement; rank total returned FP ascending, timely TP descending, then variant order; baseline otherwise'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def module(path):
    spec = importlib.util.spec_from_file_location('tuning_contracts', path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


def task_key(row):
    return (row['model'], row['variant'], row['case'], row['repeat'])


def prepare(plan_path):
    plan_path = Path(plan_path).resolve()
    plan = load(plan_path)
    if plan.get('schema_version') != 1 or plan.get('models') != MODELS or plan.get('repeats') not in (2, 3):
        raise ValueError('plan must declare schema_version 1, the three authorized models in order, and repeats 2 or 3')
    if not isinstance(plan.get('phase'), str) or not plan['phase'] or type(plan.get('seed')) is not int:
        raise ValueError('phase and integer seed required')
    variants = plan.get('variants')
    if not isinstance(variants, dict) or not variants or 'baseline' not in variants or variants['baseline'] not in ('baseline', {'kind':'baseline'}):
        raise ValueError('variants must be an ordered mapping with baseline: baseline')
    if plan.get('selection_rule') != RULE:
        raise ValueError('plan must freeze the exact selection_rule')
    model_variants = plan.get('model_variants', {m:list(variants) for m in MODELS})
    if set(model_variants) != set(MODELS) or any(not isinstance(v,list) or not v or len(v)!=len(set(v)) or 'baseline' not in v or any(x not in variants for x in v) for v in model_variants.values()):
        raise ValueError('invalid model_variants')
    base = plan_path.parent
    resolve = lambda p: (base / p).resolve()
    files = {'plan': plan_path, 'cases': resolve(plan['cases_file']), 'contracts': resolve(plan['contracts_module']),
             'experiment': Path(__file__).resolve(), 'suite': ROOT/'suite.py', 'transport': ROOT/'run_openrouter.py', 'native_contract': ROOT/'legacy/native_contract.py', 'policy': ROOT/'legacy/policy.json'}
    contracts = {}
    for name, path in variants.items():
        if not isinstance(name, str) or not name: raise ValueError('invalid variant ID')
        if path == 'baseline' or path == {'kind':'baseline'}:
            if name != 'baseline': raise ValueError('baseline marker reserved')
            contracts[name] = {'kind':'baseline'}
        else:
            if isinstance(path, dict): contracts[name] = path
            else:
                files['variant:'+name] = resolve(path)
                contracts[name] = load(files['variant:'+name])
            if not isinstance(contracts[name], dict): raise ValueError('contract must be an object')
    cases = load(files['cases'])
    if not isinstance(cases, list) or not cases: raise ValueError('cases must be a nonempty list')
    ids = set()
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get('id'), str) or not case['id'] or case['id'] in ids:
            raise ValueError('invalid or duplicate case ID')
        ids.add(case['id'])
        if not isinstance(case.get('message'), str) or not isinstance(case.get('context'), list) or type(case.get('expected')) is not bool or not isinstance(case.get('categories'), list) or not case['categories'] or len(set(case['categories'])) != len(case['categories']) or not set(case['categories']) <= s.CATEGORIES:
            raise ValueError('invalid case '+case['id'])
    make = module(files['contracts']).request
    requests = []
    for model in MODELS:
        for variant in model_variants[model]:
            for case in cases:
                req = make(case, model, variant, contracts)
                if not isinstance(req, dict) or set(req) != {'model','questions','state'} or req['model'] != model or set(req['questions']) != set(case['categories']) | {'unsafe'}:
                    raise ValueError('invalid request shape')
                state = req['state']
                if state.get('output') != {'role':'assistant','content':case['message']} or len(state.get('input', [])) != len(case['context']): raise ValueError('message/context drift')
                for ctx, item in zip(case['context'], state['input']):
                    if item.get('role') != 'user' or json.loads(item['content']) != ctx: raise ValueError('context drift')
                requests.append({'model':model,'variant':variant,'case':case['id'],'body':req,'request_sha256':s.digest(req),'wire_sha256':s.digest(wire(req))})
    # Shuffle case/repeat blocks; rotate shuffled variants inside each block.
    rng = random.Random(plan['seed'])
    blocks = [(c['id'], r) for c in cases for r in range(1,plan['repeats']+1)]
    rng.shuffle(blocks)
    schedule = []
    for cid, repeat in blocks:
        order = list(variants); rng.shuffle(order)
        schedule.extend({'case':cid,'repeat':repeat,'variant':v} for v in order)
    meta = {'schema_version':1,'selection_rule':RULE,'phase':plan['phase'],'models':MODELS,'variants':list(variants),'model_variants':model_variants,'repeats':plan['repeats'],'seed':plan['seed'],
            'source_hashes':{k:sha(v) for k,v in files.items()},'cases_sha256':s.digest(cases),'contracts_sha256':s.digest(contracts),'requests_sha256':s.digest(requests),'schedule_sha256':s.digest(schedule),
            'start_spacing_seconds':0.2,'timeout_seconds':12,'deadline_ms_exclusive':4000,'transport_user':wire({})['user'],'headers':s.HEADERS,'no_automatic_retry':True}
    return plan, cases, contracts, requests, schedule, meta, files


def freeze(out, prepared):
    plan,cases,contracts,requests,schedule,meta,files = prepared
    out.mkdir(parents=True, exist_ok=True)
    meta_path = out/'meta.json'
    if meta_path.exists():
        if load(meta_path) != meta: raise ValueError('source/config hash drift')
    else:
        if any(p.name != '.lock' for p in out.iterdir()): raise ValueError('output directory not empty')
        snap = out/'sources'; snap.mkdir()
        for name,path in files.items(): shutil.copyfile(path, snap/(hashlib.sha256(name.encode()).hexdigest()+'.source'))
        for name,obj in [('plan.json',plan),('cases.json',cases),('contracts.json',contracts),('requests.json',requests),('schedule.json',schedule)]: write_json(out/name,obj)
        write_json(meta_path,meta)
    verify_snapshot(out)


def verify_snapshot(out):
    meta = load(out/'meta.json')
    for name,digest in meta['source_hashes'].items():
        if sha(out/'sources'/(hashlib.sha256(name.encode()).hexdigest()+'.source')) != digest: raise ValueError('snapshot source hash drift')
    for name,key in [('cases','cases_sha256'),('contracts','contracts_sha256'),('requests','requests_sha256'),('schedule','schedule_sha256')]:
        if s.digest(load(out/(name+'.json'))) != meta[key]: raise ValueError('snapshot '+name+' hash drift')
    # The plan snapshot has a byte-level source hash, and the parsed copy must agree.
    if load(out/'plan.json') != load(out/'sources'/(hashlib.sha256(b'plan').hexdigest()+'.source')): raise ValueError('plan snapshot drift')
    return meta


def verify_rows(out):
    meta=verify_snapshot(out); schedule=load(out/'schedule.json'); requests=load(out/'requests.json')
    reqs={(r['model'],r['variant'],r['case']):r for r in requests}
    planned={(m,t['variant'],t['case'],t['repeat']) for m in meta['models'] for t in schedule if t['variant'] in meta['model_variants'][m]}
    intents={}; tuples=set()
    for row in read_lines(out/'intents.jsonl'):
        key=task_key(row); request=reqs.get(key[:3]); attempt=row['attempt_id']
        if key not in planned or key in tuples or attempt in intents or request is None or row['request_sha256'] != request['request_sha256'] or row['wire_sha256'] != request['wire_sha256'] or s.digest(request['body']) != request['request_sha256'] or s.digest(wire(request['body'])) != request['wire_sha256']:
            raise ValueError('duplicate, unplanned, or hash-drifted intent')
        tuples.add(key); intents[attempt]=row
    rows={}; completed=set()
    for row in read_lines(out/'raw.jsonl'):
        attempt=row['attempt_id']; intent=intents.get(attempt); key=task_key(row)
        if intent is None or attempt in completed or key in rows or any(row.get(k) != v for k,v in intent.items()): raise ValueError('duplicate or unpaired outcome')
        latency=row.get('latency_ms'); status=row.get('http_status')
        if not s.numeric(latency) or latency < 0 or (status is not None and (type(status) is not int or not 100 <= status <= 599)):
            raise ValueError('invalid outcome latency or HTTP status')
        completed.add(attempt); rows[key]=row
    if set(intents) != completed: raise ValueError('unresolved in-flight intents; manual reconciliation required')
    return meta, reqs, rows


def costs(raw):
    returned=s.returned_cost(raw)
    usage=raw.get('usage',{}) if isinstance(raw,dict) else {}
    details=usage.get('cost_details',{}) if isinstance(usage,dict) else {}
    byok=usage.get('is_byok') is True if isinstance(usage,dict) else False
    value=details.get('upstream_inference_cost') if isinstance(details,dict) else None
    upstream=value if byok and s.numeric(value) and value >= 0 else None
    return returned, upstream, byok


class Experiment:
    def __init__(self,out,key,client_factory=Client):
        self.out,self.key,self.factory=Path(out),key,client_factory
        self.lock=threading.RLock(); self.stop=threading.Event(); self.next_start=0; self.failures=[]
        self.meta,self.reqs,self.rows=verify_rows(self.out)
        self.clients={m:client_factory(key) for m in self.meta['models']}
        self.alerted=(self.out/'spending-alert.json').exists()
        self.cases={c['id']:c for c in load(self.out/'cases.json')}
        self.schedule=load(self.out/'schedule.json')
        self.blocked_models={r['model'] for r in self.rows.values() if r.get('error')=='invalid_schema'}
        self.last_progress=time.monotonic(); self.progress_count=0

    def account(self,event):
        client=self.factory(self.key)
        try: response=client.call('GET','/api/v1/key')
        finally: client.close()
        data=response.get('raw'); data=data.get('data',{}) if isinstance(data,dict) else {}
        allow=('usage','usage_daily','usage_weekly','usage_monthly','byok_usage','byok_usage_daily','byok_usage_weekly','byok_usage_monthly','limit','limit_remaining','is_free_tier','is_provisioning_key')
        safe={k:v for k,v in data.items() if k in allow and (s.numeric(v) or type(v) is bool or v is None)} if isinstance(data,dict) else {}
        append(self.out/'account-snapshots.jsonl',{'event':event,'timestamp':time.time(),'http_status':response.get('http_status'),'error':response.get('error'),'data':safe})
        if response.get('http_status') in (401,402,403): self.stop.set()

    def progress(self, force=False):
        with self.lock:
            now=time.monotonic()
            if not force and self.progress_count < 20 and now-self.last_progress < 25: return
            self.progress_count=0; self.last_progress=now
            rows=list(self.rows.values()); vals=[costs(r.get('raw')) for r in rows]
            payload={'event':'progress','completed':len(rows),'total':sum(len(self.schedule) * len(v) // len(self.meta['variants']) for v in self.meta['model_variants'].values()), 'known_cost_usd':sum((a or 0)+(b or 0) for a,b,_ in vals),'unknown_returned_cost':sum(a is None for a,_,_ in vals),'unknown_byok_upstream_cost':sum(byok and b is None for _,b,byok in vals),'errors':sum(r.get('error') is not None or r.get('http_status') != 200 for r in rows),'timestamp':time.time()}
            append(self.out/'progress.jsonl',payload); print(json.dumps(payload),flush=True)
            if payload['known_cost_usd'] >= 1 and not self.alerted:
                alert={'event':'spending_alert','threshold_usd':1,'known_cost_usd':payload['known_cost_usd'],'action':'continue'}
                write_json(self.out/'spending-alert.json',alert); self.alerted=True; print(json.dumps(alert),flush=True)

    def worker(self,model):
        try:
            for task in self.schedule:
                key=(model,task['variant'],task['case'],task['repeat'])
                if self.stop.is_set() or model in self.blocked_models: break
                if task['variant'] not in self.meta['model_variants'][model]: continue
                with self.lock:
                    if key in self.rows: continue
                    delay=self.next_start-time.monotonic()
                    if delay>0: time.sleep(delay)
                    if self.stop.is_set(): break
                    request=self.reqs[key[:3]]
                    intent={'attempt_id':uuid.uuid4().hex,'model':model,**task,'request_sha256':request['request_sha256'],'wire_sha256':request['wire_sha256'],'started_at':time.time()}
                    append(self.out/'intents.jsonl',intent)
                    self.next_start=time.monotonic()+.2
                response=self.clients[model].call('POST','/api/alpha/decisions',wire(request['body']))
                if response.get('http_status') == 200 and not response.get('error') and s.score(response.get('raw'), self.cases[task['case']]['categories']) is None:
                    response['error']='invalid_schema'
                with self.lock:
                    row={**intent,**response}; append(self.out/'raw.jsonl',row); self.rows[key]=row
                    if response.get('http_status') in (401,402,403): self.stop.set()
                    if response.get('error') == 'invalid_schema': self.blocked_models.add(model)
                    self.progress_count += 1
                    self.progress()
        except Exception as exc:
            self.failures.append(repr(exc).replace(self.key, '[REDACTED]'));  self.stop.set()

    def run(self):
        self.account('start')
        def ticker():
            while not self.stop.wait(25): self.progress()
        timer=threading.Thread(target=ticker,daemon=True); timer.start()
        try:
            workers=[threading.Thread(target=self.worker,args=(m,)) for m in self.meta['models']]
            for t in workers: t.start()
            for t in workers: t.join()
        finally:
            self.stop.set(); timer.join()
            for client in self.clients.values(): client.close()
            self.progress(force=True); self.account('end')
        if self.failures: raise RuntimeError('; '.join(self.failures))


def analyze(out):
    out=Path(out); meta,_,rows=verify_rows(out); cases=load(out/'cases.json'); repeat=meta['repeats']
    suite_path=out/'sources'/(hashlib.sha256(b'suite').hexdigest()+'.source')
    frozen=types.ModuleType('frozen_suite'); frozen.__file__=str(suite_path)
    exec(compile(suite_path.read_bytes(),str(suite_path),'exec'), frozen.__dict__)
    def calc(subset,model,variant):
        present=[(c,rows[(model,variant,c['id'],r)]) for c in subset for r in range(1,repeat+1) if (model,variant,c['id'],r) in rows]
        counts=Counter(); ids={k:set() for k in ('returned_tp','returned_fp','timely_tp','timely_fp','returned_fn','timely_fn','errors','refusals')}; lat=[]; known=0; unknown=0; byok=0; byok_unknown=0; byok_status_unknown=0; failure_messages=Counter()
        for c,row in present:
            latency=row.get('latency_ms'); lat.extend([latency] if s.numeric(latency) else [])
            parsed=frozen.score(row.get('raw'),c['categories']); ok=row.get('http_status')==200 and not row.get('error') and parsed is not None
            raw=row.get('raw'); error_data=raw.get('error') if isinstance(raw,dict) else None
            message=error_data.get('message') if isinstance(error_data,dict) else None
            refusal=isinstance(raw,dict) and bool(raw.get('refusal') or raw.get('refused') or (isinstance(message,str) and 'refused to answer question' in message.lower()))
            if not ok:
                failure_messages[message if isinstance(message,str) and message else (row.get('error') or f"HTTP {row.get('http_status')}")] += 1
            if not ok: counts['errors']+=1; ids['errors'].add(c['id'])
            if refusal: counts['refusals']+=1; ids['refusals'].add(c['id'])
            if ok and parsed[0]=='violation':
                label='tp' if c['expected'] else 'fp'; counts['returned_'+label]+=1; ids['returned_'+label].add(c['id'])
                if s.numeric(latency) and latency < 4000: counts['timely_'+label]+=1; ids['timely_'+label].add(c['id'])
            if c['expected'] and (not ok or parsed[0]!='violation'):
                counts['returned_fn']+=1; ids['returned_fn'].add(c['id'])
            if c['expected'] and (not ok or parsed[0]!='violation' or not s.numeric(latency) or latency>=4000):
                counts['timely_fn']+=1; ids['timely_fn'].add(c['id'])
            usage=raw.get('usage') if isinstance(raw,dict) else None
            byok_status_unknown += not (isinstance(usage,dict) and type(usage.get('is_byok')) is bool)
            a,b,is_byok=costs(raw); known+=(a or 0)+(b or 0); unknown+=a is None; byok+=is_byok; byok_unknown+=is_byok and b is None
        return {'complete':len(present)==len(subset)*repeat,'observed':len(present),'scheduled':len(subset)*repeat,'positive_cases':sum(c['expected'] for c in subset),'benign_cases':sum(not c['expected'] for c in subset),'positive_attempts':sum(c['expected'] for c in subset)*repeat,'benign_attempts':sum(not c['expected'] for c in subset)*repeat,**{k:counts[k] for k in ids},'affected_cases':{k:sorted(v) for k,v in ids.items()},'latency_p95_ms':s.percentile(lat,.95),'known_cost_usd':known,'unknown_returned_cost_attempts':unknown,'byok_attempts':byok,'unknown_byok_upstream_attempts':byok_unknown,'unknown_byok_status_attempts':byok_status_unknown,'failure_message_counts':dict(failure_messages)}
    summaries={}; coverage={}; selections={}; paired={}
    for model in meta['models']:
        summaries[model]={}; coverage[model]={}; paired[model]={}
        for variant in meta['model_variants'][model]:
            overall=calc(cases,model,variant)
            splits={v:calc([c for c in cases if c.get('split','development')==v],model,variant) for v in sorted({c.get('split','development') for c in cases})}
            groups={v:calc([c for c in cases if c.get('evaluation_group','development')==v],model,variant) for v in sorted({c.get('evaluation_group','development') for c in cases})}
            families={v:calc([c for c in cases if c.get('family','unspecified')==v],model,variant) for v in sorted({c.get('family','unspecified') for c in cases})}
            summaries[model][variant]={'overall':overall,'splits':splits,'evaluation_groups':groups,'families':families}; coverage[model][variant]={'complete':overall['complete'],'observed':overall['observed'],'scheduled':overall['scheduled']}
            if variant != 'baseline':
                changes={k:[] for k in ('tp_fixes','tp_regressions','fp_fixes','fp_regressions')}
                for c in cases:
                    for r in range(1,repeat+1):
                        a=rows.get((model,'baseline',c['id'],r)); b=rows.get((model,variant,c['id'],r))
                        if a is None or b is None: continue
                        def ban(row,timely):
                            p=frozen.score(row.get('raw'),c['categories']); return row.get('http_status')==200 and not row.get('error') and p is not None and p[0]=='violation' and (not timely or (s.numeric(row.get('latency_ms')) and row['latency_ms']<4000))
                        old,new=ban(a,c['expected']),ban(b,c['expected'])
                        k=('tp_fixes' if new else 'tp_regressions') if c['expected'] else ('fp_regressions' if new else 'fp_fixes')
                        if old != new: changes[k].append({'case':c['id'],'repeat':r})
                paired[model][variant]=changes
        dev=[c for c in cases if c.get('split','development')=='development']
        base=calc(dev,model,'baseline'); eligible=[]
        groups=sorted({c.get('evaluation_group','development') for c in dev})
        if dev and base['complete']:
            for idx,variant in enumerate(meta['variants']):
                if variant=='baseline' or variant not in meta['model_variants'][model]: continue
                v=calc(dev,model,variant)
                strata_ok=True
                for group in groups:
                    subset=[c for c in dev if c.get('evaluation_group','development')==group]
                    bgroup=calc(subset,model,'baseline'); vgroup=calc(subset,model,variant)
                    if not vgroup['complete'] or vgroup['returned_fp']>bgroup['returned_fp'] or vgroup['timely_tp']<bgroup['timely_tp'] or vgroup['errors']>bgroup['errors']:
                        strata_ok=False
                if v['complete'] and strata_ok and (v['returned_fp']<base['returned_fp'] or v['timely_tp']>base['timely_tp']): eligible.append ( (v['returned_fp'],-v['timely_tp'],idx,variant))
        selections[model]=min(eligible)[3] if eligible else 'baseline'
    report={'selection_rule':RULE,'selection':selections,'models':summaries,'paired':paired,'note':'Repeated attempts are not independent cases; synthetic labels do not establish production safety.'}
    # Analysis is reproducible and may be regenerated after further progress.
    for name,obj in [('summary.json',report),('coverage.json',coverage)]:
        tmp=out/(name+'.tmp'); tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8'); os.replace(tmp,out/name)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='command',required=True)
    run=sub.add_parser('run'); run.add_argument('--plan',required=True); run.add_argument('--out',required=True); run.add_argument('--key-env-file',required=True)
    validate=sub.add_parser('validate'); validate.add_argument('--plan',required=True)
    ana=sub.add_parser('analyze'); ana.add_argument('--out',required=True)
    args=parser.parse_args()
    try:
        if args.command=='validate': print(json.dumps(prepare(args.plan)[5],indent=2)); return
        out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
        with (out/'.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if args.command=='run':
                prepared=prepare(args.plan); freeze(out,prepared); Experiment(out,get_key(args.key_env_file)).run()
            else: print(json.dumps(analyze(out)['selection'],ensure_ascii=False))
    except (ValueError,KeyError,TypeError,OSError,RuntimeError,AttributeError) as exc: parser.exit(2,'error: '+str(exc)+'\n')

if __name__=='__main__': main()
