import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('live_verify',ROOT/'verify_live_contract.py')
v=importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
RUN=ROOT/'results'/'2026-11-08-seven-model-baseline'


class NativeParityTests(unittest.TestCase):
    def test_actual_parser_guards_and_timing(self):
        if not (RUN/'production-source'/'snapshot.json').exists():
            self.skipTest('production source snapshot is not present')
        v.verify_inputs(RUN)
        def raw(score,cost=0,tokens=1):
            return {'answers':{'spam':{'type':'noul','noul':score},'unsafe':{'type':'noul','noul':.9}},'usage':{'cost':cost,'input_tokens':tokens}}
        expected={'verdict':'violation','cost':.25,'inputTokens':4,
                  'scores':{'spam':.85,'safe':1-.9,'violation':.85},'timely':False}
        responses=[{'id':'late','raw':raw(.85,.25,4),'categories':['spam'],'latency_ms':4000,'error':None,'expected':expected}]
        for i,bad in enumerate((raw(.9,-1),raw(.9,True),raw(.9,0,2**53),raw(1.01),{'answers':{},'usage':{'cost':0,'input_tokens':0}})):
            responses.append({'id':str(i),'raw':bad,'categories':['spam'],'latency_ms':1,'error':None,'expected':None})
        headers={k:v for k,v in v.load_frozen_suite(RUN/'frozen-inputs').HEADERS.items() if k.lower()!='content-type'}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); v.make_node(RUN/'production-source',p)
            (p/'input.json').write_text(json.dumps({'headers':headers,'requests':[],'responses':responses}))
            output=subprocess.run(['node',str(p/'verify.mjs'),str(p/'input.json')],capture_output=True,text=True,check=True)
            result=json.loads(output.stdout)
        self.assertEqual(result['response_comparisons'],6)
        self.assertEqual(result['invalid_response_comparisons'],5)
        self.assertEqual(result['mismatch_count'],0)

    def test_partial_jsonl_only_counts_complete_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'raw.jsonl'; path.write_bytes(b'{"id":1}\n{"id":')
            rows,partial=v.read_complete_lines(path)
            self.assertEqual(rows,[{'id':1}]); self.assertTrue(partial)

    def test_rejects_path_escape(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError): v.checked_child(Path(d),'../outside')


if __name__=='__main__': unittest.main()
