#!/usr/bin/env python3
"""Bounded OpenRouter benchmark. Run --smoke-only first, inspect it, then resume without that flag.

Writes append-only intents and outcomes. An unresolved intent requires manual reconciliation;
this program never automatically retries it. Request hashes exclude the transport-only user;
wire hashes include it. The $1 alert is informational, not a stop condition.
"""
import argparse
import fcntl
import hashlib
import http.client
import importlib.util
import shutil
import json
import os
from pathlib import Path
import random
import sys
import threading
import time
import uuid

import suite as s

MODELS = ('respan/span-01','respan/span-02','typesafe/jev-1.13','typesafe/jev-1.14',
          'perplexity/pplx-decider-v1.2','liquid/d1.1','openai/gpt-6-luna-decisions')
FAMILIES = (MODELS[0:2], MODELS[2:4], MODELS[4:5], MODELS[5:6], MODELS[6:7])
REPEATS = {'legacy':2, 'expanded':3, 'obfuscation':3}
USER = 'decision-benchmark-2026-11-08'
HOST = 'openrouter.ai'


def write_json(path, obj):
    data = (json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)+'\n').encode()
    with path.open('xb') as f:
        f.write(data); f.flush(); os.fsync(f.fileno())


def append(path, obj):
    data=(json.dumps(obj, ensure_ascii=False, separators=(',',':'))+'\n').encode('utf-8')
    with path.open('ab+') as f:
        f.seek(0,os.SEEK_END); offset=f.tell()
        f.write(data); f.flush(); os.fsync(f.fileno())
        f.seek(offset)
        if f.read(len(data)) != data: raise OSError('append readback mismatch')


def read_lines(path):
    if not path.exists(): return []
    with path.open(encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def wire(request):
    return {**request, 'user': USER}


def key_for(row):
    return (row['suite'],row['case'],row['requested_model'],row['round'])


def get_key(env_file=None):
    if env_file:
        found = []
        for line in Path(env_file).read_text(encoding='utf-8').splitlines():
            name, separator, value = line.strip().removeprefix('export ').partition('=')
            if separator and name.strip() == 'OPENROUTER_API_KEY':
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                found.append(value)
        if len(found) != 1: raise ValueError('key file must contain exactly one OPENROUTER_API_KEY line')
        key = found[0]
    else:
        key = os.environ.get('OPENROUTER_API_KEY', '')
    if not key or '\n' in key or '\r' in key: raise ValueError('missing or invalid API key')
    return key


def redact(obj, key):
    if isinstance(obj, str): return obj.replace(key, '[REDACTED]')
    if isinstance(obj, list): return [redact(v,key) for v in obj]
    if isinstance(obj, dict): return {redact(str(k),key):redact(v,key) for k,v in obj.items()}
    return obj


class Client:
    def __init__(self, key, connection_factory=None):
        self.key = key
        self.factory = connection_factory or (lambda: http.client.HTTPSConnection(HOST, timeout=12))
        self.connection = None

    def close(self):
        if self.connection:
            self.connection.close(); self.connection = None

    def call(self, method, path, body=None):
        start = time.monotonic()
        try:
            if self.connection is None: self.connection = self.factory()
            headers = {**s.HEADERS, 'Authorization':'Bearer '+self.key}
            data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(',',':')).encode('utf-8')
            self.connection.request(method,path,body=data,headers=headers)
            response = self.connection.getresponse()
            payload = response.read()
            try: raw = json.loads(payload.decode('utf-8'))
            except (UnicodeDecodeError,ValueError): raw = None
            return {'http_status':response.status, 'raw':redact(raw,self.key),
                    'latency_ms':(time.monotonic()-start)*1000, 'error': None if raw is not None else 'invalid_json'}
        except (OSError, http.client.HTTPException, TimeoutError):
            self.close()
            return {'http_status':None,'raw':None,'latency_ms':(time.monotonic()-start)*1000,'error':'transport_error'}


def build_schedule(seed):
    all_items = []
    for name, repeats in REPEATS.items():
        for case, phase in s.cases_for(name):
            for rnd in range(1,repeats+1):
                all_items.append({'suite':name,'case':case['id'],'phase':phase,'round':rnd})
    if len(all_items) != 1374: raise ValueError('unexpected planned grid size')
    random.Random(seed).shuffle(all_items)
    return all_items


def round_robin(family, schedule):
    for task in schedule:
        for model in family:
            yield model, task


class Run:
    def __init__(self, directory, key, seed, client_factory=Client):
        self.directory, self.key, self.seed = Path(directory), key, seed
        self.client_factory = client_factory
        self.lock = threading.RLock()
        self.abort = threading.Event()
        self.next_start = 0.0
        self.last_progress = time.monotonic()
        self.last_snapshot = time.monotonic()
        self.rows = {}
        self.blocked_models = set()
        self.alerted = False
        self.cases = {name:{c['id']:c for c,_ in s.cases_for(name)} for name in REPEATS}
        self.schedule = build_schedule(seed)
        self.clients = {model:client_factory(key) for model in MODELS}
        self.finished_since_progress = 0
        self.thread_errors = []
        self.snapshot_suite = None
        self.requests = {}
        self.account_start = None
        self.returned_total = 0.0

    def config(self):
        manifest = (s.ROOT/'manifest.json').read_bytes()
        return {'schema_version':2,'models':list(MODELS),'repeats':REPEATS,'seed':self.seed,
                'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'global_start_spacing_s':.2,'provider_families':[list(f) for f in FAMILIES],
                'read_timeout_s':12,'operational_deadline_ms':4000,'headers':s.HEADERS,
                'manifest_sha256':hashlib.sha256(manifest).hexdigest(), 'schedule_sha256':s.digest(self.schedule),
                'transport_user':USER,'request_hash':'sha256 of sorted ensure_ascii=False JSON, excluding user',
                'wire_request_hash':'sha256 of sorted ensure_ascii=False JSON, including user',
                'cost_note':'returned usage cost only; BYOK upstream cost unknown', 'soft_alert_usd':1,
                'grid_attempts_per_model':len(self.schedule), 'no_automatic_retry':True}

    def initialize(self):
        self.directory.mkdir(parents=True,exist_ok=True)
        config, schedule = self.directory/'run-meta.json', self.directory/'schedule.json'
        desired = self.config()
        if config.exists():
            if s.load_json(config) != desired or not schedule.exists() or s.load_json(schedule) != self.schedule:
                raise ValueError('run config, frozen manifest, or schedule changed')
        else:
            allowed={'preflight-key.json','preflight-credits.json','production-source','live-contract-verification.json'}
            if any(p.name not in allowed for p in self.directory.iterdir()): raise ValueError('new output directory contains unexpected files')
            snapshot=self.directory/'frozen-inputs'
            snapshot.mkdir()
            manifest=s.load_json(s.ROOT/'manifest.json')
            for rel in manifest['files']:
                source=(s.ROOT/rel).resolve()
                if not source.is_relative_to(s.ROOT.resolve()): raise ValueError('invalid manifest path')
                target=snapshot/rel; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,target)
            shutil.copyfile(s.ROOT/'manifest.json',snapshot/'manifest.json')
            shutil.copyfile(Path(__file__),self.directory/'runner-source.py')
            write_json(schedule,self.schedule); write_json(config,desired)
        snapshot=self.directory/'frozen-inputs'
        if hashlib.sha256((snapshot/'manifest.json').read_bytes()).hexdigest() != desired['manifest_sha256']:
            raise ValueError('snapshot manifest changed')
        for rel, expected_hash in s.load_json(snapshot/'manifest.json')['files'].items():
            target=(snapshot/rel).resolve()
            if not target.is_relative_to(snapshot.resolve()) or hashlib.sha256(target.read_bytes()).hexdigest() != expected_hash:
                raise ValueError('snapshot input hash mismatch: '+rel)
        spec=importlib.util.spec_from_file_location('frozen_suite',snapshot/'suite.py')
        self.snapshot_suite=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.snapshot_suite)
        self.cases={name:{c['id']:c for c,_ in self.snapshot_suite.cases_for(name)} for name in REPEATS}
        self.requests={(name,cid,model):self.snapshot_suite.request(case,model) for name, cases in self.cases.items() for cid,case in cases.items() for model in MODELS}
        intents = read_lines(self.directory/'intents.jsonl')
        rows = read_lines(self.directory/'raw.jsonl')
        intent_by_id = {}
        planned={(t['suite'],t['case'],model,t['round']):t['phase'] for t in self.schedule for model in MODELS}
        smoke=self.smoke_tasks()[0]
        planned.update({('smoke',smoke['case'],model,1):'smoke' for model in MODELS})
        intent_keys=set()
        for intent in intents:
            k=key_for(intent)
            if intent['attempt_id'] in intent_by_id or k in intent_keys or k not in planned or intent['phase'] != planned[k]: raise ValueError('duplicate or unplanned intent')
            intent_keys.add(k); intent_by_id[intent['attempt_id']] = intent
        completed_ids = set()
        for row in rows:
            attempt = row['attempt_id']; k = key_for(row)
            if attempt in completed_ids or attempt not in intent_by_id or k in self.rows:
                raise ValueError('duplicate or unpaired outcome')
            intent = intent_by_id[attempt]
            if key_for(intent) != k or intent['phase'] != row.get('phase') or intent['request_sha256'] != row['request_sha256'] or intent['wire_request_sha256'] != row['wire_request_sha256']:
                raise ValueError('intent/outcome mismatch')
            expected = self.make_request(k[0], k[1], k[2])
            if row['request_sha256'] != s.digest(expected) or row['wire_request_sha256'] != s.digest(wire(expected)):
                raise ValueError('saved request hash mismatch')
            completed_ids.add(attempt); self.rows[k] = row
        unresolved = [i['attempt_id'] for i in intents if i['attempt_id'] not in completed_ids]
        if unresolved: raise ValueError('unresolved in-flight intents: '+','.join(unresolved))
        self.alerted = (self.directory/'spending-alert.json').exists()
        self.returned_total = sum(v for r in rows if (v:=s.returned_cost(r.get('raw'))) is not None)
        if self.returned_total >= 1 and not self.alerted:
            self.spending_alert({'returned_cost_usd':self.returned_total})
        for row in rows:
            if row['suite'] != 'smoke' and row.get('http_status') == 200 and row.get('error') == 'invalid_schema':
                self.blocked_models.add(row['requested_model'])

    def make_request(self, suite, cid, model):
        if model not in MODELS: raise ValueError('unknown model')
        if suite == 'smoke': suite = 'legacy'
        if suite not in self.cases or cid not in self.cases[suite]: raise ValueError('unknown case')
        return self.requests[(suite,cid,model)]

    def gate(self):
        with self.lock:
            delay = self.next_start-time.monotonic()
            if delay > 0: time.sleep(delay)
            self.next_start = time.monotonic()+.2

    def progress(self, force=False):
        with self.lock:
            now=time.monotonic()
            if not force and self.finished_since_progress < 20 and now-self.last_progress < 30: return
            rows = list(self.rows.values()); measured = [s.returned_cost(r.get('raw')) for r in rows]
            print(json.dumps({'event':'progress','completed':sum(r['suite'] != 'smoke' for r in rows),
                  'total':len(self.schedule)*len(MODELS), 'model_counts':{m:sum(r['requested_model']==m and r['suite']!='smoke' for r in rows) for m in MODELS},
                  'returned_cost_usd':sum(v for v in measured if v is not None), 'unknown_cost':sum(v is None for v in measured),
                  'errors':sum(bool(r.get('error')) or r.get('http_status') != 200 for r in rows),
                  'http_429':sum(r.get('http_status') == 429 for r in rows),
                  'http_5xx':sum(type(r.get('http_status')) is int and 500 <= r['http_status'] < 600 for r in rows)}),flush=True)
            self.last_progress=now; self.finished_since_progress=0

    def snapshot(self, name):
        # Store only documented numeric account usage/limit fields; never persist authentication metadata.
        client=self.client_factory(self.key)
        try: response=client.call('GET','/api/v1/key')
        finally: client.close()
        data=response.get('raw'); data=data.get('data',{}) if isinstance(data,dict) else {}
        safe={k:v for k,v in data.items() if k in ('usage','usage_daily','usage_weekly','usage_monthly','byok_usage','byok_usage_daily','byok_usage_weekly','byok_usage_monthly','limit','limit_remaining','is_free_tier','is_provisioning_key') and (s.numeric(v) or type(v) is bool or v is None)} if isinstance(data,dict) else {}
        record={'event':name,'timestamp':time.time(),'http_status':response.get('http_status'),'data':safe,'error':response.get('error')}
        with self.lock:
            append(self.directory/'account-snapshots.jsonl',record)
            if self.account_start is None:
                prior=read_lines(self.directory/'account-snapshots.jsonl')
                self.account_start=next((r['data'].get('usage') for r in prior if s.numeric(r.get('data',{}).get('usage'))),None)
            current=safe.get('usage')
            if s.numeric(current) and s.numeric(self.account_start) and current-self.account_start >= 1 and not self.alerted:
                self.spending_alert({'ledger_usage_delta_usd':current-self.account_start,'ledger_note':'Account-wide usage may include concurrent production traffic.'})
            if response.get('http_status') in (401,402,403): self.abort.set()

    def spending_alert(self, evidence):
        alert={'event':'spending_alert',**evidence,'threshold_usd':1,'action':'continue','byok_upstream_cost':'unknown'}
        write_json(self.directory/'spending-alert.json',alert); self.alerted=True
        print(json.dumps(alert),flush=True)

    def execute(self, model, task):
        suite, cid, phase, rnd = task['suite'],task['case'],task['phase'],task['round']
        k=(suite,cid,model,rnd)
        self.gate()
        with self.lock:
            if self.abort.is_set() or model in self.blocked_models or k in self.rows: return
            req=self.make_request(suite,cid,model)
            intent={'attempt_id':uuid.uuid4().hex,'suite':suite,'case':cid,'phase':phase,'requested_model':model,'round':rnd,
                    'request_sha256':s.digest(req),'wire_request_sha256':s.digest(wire(req)), 'started_at':time.time()}
            append(self.directory/'intents.jsonl',intent)
        response=self.clients[model].call('POST','/api/alpha/decisions',wire(req))
        case=self.cases['legacy' if suite == 'smoke' else suite][cid]
        if response['http_status']==200 and not response['error'] and s.score(response['raw'],case['categories']) is None:
            response['error']='invalid_schema'
        row={**intent,**response}
        with self.lock:
            append(self.directory/'raw.jsonl',row)
            # append() fsyncs and reads back the exact appended bytes.
            self.rows[k]=row; self.finished_since_progress += 1
            if response['http_status'] in (401,402,403): self.abort.set()
            if response['error']=='invalid_schema': self.blocked_models.add(model)
            cost=s.returned_cost(row.get('raw'))
            if cost is not None: self.returned_total += cost
            if self.returned_total >= 1 and not self.alerted:
                self.spending_alert({'returned_cost_usd':self.returned_total})
            self.progress()

    def smoke_tasks(self):
        case=next(c for c in self.cases['legacy'].values() if not c['expected'])
        return [{'suite':'smoke','case':case['id'],'phase':'smoke','round':1}]

    def smoke_ok(self):
        task=self.smoke_tasks()[0]
        for model in MODELS:
            r=self.rows.get(('smoke',task['case'],model,1))
            if not r or r.get('http_status')!=200 or r.get('error'): return False
        return True

    def run(self, smoke_only):
        if not smoke_only and not self.smoke_ok(): raise ValueError('full run requires seven successful saved smoke responses')
        schedule=self.smoke_tasks() if smoke_only else self.schedule
        self.snapshot('before')
        def worker(family):
            try:
                for model, task in round_robin(family,schedule):
                    if self.abort.is_set(): break
                    self.execute(model,task)
            except Exception as exc:
                with self.lock:
                    self.thread_errors.append(type(exc).__name__)
                    self.abort.set()
        threads=[threading.Thread(target=worker,args=(family,)) for family in FAMILIES]
        for t in threads: t.start()
        while any(t.is_alive() for t in threads):
            for t in threads: t.join(timeout=.2)
            self.progress()
            if time.monotonic()-self.last_snapshot >= 60:
                self.snapshot('periodic'); self.last_snapshot=time.monotonic()
        self.snapshot('after'); self.progress(force=True)
        for client in self.clients.values(): client.close()
        if self.thread_errors: raise ValueError('worker failure: '+','.join(self.thread_errors))
        if self.abort.is_set(): raise ValueError('run stopped after authentication or balance HTTP error')
        if smoke_only and not self.smoke_ok(): raise ValueError('smoke failed; inspect saved outcomes before any full run')
        if self.blocked_models: raise ValueError('models stopped after invalid successful response: '+','.join(sorted(self.blocked_models)))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output-dir',required=True,type=Path,help='results directory outside the frozen package, or its ignored results/ subtree')
    p.add_argument('--seed',type=int,default=20261108)
    p.add_argument('--key-env-file',type=Path,help='read only OPENROUTER_API_KEY= from this file; never execute it')
    p.add_argument('--smoke-only',action='store_true',help='one benign request per model; required before full grid')
    args=p.parse_args()
    try:
        out=args.output_dir.resolve(); root=s.ROOT.resolve(); allowed=root/'results'
        if out == root or (out.is_relative_to(root) and not out.is_relative_to(allowed)) or out == allowed:
            raise ValueError('output directory must be external or a child of ignored results/')
        s.validate()
        key=get_key(args.key_env_file)
        out.mkdir(parents=True,exist_ok=True)
        # The lock lives outside the run directory to preserve an empty new directory.
        lock_path=out.parent/(out.name+'.lock')
        with lock_path.open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            run=Run(out,key,args.seed); run.initialize(); run.run(args.smoke_only)
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print('error: '+str(exc),file=sys.stderr); return 2
    return 0


if __name__ == '__main__': sys.exit(main())
