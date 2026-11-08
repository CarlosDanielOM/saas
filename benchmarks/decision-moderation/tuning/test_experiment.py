import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import experiment as e
import contracts


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.base=Path(self.temp.name)
        self.cases=[{'id':'p','message':'mándame café ☕','context':[{'messageID':'1','username':'a','message':'hello 世界','timestamp':'1','isBroadcaster':False}],'categories':['spam'],'expected':True,'split':'development','family':'f'}, {'id':'n','message':'benign','context':[],'categories':['spam'],'expected':False,'split':'development','family':'f'}]
        (self.base/'cases.json').write_text(json.dumps(self.cases,ensure_ascii=False),encoding='utf-8')
        self.plan={'schema_version':1,'phase':'development','models':e.MODELS,'repeats':2,'seed':42,'variants':{'baseline':{'kind':'baseline'},'candidate':{'definitions':{'spam':'custom'}}},'cases_file':'cases.json','contracts_module':str(Path(contracts.__file__).resolve()),'selection_rule':e.RULE}
        self.planfile=self.base/'plan.json'; self.planfile.write_text(json.dumps(self.plan),encoding='utf-8')
        self.out=self.base/'out'; self.prepared=e.prepare(self.planfile); e.freeze(self.out,self.prepared)

    def tearDown(self): self.temp.cleanup()

    def test_frozen_unicode_and_no_labels(self):
        req=next(r['body'] for r in self.prepared[3] if r['case']=='p' and r['variant']=='baseline')
        self.assertEqual(req['state']['output']['content'],self.cases[0]['message'])
        self.assertEqual(json.loads(req['state']['input'][0]['content']),self.cases[0]['context'][0])
        self.assertNotIn('expected',json.dumps(req)); self.assertEqual(req,e.s.request(self.cases[0],e.MODELS[0]))
        alt=contracts.request(self.cases[0],e.MODELS[0],'candidate',self.prepared[2])
        self.assertIn('custom',alt['questions']['unsafe']['criteria']['true'])
        (self.base/'cases.json').write_text('[]');
        with self.assertRaises(ValueError): e.freeze(self.out,e.prepare(self.planfile))
        (self.out/'cases.json').write_text('[]')
        with self.assertRaises(ValueError): e.verify_snapshot(self.out)

    def test_unresolved_duplicate_and_hash_drift(self):
        r=self.prepared[3][0]; t=next(t for t in self.prepared[4] if t['variant']==r['variant'] and t['case']==r['case'])
        intent={'attempt_id':'one','model':r['model'],**t,'request_sha256':r['request_sha256'],'wire_sha256':r['wire_sha256'],'started_at':1}
        e.append(self.out/'intents.jsonl',intent)
        with self.assertRaisesRegex(ValueError,'unresolved'): e.verify_rows(self.out)
        e.append(self.out/'raw.jsonl',{**intent,'raw':None,'error':'transport_error','http_status':None,'latency_ms':3})
        e.verify_rows(self.out)
        e.append(self.out/'intents.jsonl',dict(intent,attempt_id='two'))
        with self.assertRaisesRegex(ValueError,'duplicate'): e.verify_rows(self.out)

    def test_costs(self):
        self.assertEqual(e.costs({'usage':{'cost':.1,'is_byok':True,'cost_details':{'upstream_inference_cost':.2}}}),(.1,.2,True))
        self.assertEqual(e.costs({'usage':{'is_byok':False,'cost_details':{'upstream_inference_cost':.2}}}),(None,None,False))
        self.assertEqual(e.costs({'usage':{'is_byok':True}}),(None,None,True))

    def test_invalid_schema_halts_only_model_and_resume(self):
        class FakeClient:
            def __init__(self,key): self.calls=0
            def close(self): pass
            def call(self,method,path,body=None):
                self.calls+=1
                if body['model']==e.MODELS[0]: raw={}
                else: raw={'answers':{'spam':{'type':'noul','noul':.1},'unsafe':{'type':'noul','noul':.9}},'usage':{'cost':0,'input_tokens':1}}
                return {'http_status':200,'error':None,'raw':raw,'latency_ms':1}
        run=e.Experiment(self.out,'secret',FakeClient)
        with patch.object(e.time,'sleep'):
            run.worker(e.MODELS[0]); run.worker(e.MODELS[1])
        self.assertEqual(run.clients[e.MODELS[0]].calls,1)
        self.assertEqual(run.clients[e.MODELS[1]].calls,len(run.schedule))
        row=next(r for r in run.rows.values() if r['model']==e.MODELS[0])
        self.assertEqual(row['error'],'invalid_schema')
        resumed=e.Experiment(self.out,'secret',FakeClient); resumed.worker(e.MODELS[0])
        self.assertEqual(resumed.clients[e.MODELS[0]].calls,0)
        self.assertFalse(e.analyze(self.out)['models'][e.MODELS[0]]['baseline']['overall']['complete'])

    def test_invalid_latency_status_rejected_and_refusal_reported(self):
        req=self.prepared[3][0]; task=next(t for t in self.prepared[4] if t['case']==req['case'] and t['variant']==req['variant'])
        intent={'attempt_id':'failure','model':req['model'],**task,'request_sha256':req['request_sha256'],'wire_sha256':req['wire_sha256'],'started_at':1}
        e.append(self.out/'intents.jsonl',intent)
        row={**intent,'http_status':502,'latency_ms':1,'error':None,'raw':{'error':{'message':'OpenAI refused to answer question spam'}}}
        for field,value in [('latency_ms',True),('latency_ms',-1),('latency_ms',float('nan')),('http_status',True),('http_status',700)]:
            bad=dict(row,**{field:value}); (self.out/'raw.jsonl').write_text(json.dumps(bad)+'\n')
            with self.assertRaisesRegex(ValueError,'invalid outcome'): e.verify_rows(self.out)
        (self.out/'raw.jsonl').write_text(json.dumps(row)+'\n')
        summary=e.analyze(self.out)['models'][req['model']][req['variant']]['overall']
        self.assertEqual(summary['refusals'],1)
        self.assertEqual(summary['failure_message_counts']['OpenAI refused to answer question spam'],1)
        self.assertEqual(summary['unknown_returned_cost_attempts'],1)
        self.assertEqual(summary['unknown_byok_status_attempts'],1)

    def test_model_variant_subsets(self):
        self.plan['model_variants']={e.MODELS[0]:['baseline','candidate'], e.MODELS[1]:['baseline'], e.MODELS[2]:['baseline']}
        self.planfile.write_text(json.dumps(self.plan),encoding='utf-8')
        prepared=e.prepare(self.planfile)
        self.assertEqual(sum(r['model']==e.MODELS[1] for r in prepared[3]),2)
        out=self.base/'subset'; e.freeze(out,prepared)
        self.assertEqual(e.verify_rows(out)[0]['model_variants'][e.MODELS[1]],['baseline'])

    def test_strata_regression_disqualifies(self):
        self.cases[0]['evaluation_group']='expanded'; self.cases[1]['evaluation_group']='obfuscation'
        # Add a positive case in the second group; candidate loses that catch while
        # gaining two in the first group, so aggregate-only selection would pass.
        self.cases.append(dict(self.cases[0],id='p2',evaluation_group='obfuscation'))
        (self.base/'cases.json').write_text(json.dumps(self.cases),encoding='utf-8')
        prepared=e.prepare(self.planfile); out=self.base/'strata'; e.freeze(out,prepared)
        for req in prepared[3]:
            for repeat in (1,2):
                intent={'attempt_id':f"{req['model']}:{req['variant']}:{req['case']}:{repeat}",'model':req['model'],'variant':req['variant'],'case':req['case'],'repeat':repeat,'request_sha256':req['request_sha256'],'wire_sha256':req['wire_sha256'],'started_at':1}
                hit=(req['variant']=='candidate' and req['case']=='p') or (req['variant']=='baseline' and req['case']=='p2' and repeat==1)
                raw={'answers':{'spam':{'type':'noul','noul':.9 if hit else .1},'unsafe':{'type':'noul','noul':.9}},'usage':{'cost':0,'input_tokens':1}}
                e.append(out/'intents.jsonl',intent); e.append(out/'raw.jsonl',{**intent,'raw':raw,'error':None,'http_status':200,'latency_ms':10})
        self.assertTrue(all(v=='baseline' for v in e.analyze(out)['selection'].values()))

    def test_deadline_selection_and_no_pooling(self):
        for req in self.prepared[3]:
            for repeat in (1,2):
                intent={'attempt_id':f"{req['model']}:{req['variant']}:{req['case']}:{repeat}",'model':req['model'],'variant':req['variant'],'case':req['case'],'repeat':repeat,'request_sha256':req['request_sha256'],'wire_sha256':req['wire_sha256'],'started_at':1}
                # Candidate improves only the first model, and exactly 4000 ms is late.
                first=req['model']==e.MODELS[0]; positive=req['case']=='p'; candidate=req['variant']=='candidate'
                violation=positive and (not candidate or first)
                raw={'answers':{'spam':{'type':'noul','noul':.9 if violation else .1},'unsafe':{'type':'noul','noul':.9}},'usage':{'cost':0,'input_tokens':1}}
                latency=4000 if first and positive and not candidate else 10
                e.append(self.out/'intents.jsonl',intent); e.append(self.out/'raw.jsonl',{**intent,'raw':raw,'error':None,'http_status':200,'latency_ms':latency})
        report=e.analyze(self.out)
        self.assertEqual(report['selection'][e.MODELS[0]],'candidate')
        self.assertEqual(report['selection'][e.MODELS[1]],'baseline')
        self.assertEqual(report['models'][e.MODELS[0]]['baseline']['overall']['timely_tp'],0)
        self.assertEqual(report['models'][e.MODELS[0]]['baseline']['overall']['returned_tp'],2)

if __name__=='__main__': unittest.main()
