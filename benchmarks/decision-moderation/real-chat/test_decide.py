import json
from pathlib import Path
import tempfile
import unittest

import decide as d


def write(path, obj):
    path.write_text(json.dumps(obj), encoding='utf-8')


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        write(self.root / 'selection.json', {'selection': {d.JEV: 'baseline', d.LUNA: 'candidate'}})
        for phase in ('real-holdout', 'fresh-challenge'):
            self.make_phase(phase)

    def make_phase(self, phase):
        out = self.root / phase
        out.mkdir()
        positive = 0 if phase == 'real-holdout' else 2
        base = {'observed': 6, 'scheduled': 6, 'returned_tp': positive, 'returned_fp': 1, 'timely_tp': positive, 'timely_fp': 1, 'errors': 0, 'late': 0, 'latency_p95_ms': 100}
        overall = {**base, 'complete': True, 'positive_attempts': positive, 'affected_cases': {'timely_tp': ['PRIVATE_CASE_ID_123'] if positive else []}}
        write(out / 'summary.json', {'models': {d.JEV: {'baseline': {'overall': overall}}, d.LUNA: {'candidate': {'overall': overall}}}})
        write(out / 'meta.json', {'models': d.MODELS, 'phase': phase, 'model_variants': {d.JEV: ['baseline'], d.LUNA: ['candidate']}})
        for name in ('raw.jsonl', 'intents.jsonl', 'requests.json'):
            (out / name).write_text('fixture', encoding='utf-8')
        audit = {'complete': True, 'mismatch_count': 0, 'native_mismatch_count': 0, 'metric_mismatch_count': 0, 'missing_rows': 0, 'expected_rows': 12, 'observed_rows': 12, 'phase': phase,
                 'metrics': {d.JEV: {'baseline': base}, d.LUNA: {'candidate': base}}}
        for key, filename in [('meta_sha256', 'meta.json'), ('raw_sha256', 'raw.jsonl'), ('intents_sha256', 'intents.jsonl'), ('requests_file_sha256', 'requests.json')]: audit[key] = d.sha(out / filename)
        write(out / 'audit.json', audit)

    def change(self, phase, field, value):
        directory = self.root / phase
        for filename in ('audit.json', 'summary.json'):
            path = directory / filename
            obj = d.load(path)
            metrics = obj['metrics'][d.LUNA]['candidate'] if filename == 'audit.json' else obj['models'][d.LUNA]['candidate']['overall']
            metrics[field] = value
            write(path, obj)

    def test_ties_keep_incumbent_and_no_real_tp(self):
        result = d.decide(self.root)
        self.assertEqual(result['recommendation'], 'keep_jev_1_13')
        self.assertNotIn('timely_tp', result['checks']['real-holdout'])
        self.assertFalse(result['strict_improvement'])

    def test_strict_improvement_wins(self):
        self.change('real-holdout', 'returned_fp', 0)
        result = d.decide(self.root)
        self.assertTrue(result['gate_passed'])
        self.assertEqual(result['recommendation'], 'luna_candidate_on_this_benchmark')
        self.assertNotIn('PRIVATE_CASE_ID_123', json.dumps(result))  # no case identifiers

    def test_fp_regression_rejects(self):
        self.change('real-holdout', 'returned_fp', 0)
        self.change('fresh-challenge', 'timely_fp', 2)
        self.assertFalse(d.decide(self.root)['gate_passed'])

    def test_recall_regression_rejects(self):
        self.change('real-holdout', 'returned_fp', 0)
        self.change('fresh-challenge', 'timely_tp', 1)
        self.assertFalse(d.decide(self.root)['gate_passed'])

    def test_stale_audit_rejected(self):
        (self.root / 'real-holdout' / 'raw.jsonl').write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'stale audit'):
            d.decide(self.root)

    def test_p95_and_incomplete_audit_rejected(self):
        self.change('real-holdout', 'returned_fp', 0)
        self.change('fresh-challenge', 'latency_p95_ms', 4000)
        self.assertFalse(d.decide(self.root)['gate_passed'])
        path = self.root / 'fresh-challenge' / 'audit.json'
        audit = d.load(path); audit['complete'] = False; write(path, audit)
        with self.assertRaisesRegex(ValueError, 'audit'):
            d.decide(self.root)


if __name__ == '__main__': unittest.main()
