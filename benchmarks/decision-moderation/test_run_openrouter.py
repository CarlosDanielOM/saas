import contextlib
import hashlib
import shutil
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
spec=importlib.util.spec_from_file_location('runner',ROOT/'run_openrouter.py')
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


def answer(value=.9, cost=.1):
    return {'answers':{'spam':{'type':'noul','noul':value},'unsafe':{'type':'noul','noul':.9}}, 'usage':{'cost':cost,'input_tokens':1}}


class FakeClient:
    def __init__(self, key): self.calls=[]; self.key=key; self.response={'http_status':200,'raw':answer(),'latency_ms':10,'error':None}
    def call(self,method,path,body=None): self.calls.append((method,path,body)); return dict(self.response)
    def close(self): pass


class Response:
    status=200
    def read(self): return json.dumps(answer(),ensure_ascii=False).encode()


class Connection:
    def __init__(self): self.calls=[]
    def request(self,*args,**kwargs): self.calls.append((args,kwargs))
    def getresponse(self): return Response()
    def close(self): pass


class Tests(unittest.TestCase):
    def test_key_file_allows_dotenv_spacing_and_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.env'
            for definition in ['OPENROUTER_API_KEY = "fake-key"', "export OPENROUTER_API_KEY='fake-key'"]:
                path.write_text('# fixture\n' + definition + '\nOTHER=value\n')
                self.assertEqual(r.get_key(path), 'fake-key')

    def prepare(self, path):
        with mock.patch.object(r,'build_schedule',return_value=[]):
            run=r.Run(path,'secret',1,FakeClient)
        case={'id':'x','message':'s\u200bpаｍ cafe\u0301','context':[],'categories':['spam'],'expected':True}
        req=r.s.request(case,r.MODELS[0]); run.cases={'legacy':{'x':case}}
        run.requests={('legacy','x',r.MODELS[0]):req}; run.gate=lambda:None
        return run, {'suite':'legacy','case':'x','phase':'primary','round':1}

    def test_wire_unicode_attribution_and_digest(self):
        conn=Connection(); client=r.Client('secret',lambda:conn)
        req={'model':'m','questions':{},'state':{'output':{'role':'assistant','content':'s\u200bpаｍ cafe\u0301'}}}
        result=client.call('POST','/api/alpha/decisions',r.wire(req))
        args, kwargs=conn.calls[0]; self.assertEqual(result['http_status'],200)
        body=json.loads(kwargs['body'].decode('utf-8'))
        self.assertEqual(body['state']['output']['content'],req['state']['output']['content'])
        self.assertEqual(body['user'],r.USER)
        self.assertNotEqual(r.s.digest(req),r.s.digest(body))
        self.assertEqual({k:kwargs['headers'][k] for k in r.s.HEADERS},r.s.HEADERS)
        self.assertEqual(kwargs['headers']['Authorization'],'Bearer secret')

    def test_transport_failure_not_retried_and_connection_replaced(self):
        class Bad(Connection):
            def request(self,*args,**kwargs): raise OSError('secret')
        made=[]
        def factory():
            made.append(1); return Bad() if len(made)==1 else Connection()
        client=r.Client('secret',factory)
        self.assertEqual(client.call('POST','/',{})['error'],'transport_error')
        self.assertEqual(len(made),1)
        self.assertEqual(client.call('POST','/',{})['http_status'],200)
        self.assertEqual(len(made),2)

    def test_soft_budget_continues_saved_once_and_no_key_output(self):
        with tempfile.TemporaryDirectory() as d:
            run,task=self.prepare(Path(d)); client=run.clients[r.MODELS[0]]
            client.response['raw']=answer(cost=1.2)
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                run.execute(r.MODELS[0],task); run.execute(r.MODELS[0],task)
                run.execute(r.MODELS[0],{**task,'round':2})
            self.assertEqual(len(client.calls),2)
            self.assertEqual(len(r.read_lines(Path(d)/'raw.jsonl')),2)
            self.assertEqual(len(r.read_lines(Path(d)/'intents.jsonl')),2)
            self.assertEqual(run.returned_total,2.4)
            self.assertFalse(run.abort.is_set())
            self.assertEqual(output.getvalue().count('spending_alert'),1); self.assertNotIn('secret',output.getvalue())
            self.assertEqual(json.loads((Path(d)/'spending-alert.json').read_text())['action'],'continue')

    def test_protocol_failure_failopen_and_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            run,task=self.prepare(Path(d)); client=run.clients[r.MODELS[0]]
            client.response['raw']={'usage':{'cost':.3,'input_tokens':1},'answers':{}}
            run.execute(r.MODELS[0],task)
            row=r.read_lines(Path(d)/'raw.jsonl')[0]
            self.assertEqual(row['error'],'invalid_schema')
            self.assertIn(r.MODELS[0],run.blocked_models)
            self.assertEqual(run.returned_total,.3)
            self.assertIsNone(r.s.score(row['raw'],['spam']))

    def test_provider_rotation_same_schedule(self):
        schedule=[{'case':'a'},{'case':'b'}]
        self.assertEqual([(m,t['case']) for m,t in r.round_robin(r.MODELS[:2],schedule)],
                         [(r.MODELS[0],'a'),(r.MODELS[1],'a'),(r.MODELS[0],'b'),(r.MODELS[1],'b')])

    def test_inflight_resume_detection(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'fixtures'; root.mkdir()
            for name in ('suite.py','scenarios.json','obfuscation.json'):
                shutil.copyfile(ROOT/name, root/name)
            shutil.copytree(ROOT/'legacy',root/'legacy')
            paths=[p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
            manifest={'files':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
            (root/'manifest.json').write_text(json.dumps(manifest))
            out=Path(d)/'run'; out.mkdir()
            with mock.patch.object(r.s,'ROOT',root):
                run=r.Run(out,'secret',1,FakeClient); run.initialize()
                run.gate=lambda:None
                model=r.MODELS[0]; task=next(t for t in run.schedule if t['suite']=='legacy')
                run.execute(model,task)
                self.assertEqual(len(r.read_lines(out/'raw.jsonl')),1)
                resumed=r.Run(out,'secret',1,FakeClient); resumed.initialize(); resumed.gate=lambda:None
                resumed.execute(model,task)
                self.assertEqual(len(resumed.clients[model].calls),0)
                self.assertEqual(resumed.returned_total,.1)
                next_task=next(t for t in run.schedule if t != task and t['suite']=='legacy')
                req=run.make_request(next_task['suite'],next_task['case'],model)
                intent={**next_task,'requested_model':model,'attempt_id':'unresolved', 'request_sha256':r.s.digest(req), 'wire_request_sha256':r.s.digest(r.wire(req))}
                r.append(out/'intents.jsonl',intent)
                blocked=r.Run(out,'secret',1,FakeClient)
                with self.assertRaisesRegex(ValueError,'unresolved in-flight intents: unresolved'):
                    blocked.initialize()
                self.assertTrue(all(not c.calls for c in blocked.clients.values()))

    def test_redaction_nested(self):
        self.assertEqual(r.redact({'message':'bearer secret','data':['secret']},'secret'),{'message':'bearer [REDACTED]','data':['[REDACTED]']})


if __name__=='__main__': unittest.main()
