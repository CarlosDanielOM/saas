import importlib.util
import pathlib
import unittest
import json
import hashlib
import shutil
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('suite', pathlib.Path(__file__).with_name('suite.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


def raw(spam, unsafe, cost=.01):
    return {'answers': {'spam': {'type':'noul','noul':spam}, 'unsafe': {'type':'noul','noul':unsafe}},
            'usage': {'cost':cost,'input_tokens':5}}


class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.items = [({'id':'positive', 'message':'one', 'context':[], 'categories':['spam'], 'expected':True}, 'holdout'),
                      ({'id':'negative', 'message':'two', 'context':[], 'categories':['spam'], 'expected':False}, 'holdout')]

    def row(self, model, case, round=1, answer=None, latency=100):
        return {'case':case['id'], 'requested_model':model, 'round':round, 'phase':'holdout',
                'request_sha256':s.digest(s.request(case,model)), 'latency_ms':latency, 'http_status':200,
                'raw': raw(.9,.9) if answer is None else answer}

    def evaluate(self, rows, repeats=1):
        return s.evaluate(self.items, rows, 'typesafe/jev-1.13', 'candidate', repeats)

    def test_tie_and_threshold(self):
        self.assertEqual(s.score(raw(.85,.15),['spam'])[0], 'uncertain')
        self.assertEqual(s.score(raw(.85,.16),['spam'])[0], 'violation')
        self.assertEqual(s.score(raw(.849,.9),['spam'])[0], 'uncertain')
        self.assertEqual(s.score(raw(.2,.1),['spam'])[0], 'allow')

    def test_invalid_numbers_usage_and_missing_answers(self):
        for data in [raw(float('nan'),.9),raw(True,.9),raw(.9,.9,True),raw(.9,.9,-1),
                     {'answers':{},'usage':{'cost':0,'input_tokens':0}},
                     {'answers':raw(.9,.9)['answers'],'usage':{'cost':0,'input_tokens':2**53}}]:
            self.assertIsNone(s.score(data,['spam']))

    def test_missing_duplicate_wrong_hash_and_invalid_latency(self):
        row = self.row('typesafe/jev-1.13',self.items[0][0])
        report = self.evaluate([row])
        self.assertEqual(report['qualification'], 'incomplete')
        self.assertEqual(report['groups']['holdout']['models']['typesafe/jev-1.13']['missing_attempts'], 1)
        for bad in ([row,row], [{**row,'request_sha256':'bad'}], [{**row,'latency_ms':float('nan')}], [{**row,'round':2}], [{**row,'phase':'development'}]):
            with self.assertRaises(ValueError): self.evaluate(bad)

    def test_tampering_late_invalid_and_cost_once(self):
        p,n = (x[0] for x in self.items)
        rows = [self.row('typesafe/jev-1.13',p,answer=raw(.1,.1)), self.row('typesafe/jev-1.13',n,answer=raw(.1,.1)),
                {**self.row('candidate',p,latency=4000), 'verdict':'violation','operational_ban':True,'scores':{'spam':1}},
                {**self.row('candidate',n,answer=raw(.1,.1)), 'verdict':'violation'}]
        result = self.evaluate(rows)
        candidate = result['groups']['holdout']['models']['candidate']
        self.assertEqual(candidate['timely_tp_attempts'],0)
        self.assertEqual(candidate['returned_fp_attempts'],0)
        self.assertEqual(candidate['deadline_errors'],1)
        self.assertAlmostEqual(candidate['known_returned_cost'],.02)
        rows[2]['raw'] = raw(float('nan'), .9)
        candidate = self.evaluate(rows)['groups']['holdout']['models']['candidate']
        self.assertEqual(candidate['response_errors'],1)
        self.assertEqual(candidate['timely_tp_attempts'],0)
        self.assertAlmostEqual(candidate['known_returned_cost'], .02)
        rows[2]['raw'] = {}
        candidate = self.evaluate(rows)['groups']['holdout']['models']['candidate']
        self.assertEqual(candidate['unknown_returned_cost_attempts'],1)
        self.assertAlmostEqual(candidate['known_returned_cost'], .01)

    def test_qualification_and_repeat_consistency(self):
        p,n = (x[0] for x in self.items)
        rows = []
        for model in ('typesafe/jev-1.13','candidate'):
            for r in (1,2):
                rows.append(self.row(model,p,r,raw(.9,.9) if model == 'candidate' and r == 1 else raw(.1,.1)))
                rows.append(self.row(model,n,r,raw(.1,.1)))
        report = self.evaluate(rows,2)
        self.assertEqual(report['qualification'],'synthetic_holdout_candidate')
        self.assertEqual(report['groups']['holdout']['models']['candidate']['flipping_cases'],['positive'])
        rows[-1]['raw'] = raw(.9,.9)
        self.assertEqual(self.evaluate(rows,2)['qualification'], 'false_bans_observed')

    def test_http_error_secondary_categories_and_metadata(self):
        case = {**self.items[0][0], 'categories':['spam','ads']}
        response = raw(.1,.9)
        response['answers']['ads'] = {'type':'noul','noul':.9}
        response['answers']['insults'] = {'type':'noul','noul':1}
        response.update({'source_model':'source-x','model':'resolved-y','provider':'provider-z'})
        self.assertEqual(s.score(response,case['categories'])[0], 'violation')
        response['answers']['ads']['noul'] = .2
        self.assertEqual(s.score(response,case['categories'])[0], 'uncertain')
        response['answers']['ads']['noul'] = .9
        row = self.row('candidate',case,answer=response)
        row['http_status'] = 429
        report = s.evaluate([(case,'holdout')],[row],'typesafe/jev-1.13','candidate',1)
        data = report['groups']['holdout']['models']['candidate']
        self.assertEqual(data['response_errors'], 1)
        self.assertEqual(data['timely_tp_attempts'], 0)
        self.assertEqual(data['known_returned_cost'], .01)
        self.assertEqual(data['response_metadata_counts']['resolved_model'], {'resolved-y':1})
        self.assertEqual(data['scheduled_positive_attempts'], 1)
        self.assertEqual(data['scheduled_benign_attempts'], 0)

    def test_mechanism_and_repeats_as_distinct_attempts(self):
        p,n = (x[0] for x in self.items)
        rows = []
        for model in ('typesafe/jev-1.13','candidate'):
            for r in (1,2):
                rows.append(self.row(model,p,r,raw(.9,.8) if model == 'candidate' else raw(.1,.1)))
                rows.append(self.row(model,n,r,raw(.9,.05) if model == 'candidate' else raw(.1,.1)))
        result = self.evaluate(rows,2)
        data = result['groups']['holdout']['models']['candidate']
        self.assertEqual(data['timely_tp_attempts'],2)
        self.assertEqual(data['timely_tp_cases'],['positive'])
        self.assertEqual(data['mechanism_diagnostics']['unsafe_below_highest_category'],4)
        self.assertEqual(data['mechanism_diagnostics']['high_category_safe_veto'],2)
        rows[-1]['raw'] = raw(.9,.9)
        rows[-1]['latency_ms'] = 4000
        result = self.evaluate(rows,2)
        self.assertEqual(result['qualification'],'false_bans_observed')
        self.assertEqual(result['groups']['holdout']['models']['candidate']['timely_fp_attempts'],0)

    def test_nonobject_and_export_headers(self):
        for obj in [None, [], 'bad', 42]:
            with self.assertRaisesRegex(ValueError,'row must be an object'):
                self.evaluate([obj])
        row = next(s.export_rows(self.items,'model',1))
        self.assertEqual(row['headers'], {'HTTP-Referer':'https://domdimabot.com',
            'X-OpenRouter-Title':'DomDimaBot',
            'X-OpenRouter-Description':'DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.',
            'X-OpenRouter-Categories':'general-chat, roleplay', 'Content-Type':'application/json'})
        self.assertEqual(set(row['request']), {'model','questions','state'})
        self.assertNotIn('expected', json.dumps(row['request']))
        self.assertNotIn('rationale', json.dumps(row['request']))

    def test_cli_checks_manifest_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = pathlib.Path(__file__).parent
            shutil.copy(source/'suite.py',root/'suite.py')
            shutil.copy(source/'scenarios.json',root/'scenarios.json')
            shutil.copytree(source/'legacy',root/'legacy')
            scenario = root/'scenarios.json'
            sha = hashlib.sha256(scenario.read_bytes()).hexdigest()
            (root/'manifest.json').write_text(json.dumps({'files':{'scenarios.json':sha}}))
            scenario.write_bytes(scenario.read_bytes() + b' ')
            output = root/'output.jsonl'
            output.write_text('sentinel')
            for command in [ ['export','--suite','legacy','--model','x','--output',str(output)],
                             ['evaluate','--suite','legacy','--baseline','a','--candidate','b','--output',str(output),str(output)] ]:
                process = subprocess.run([sys.executable,str(root/'suite.py'),*command],capture_output=True,text=True)
                self.assertEqual(process.returncode,2)
                self.assertIn('hash mismatch',process.stderr)
                self.assertEqual(output.read_text(),'sentinel')

    def test_split_isolation(self):
        row = self.row('typesafe/jev-1.13', self.items[0][0])
        with self.assertRaises(ValueError):
            s.evaluate([self.items[1]], [row], 'baseline', 'candidate', 1)


if __name__ == '__main__':
    unittest.main()
