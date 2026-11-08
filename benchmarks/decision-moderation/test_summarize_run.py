import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import suite
import summarize_run as a


def raw(spam=.1, unsafe=.1, cost=.01, byok=False, upstream=.2):
    usage={'cost':cost,'input_tokens':3,'is_byok':byok}
    if upstream is not None: usage['cost_details']={'upstream_inference_cost':upstream}
    return {'answers':{'spam':{'type':'noul','noul':spam},'unsafe':{'type':'noul','noul':unsafe}},'usage':usage}


def response(case, model, frozen, aid, su, phase, byok=False, upstream=.2):
    req=frozen.request(case,model)
    answers={k:{'type':'noul','noul':.1} for k in [*case['categories'],'unsafe']}
    payload=raw(byok=byok,upstream=upstream);payload['answers']=answers
    return {'attempt_id':aid,'suite':su,'case':case['id'],'phase':phase,'requested_model':model,'round':1,
            'request_sha256':frozen.digest(req),'wire_request_sha256':frozen.digest({**req,'user':a.USER}),
            'latency_ms':10,'http_status':200,'raw':payload,'error':None}


class SummaryTests(unittest.TestCase):
    def test_deadline_errors_and_byok(self):
        case={'categories':['spam']}; row={'latency_ms':4000,'http_status':200,'raw':raw(.9,.9),'error':None}
        result=a.classify(row,case,suite)
        self.assertTrue(result['returned_ban']);self.assertFalse(result['timely_ban'])
        for status,error,expected in [(429,None,'http_error'),(None,'transport_error','transport_error'),(200,'invalid_schema','invalid_response')]:
            self.assertEqual(a.classify({**row,'http_status':status,'error':error},case,suite)['failure'],expected)
        self.assertEqual(a.byok_usage(raw(byok=True,upstream=.003),suite),('known',.003))
        self.assertEqual(a.byok_usage(raw(byok=False,upstream=99),suite),('not_byok',None))
        self.assertEqual(a.byok_usage(raw(byok=True,upstream=None),suite),('unknown_cost',None))
        self.assertEqual(a.byok_usage({'usage':{}},suite),('unknown_status',None))

    def test_pairs_count_once_despite_repeats(self):
        plain={'id':'plain','expected':True,'variant':'plain','clean_case_id':'plain'}
        obf={'id':'obf','expected':True,'variant':'obfuscated','clean_case_id':'plain'}
        rec=lambda ban:{'result':{'timely_ban':ban,'returned_ban':ban}}
        observed={("m","obfuscation","plain",1):rec(True),("m","obfuscation","obf",1):rec(False),
                  ("m","obfuscation","plain",2):rec(True),("m","obfuscation","obf",2):rec(False)}
        with patch.object(a,'REPEATS',{'obfuscation':2}): result=a.obfuscation_pairs([plain,obf],observed,'m')
        self.assertEqual(result['attempt_counts']['positive_plain_caught_obfuscated_missed'],2)
        self.assertEqual(result['distinct_transformation_pair_counts']['positive_plain_caught_obfuscated_missed'],1)

    def test_verified_snapshot_independent_of_current_root_and_no_double_cost(self):
        with tempfile.TemporaryDirectory() as td:
            run=Path(td)/'run';run.mkdir();snapshot=run/'frozen-inputs';snapshot.mkdir()
            manifest=suite.load_json(suite.ROOT/'manifest.json')
            shutil.copy(suite.ROOT/'manifest.json',snapshot/'manifest.json')
            for rel in manifest['files']:
                dest=snapshot/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy(suite.ROOT/rel,dest)
            meta={'manifest_sha256':a.sha_file(snapshot/'manifest.json')}
            (run/'run-meta.json').write_text(json.dumps(meta))
            frozen,_,_=a.load_frozen_suite(run)
            cases,groups,grid,smoke=a.build_plan(frozen)
            schedule=[{'suite':su,'case':cid,'phase':phase,'round':r} for (su,cid),(c,phase) in cases.items() for r in range(1,a.REPEATS[su]+1)]
            meta.update({'schema_version':2,'models':list(a.MODELS),'repeats':a.REPEATS,'transport_user':a.USER,
                         'schedule_sha256':frozen.digest(schedule),'grid_attempts_per_model':len(schedule)})
            (run/'run-meta.json').write_text(json.dumps(meta));(run/'schedule.json').write_text(json.dumps(schedule))
            case=next(c for c,p in frozen.cases_for('expanded') if p=='holdout' and c['expected'])
            rows=[response(case,a.MODELS[0],frozen,'a','expanded','holdout',byok=True,upstream=.003),
                  response(smoke,a.MODELS[0],frozen,'b','smoke','smoke',byok=False,upstream=99)]
            def write(): (run/'raw.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in rows))
            write()
            # Current suite root now differs and is unusable; all actual data-dependent work must use snapshot.
            with patch.object(suite,'ROOT',Path(td)/'different-current-root'):
                summary,failures,coverage=a.analyze(run)
            self.assertEqual(coverage['status'],'INCOMPLETE');self.assertEqual(coverage['observed_main_attempts'],1)
            costs=summary['openrouter_and_byok_cost']
            self.assertAlmostEqual(costs['known_returned_sum_usd'],.02)
            self.assertAlmostEqual(costs['known_byok_upstream_sum_usd'],.003)
            self.assertAlmostEqual(costs['combined_known_or_and_byok_estimate_usd'],.023)
            self.assertEqual(costs['unknown_byok_cost_attempts'],0)
            rows.append(dict(rows[0]));write();summary,_,coverage=a.analyze(run)
            self.assertEqual(len(coverage['rejected_rows']),1)
            self.assertAlmostEqual(summary['openrouter_and_byok_cost']['combined_known_or_and_byok_estimate_usd'],.023)
            rows.pop();rows[0]['raw']['usage'].pop('cost_details');write()
            summary,_,_=a.analyze(run)
            self.assertEqual(summary['openrouter_and_byok_cost']['unknown_byok_cost_attempts'],1)
            # Corrupt Python is rejected before the import machinery executes it.
            (snapshot/'suite.py').write_text("raise RuntimeError('MUST NOT EXECUTE')\n")
            with self.assertRaises(a.FreezeError): a.analyze(run)


if __name__=='__main__': unittest.main()
