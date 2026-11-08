import json
from pathlib import Path
import subprocess
import sys
import unittest

import audit
import experiment as e
import test_experiment as fixtures


class AuditTests(unittest.TestCase):
    # Reuse only the temporary frozen fixture, not the parent test cases.
    setUp = fixtures.ExperimentTests.setUp
    tearDown = fixtures.ExperimentTests.tearDown

    def make_rows(self, incomplete=False):
        for req in self.prepared[3]:
            for repeat in (1,2):
                if incomplete and req==self.prepared[3][-1] and repeat==2: continue
                intent={'attempt_id':f"{req['model']}:{req['variant']}:{req['case']}:{repeat}",'model':req['model'],'variant':req['variant'],'case':req['case'],'repeat':repeat,'request_sha256':req['request_sha256'],'wire_sha256':req['wire_sha256'],'started_at':1}
                if req['case']=='n':
                    raw={'error':{'message':'OpenAI refused to answer question spam'}}; status=502; error=None
                elif repeat==2:
                    raw={}; status=200; error='invalid_schema'
                else:
                    raw={'answers':{'spam':{'type':'noul','noul':.9},'unsafe':{'type':'noul','noul':.9}},'usage':{'cost':.01,'input_tokens':3,'is_byok':False}}
                    status=200; error=None
                e.append(self.out/'intents.jsonl',intent); e.append(self.out/'raw.jsonl',{**intent,'http_status':status,'error':error,'raw':raw,'latency_ms':4000 if repeat==1 else 10})

    def test_complete_native_replay_and_refusals(self):
        self.make_rows(); raw_hash=e.sha(self.out/'raw.jsonl')
        report=audit.audit(self.out)
        self.assertTrue(report['complete']); self.assertEqual(report['mismatch_count'],0)
        self.assertEqual(report['http_errors']['502'],12)
        self.assertEqual(report['invalid_response_comparisons'],6)
        self.assertEqual(report['response_comparisons'],12)
        self.assertEqual(e.sha(self.out/'raw.jsonl'),raw_hash)
        metrics=report['metrics'][e.MODELS[0]]['baseline']
        self.assertEqual(metrics['returned_tp'],1); self.assertEqual(metrics['timely_tp'],0)
        self.assertEqual(metrics['unknown_byok_status_attempts'],3)

    def test_incomplete_cli_nonzero_and_keeps_raw(self):
        self.make_rows(incomplete=True); raw_hash=e.sha(self.out/'raw.jsonl')
        process=subprocess.run([sys.executable,str(Path(audit.__file__)),'--out',str(self.out)],capture_output=True,text=True)
        self.assertEqual(process.returncode,1,process.stderr)
        result=e.load(self.out/'audit.json')
        self.assertFalse(result['complete']); self.assertEqual(result['missing_rows'],1)
        self.assertEqual(e.sha(self.out/'raw.jsonl'),raw_hash)

if __name__=='__main__': unittest.main()
