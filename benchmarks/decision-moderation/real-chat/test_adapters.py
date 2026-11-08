import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run_experiment as adapter
import contracts


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.case = {'id': 'one', 'message': 'hola ☕', 'context': [{'messageID': '1', 'username': 'a', 'message': 'hello', 'timestamp': '1', 'isBroadcaster': False}], 'categories': ['spam'], 'expected': True}
        (self.base / 'cases.json').write_text(json.dumps([self.case]), encoding='utf-8')
        self.example = {'message': 'ejemplo 世界', 'context': [], 'categories': ['spam'], 'expected_categories': ['spam'], 'rationale': 'test annotation'}
        (self.base / 'candidate.json').write_text(json.dumps({'category_examples': {'spam': [self.example]}}, ensure_ascii=False), encoding='utf-8')
        self.plan = {'schema_version': 1, 'phase': 'development', 'models': adapter.MODELS, 'repeats': 2, 'seed': 42, 'variants': {'baseline': 'baseline', 'candidate': 'candidate.json'}, 'cases_file': 'cases.json', 'contracts_module': str(Path(contracts.__file__).resolve()), 'selection_rule': adapter.e.RULE}
        self.planfile = self.base / 'plan.json'
        self.save_plan()

    def tearDown(self):
        self.tmp.cleanup()

    def save_plan(self):
        self.planfile.write_text(json.dumps(self.plan), encoding='utf-8')

    def test_models_counts_and_freeze(self):
        original = adapter.e.MODELS[:]
        prepared = adapter.prepare(self.planfile)
        self.assertEqual(adapter.e.MODELS, original)
        self.assertEqual(set(r['model'] for r in prepared[3]), set(adapter.MODELS))
        self.assertEqual(len(prepared[3]), 4)
        self.assertEqual(len(prepared[4]) * len(adapter.MODELS), 8)
        self.assertIn('real_chat_driver', prepared[5]['source_hashes'])
        self.assertIn('tuning_contracts', prepared[5]['source_hashes'])
        self.assertIn('variant:candidate', prepared[5]['source_hashes'])
        out = self.base / 'out'
        adapter.e.freeze(out, prepared)
        adapter.e.freeze(out, adapter.prepare(self.planfile))
        snapshot = out / 'sources' / (hashlib.sha256(b'real_chat_driver').hexdigest() + '.source')
        snapshot.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'snapshot source hash drift'):
            adapter.e.freeze(out, adapter.prepare(self.planfile))
        self.plan['models'] = original
        self.save_plan()
        with self.assertRaises(ValueError):
            adapter.prepare(self.planfile)

    def test_baseline_parity_examples_only_in_instructions(self):
        prepared = adapter.prepare(self.planfile)
        baseline = next(r['body'] for r in prepared[3] if r['variant'] == 'baseline')
        candidate = next(r['body'] for r in prepared[3] if r['variant'] == 'candidate')
        self.assertEqual(baseline, adapter.e.s.request(self.case, baseline['model']))
        self.assertEqual(candidate['state'], baseline['state'])
        self.assertNotIn('ejemplo', json.dumps(candidate['state'], ensure_ascii=False))
        self.assertNotIn('label', json.dumps(candidate['state'], ensure_ascii=False))
        self.assertIn('ejemplo 世界', candidate['questions']['spam']['instructions'])
        self.assertIn('ejemplo 世界', candidate['questions']['unsafe']['instructions'])
        other = dict(self.example, message='irrelevant', categories=['self_promotion'], expected_categories=[])
        mapping = {'candidate': {'category_examples': {'spam': [self.example], 'self_promotion': [other]}}}
        result = contracts.request(self.case, adapter.MODELS[0], 'candidate', mapping)
        self.assertNotIn('irrelevant', json.dumps(result, ensure_ascii=False))

    def test_multicategory_any_and_incomplete_examples(self):
        case = dict(self.case, categories=['spam', 'self_promotion'])
        both = dict(self.example, categories=['spam', 'self_promotion'], expected_categories=['self_promotion'])
        partial = dict(self.example, message='partial', categories=['spam'], expected_categories=[])
        mapping = {'candidate': {'category_examples': {'spam': [both, partial], 'self_promotion': [both]}}}
        result = contracts.request(case, adapter.MODELS[0], 'candidate', mapping)
        spam = result['questions']['spam']['instructions']
        unsafe = result['questions']['unsafe']['instructions']
        self.assertIn('"label":false', spam)
        self.assertIn('"label":true', unsafe)
        self.assertEqual(unsafe.count('ejemplo 世界'), 1)
        self.assertNotIn('partial', unsafe)
        malformed = dict(self.example)
        malformed.pop('expected_categories')
        malformed['label'] = True
        with self.assertRaises(ValueError):
            contracts.request(case, adapter.MODELS[0], 'candidate', {'candidate': {'category_examples': {'spam': [malformed]}}})

    def test_runner_requests_and_resume(self):
        out = self.base / 'out'
        adapter.e.freeze(out, adapter.prepare(self.planfile))
        class FakeClient:
            def __init__(self, key): self.calls = []
            def close(self): pass
            def call(self, method, path, body=None):
                self.calls.append(body['model'])
                return {'http_status': 200, 'error': None, 'raw': {'answers': {'spam': {'type': 'noul', 'noul': .1}, 'unsafe': {'type': 'noul', 'noul': .9}}, 'usage': {'cost': 0, 'input_tokens': 1}}, 'latency_ms': 1}
        run = adapter.e.Experiment(out, 'secret', FakeClient)
        with patch.object(adapter.e.time, 'sleep'):
            for model in adapter.MODELS: run.worker(model)
        self.assertEqual({m: len(run.clients[m].calls) for m in adapter.MODELS}, {m: 4 for m in adapter.MODELS})
        resumed = adapter.e.Experiment(out, 'secret', FakeClient)
        for model in adapter.MODELS: resumed.worker(model)
        self.assertTrue(all(not c.calls for c in resumed.clients.values()))
        self.assertEqual(set(adapter.e.analyze(out)['models']), set(adapter.MODELS))


if __name__ == '__main__': unittest.main()
