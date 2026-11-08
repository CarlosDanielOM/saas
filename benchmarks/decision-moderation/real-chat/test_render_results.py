"""Offline fixtures for the read-only, two-model real-chat renderer."""
import csv
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('real_chat_renderer', Path(__file__).with_name('render_results.py'))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
JEV, LUNA = r.MODELS


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + '\n', encoding='utf-8')


def metric(positive, benign, repeats):
    return dict(complete=True, observed=(positive + benign) * repeats,
                scheduled=(positive + benign) * repeats, positive_cases=positive,
                benign_cases=benign, positive_attempts=positive * repeats,
                benign_attempts=benign * repeats, timely_tp=positive * repeats,
                timely_fp=0, returned_fp=min(1, benign * repeats), errors=0,
                latency_p95_ms=123)


class RendererTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='real-chat-render-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.selection = {JEV: 'baseline', LUNA: 'policy_v2'}
        self.selection_path = self.root / 'selection.json'
        write(self.selection_path, {'selection': self.selection, 'source': 'development only'})
        for phase in r.PHASES:
            self.make_phase(phase)

    def make_phase(self, phase):
        directory = self.root / phase
        directory.mkdir(exist_ok=True)
        development = phase == 'development'
        repeats = 2 if development else 3
        variants = {JEV: ['baseline'], LUNA: list(r.VARIANTS) if development else list(dict.fromkeys(['baseline', self.selection[LUNA]]))}
        groups = {'real_development': metric(1, 2, repeats), 'synthetic_guardrail': metric(1, 1, repeats)} if development else {}
        overall = metric(2, 3, repeats) if development else metric(0 if phase == 'real-holdout' else 1, 3 if phase == 'real-holdout' else 2, repeats)
        models = {model: {variant: {'overall': dict(overall), 'evaluation_groups': groups}
                          for variant in versions} for model, versions in variants.items()}
        summary = {'selection': self.selection.copy(), 'models': models}
        write(directory / 'summary.json', summary)
        write(directory / 'meta.json', {'models': list(r.MODELS), 'phase': phase,
              'model_variants': variants, 'repeats': repeats,
              'source_hashes': {'fixture': 'f' * 64}})
        rows = []
        for model, versions in variants.items():
            for variant in versions:
                for case in range(overall['positive_cases'] + overall['benign_cases']):
                    for repeat in range(1, repeats + 1):
                        rows.append({'model': model, 'variant': variant, 'case': 'fixture-' + str(case), 'repeat': repeat,
                                     'attempt_id': f'{phase}-{model}-{variant}-{case}-{repeat}',
                                     'raw': {'usage': {'cost': .01, 'is_byok': False,
                                                      'cost_details': {'upstream_inference_cost': 99}},
                                             'private_prediction_not_for_export': 'DO_NOT_EXPORT'}})
        (directory / 'raw.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        self.refresh_audit(phase)

    def refresh_audit(self, phase):
        directory = self.root / phase
        summary = r.load(directory / 'summary.json')
        write(directory / 'audit.json', {'complete': True, 'mismatch_count': 0,
              'meta_sha256': r.sha(directory / 'meta.json'), 'raw_sha256': r.sha(directory / 'raw.jsonl'),
              'metrics': {model: {variant: source['overall'] for variant, source in variants.items()}
                          for model, variants in summary['models'].items()}})

    def data(self):
        return r.build_data(self.root, self.selection_path)

    def change(self, phase, file, mutate):
        path = self.root / phase / file
        data = r.load(path)
        mutate(data)
        write(path, data)

    def test_groups_and_zero_positive_holdout_and_csv(self):
        data = r.render(self.root, self.selection_path)
        self.assertEqual(len(data['rows']), 3)
        self.assertEqual(data['default_group'], 'fresh_challenge')
        self.assertEqual(set(data['groups']), {'fresh_challenge', 'real_holdout', 'real_development', 'synthetic_guardrail'})
        holdout = data['groups']['real_holdout']
        self.assertEqual(holdout['positive_attempts'], 0)
        self.assertEqual(holdout['benign_attempts'], 9)
        self.assertIn('zero positive', holdout['description'])
        with (self.root / 'results-table.csv').open(newline='', encoding='utf-8') as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 12)
        for row in [row for row in rows if row['group'] == 'real_holdout']:
            self.assertEqual(row['timely_catch_percent'], '')
            self.assertEqual(row['catch_status'], 'not measured — no positive cases')
            self.assertEqual(row['timely_false_ban_percent'], '0.0')
            self.assertEqual(row['returned_fp'], '1')
        for filename in ('comparison.html', 'comparison-data.json', 'results-table.csv'):
            self.assertNotIn('DO_NOT_EXPORT', (self.root / filename).read_text())
        html = (self.root / 'comparison.html').read_text()
        self.assertIn('Object.keys(DATA.groups || {})', html)
        self.assertIn('not measured — no positive cases', html)
        self.assertNotIn('innerHTML', html)
        self.assertIn('generator_sha256', data['metadata'])
        for phase in r.PHASES:
            for name in ('summary', 'meta', 'audit'):
                self.assertEqual(data['metadata']['source_hashes'][f'{phase}/{name}.json'], r.sha(self.root / phase / (name + '.json')))

    def test_actual_cost_counts_unshown_variants_once_and_byok_only(self):
        data = self.data()
        self.assertEqual(data['cost']['attempts'], 104)  # 50 development + 27 + 27
        self.assertAlmostEqual(data['cost']['openrouter_usd'], 1.04)
        self.assertEqual(data['cost']['byok_usd'], 0)  # upstream 99 is ignored when not BYOK
        raw_path = self.root / 'development' / 'raw.jsonl'
        rows = [json.loads(line) for line in raw_path.read_text().splitlines()]
        rows[0]['raw']['usage'] = {'cost': .01, 'is_byok': True, 'cost_details': {'upstream_inference_cost': .02}}
        rows[1]['raw']['usage'] = {'is_byok': True}
        rows[2]['raw']['usage'] = {'cost': .01}  # unknown status is not false
        raw_path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        self.refresh_audit('development')
        cost = self.data()['cost']
        self.assertAlmostEqual(cost['combined_known_usd'], 1.05)
        self.assertEqual(cost['byok_attempts'], 2)
        self.assertEqual(cost['unknown_returned_cost_attempts'], 1)
        self.assertEqual(cost['unknown_byok_upstream_attempts'], 1)
        self.assertEqual(cost['unknown_byok_status_attempts'], 1)
        self.assertEqual(cost['unknown_attempts'], 2)

    def test_retained_baseline_has_no_extra_cost(self):
        self.selection[LUNA] = 'baseline'
        write(self.selection_path, self.selection)
        for phase in r.PHASES:
            shutil.rmtree(self.root / phase)
            self.make_phase(phase)
        data = self.data()
        self.assertEqual(data['cost']['attempts'], 86)  # dev variants remain 50, test baseline only 18 each
        self.assertEqual(len(data['rows']), 3)
        selected = data['rows'][-1]
        self.assertTrue(selected['retained_baseline'])
        for group in data['groups'].values():
            self.assertEqual(group['rows'][selected['id']], group['rows'][selected['same_stored_metrics_as']])

    def test_missing_phase_is_notice_but_missing_all_is_rejected(self):
        shutil.rmtree(self.root / 'real-holdout')
        self.assertIn('real-holdout', self.data()['notice'])
        for phase in ('development', 'fresh-challenge'):
            shutil.rmtree(self.root / phase)
        with self.assertRaisesRegex(ValueError, 'no completed'):
            self.data()

    def test_incomplete_summary_is_rejected(self):
        self.change('development', 'summary.json', lambda s: s['models'][LUNA]['fewshot_v4']['overall'].update(complete=False))
        with self.assertRaisesRegex(ValueError, 'complete metrics'):
            self.data()

    def test_missing_or_failed_audit_is_rejected(self):
        audit_path = self.root / 'real-holdout' / 'audit.json'
        original = audit_path.read_text()
        for change in (lambda a: a.update(complete=False), lambda a: a.update(mismatch_count=1)):
            with self.subTest(change=change):
                audit_path.write_text(original)
                self.change('real-holdout', 'audit.json', change)
                with self.assertRaisesRegex(ValueError, 'zero-mismatch'):
                    self.data()
        audit_path.unlink()
        with self.assertRaisesRegex(ValueError, 'audit and raw'):
            self.data()

    def test_stale_audit_and_changed_summary_rejected(self):
        self.change('real-holdout', 'meta.json', lambda m: m.update(seed=7))
        with self.assertRaisesRegex(ValueError, 'hashes differ'):
            self.data()
        self.refresh_audit('real-holdout')
        self.change('real-holdout', 'summary.json', lambda s: s['models'][LUNA]['baseline']['overall'].update(returned_fp=0))
        with self.assertRaisesRegex(ValueError, 'differs from audited'):
            self.data()

    def test_model_subset_enforced_in_selection_summary_and_raw(self):
        bad = dict(self.selection, **{'respan/span-01': 'baseline'})
        write(self.selection_path, bad)
        with self.assertRaisesRegex(ValueError, 'two authorized models'):
            self.data()
        write(self.selection_path, self.selection)
        self.change('fresh-challenge', 'summary.json', lambda s: s['models'].update({'respan/span-01': {}}))
        with self.assertRaisesRegex(ValueError, 'two authorized models'):
            self.data()
        self.make_phase('fresh-challenge')
        raw_path = self.root / 'fresh-challenge' / 'raw.jsonl'
        with raw_path.open('a') as stream:
            stream.write(json.dumps({'model': 'respan/span-01'}) + '\n')
        self.refresh_audit('fresh-challenge')
        with self.assertRaisesRegex(ValueError, 'unauthorized model'):
            self.data()

    def test_frozen_selection_cannot_be_rechosen_by_validation(self):
        self.change('fresh-challenge', 'summary.json', lambda s: s.update(selection={JEV: 'baseline', LUNA: 'fewshot_v4'}))
        self.assertEqual(self.data()['selection'][LUNA], 'policy_v2')
        self.change('development', 'summary.json', lambda s: s.update(selection={JEV: 'baseline', LUNA: 'fewshot_v4'}))
        with self.assertRaisesRegex(ValueError, 'development-only summary selection'):
            self.data()

    def test_script_data_escaped_and_plain_text_dom(self):
        payload = '</script><img src=x onerror=alert(1)>\u2028&'
        self.change('development', 'meta.json', lambda m: m['source_hashes'].update({'fixture': payload}))
        self.refresh_audit('development')
        r.render(self.root, self.selection_path)
        html = (self.root / 'comparison.html').read_text()
        self.assertNotIn(payload, html)
        self.assertIn('\\u003c/script\\u003e', html)
        self.assertIn('node.textContent = String(content)', html)


if __name__ == '__main__':
    unittest.main()
