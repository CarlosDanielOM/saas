#!/usr/bin/env python3
"""Offline audit of a stopped tuning phase against captured production JavaScript."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types

import experiment as e
import verify_live_contract as live

DEFAULT_SOURCE = e.ROOT/'results/2026-11-08-seven-model-baseline/production-source'


def file_hash(path):
    return e.sha(path) if path.exists() else None


def audit(out, production_source=None):
    out=Path(out).resolve(); source=Path(production_source or (out/'production-source' if (out/'production-source').exists() else DEFAULT_SOURCE)).resolve()
    # The caller must stop the phase. The lock also prevents a simultaneous resume.
    import fcntl
    with (out/'.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return _audit(out,source)


def _audit(out,source):
    meta,reqs,rows=e.verify_rows(out)
    snapshot=e.load(source/'snapshot.json')
    required={'spam_categories.js','semantic.js','spam.js','advanced.js','app_attribution.util.js'}
    if not required <= set(snapshot['files']): raise ValueError('production snapshot missing source files')
    for name,expected in snapshot['files'].items():
        if e.sha(live.checked_child(source,name)) != expected: raise ValueError('production source hash mismatch: '+name)
    cases=e.load(out/'cases.json')
    original_cases=e.load(out/'sources'/(hashlib.sha256(b'cases').hexdigest()+'.source'))
    if original_cases != cases: raise ValueError('case source and snapshot differ')
    cases=original_cases  # Preserve source property order for production JSON.stringify.
    cases_by_id={c['id']:c for c in cases}
    if len(cases_by_id)!=len(cases): raise ValueError('duplicate case ID')
    expected={(m,v,c['id'],r) for m in meta['models'] for v in meta['model_variants'][m] for c in cases for r in range(1,meta['repeats']+1)}
    schedule=e.load(out/'schedule.json')
    actual_schedule=[(m,t['variant'],t['case'],t['repeat']) for m in meta['models'] for t in schedule if t['variant'] in meta['model_variants'][m]]
    if len(actual_schedule)!=len(set(actual_schedule)) or set(actual_schedule)!=expected: raise ValueError('scheduled grid mismatch')
    all_requests=e.load(out/'requests.json'); expected_requests={key[:3] for key in expected}
    if len(all_requests)!=len(reqs) or set(reqs)!=expected_requests: raise ValueError('request grid mismatch')
    mismatches=[]; inputs=[]
    for key,request in reqs.items():
        model,variant,cid=key; case=cases_by_id[cid]; body=request['body']; baseline=reqs[(model,'baseline',cid)]['body']
        if e.s.digest(body)!=request['request_sha256'] or e.s.digest({**body,'user':meta['transport_user']})!=request['wire_sha256']:
            mismatches.append({'kind':'request_hash','id':key})
        if set(body)!= {'model','questions','state'} or body.get('model')!=model or set(body.get('questions',{}))!=set(case['categories'])|{'unsafe'} or body.get('state')!=baseline.get('state'):
            mismatches.append({'kind':'candidate_shape_or_state','id':key})
        if variant=='baseline':
            inputs.append({'id':':'.join(key),'case':{k:case[k] for k in ('message','context','categories')},'model':model,'expected':body})
    suite_path=out/'sources'/(hashlib.sha256(b'suite').hexdigest()+'.source')
    frozen=types.ModuleType('audit_frozen_suite'); frozen.__file__=str(suite_path)
    exec(compile(suite_path.read_bytes(),str(suite_path),'exec'),frozen.__dict__)
    responses=[]; http_errors=Counter(); http_failure_messages=Counter(); refusals=0; successful=0
    for key,row in rows.items():
        case=cases_by_id[key[2]]
        if row['http_status']!=200:
            http_errors[str(row['http_status'])]+=1
            raw=row.get('raw'); error=raw.get('error') if isinstance(raw,dict) else None
            message=error.get('message') if isinstance(error,dict) else None
            if isinstance(message,str) and message:
                http_failure_messages[message]+=1
                if 'refused to answer question' in message.lower(): refusals+=1
            continue
        successful+=1; raw=row.get('raw'); parsed=frozen.score(raw,case['categories']); parsed_expected=None
        if parsed is not None:
            scores={k:raw['answers'][k]['noul'] for k in case['categories']}; scores['safe']=1-raw['answers']['unsafe']['noul']; scores['violation']=max(scores[k] for k in case['categories'])
            parsed_expected={'verdict':parsed[0],'cost':parsed[1],'inputTokens':raw['usage']['input_tokens'],'scores':scores,'timely':parsed[0]=='violation' and row['latency_ms']<4000 and not row.get('error')}
        responses.append({'id':json.dumps(key,ensure_ascii=False),'raw':raw,'categories':case['categories'],'latency_ms':row['latency_ms'],'error':row.get('error'),'expected':parsed_expected})
    with tempfile.TemporaryDirectory(prefix='tuning-audit-') as tmp:
        directory=Path(tmp); live.make_node(source,directory)
        program=directory/'verify.mjs'; code=program.read_text(encoding='utf-8')
        marker='console.log(JSON.stringify({request_comparisons:'
        index=code.index(marker)
        code=code[:index]+'''const outcomes=input.responses.map(item=>{const got=parseSpamResponse(item.raw,item.categories,85);return {id:item.id,status:got.status,verdict:got.verdict,cost:got.cost};});\n'''+code[index:]
        code=code.replace('invalid_response_comparisons:invalidResponses,mismatch_count:', 'invalid_response_comparisons:invalidResponses,outcomes,mismatch_count:')
        program.write_text(code,encoding='utf-8')
        payload={'requests':inputs,'responses':responses,'headers':{k:v for k,v in meta['headers'].items() if k.lower()!='content-type'}}
        (directory/'input.json').write_text(json.dumps(payload,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        process=subprocess.run(['node',str(program),str(directory/'input.json')],capture_output=True,text=True,timeout=120)
        if process.returncode: raise ValueError('production replay failed: '+process.stderr[:500])
        native=json.loads(process.stdout)
        # Analyze a private copy: the audit never rewrites the phase's summary or raw logs.
        copied=directory/'phase'; shutil.copytree(out,copied)
        analyzed=e.analyze(copied)
    native_by_key={tuple(json.loads(item['id'])):item for item in native['outcomes']}
    metric_mismatches=[]; metrics={}
    for model in meta['models']:
        metrics[model]={}
        for variant in meta['model_variants'][model]:
            selected=[(key,row) for key,row in rows.items() if key[0]==model and key[1]==variant]
            counts=Counter(); costs=0; unknown=0; upstream_unknown=0; byok_unknown=0; lat=[]
            for key,row in selected:
                c=cases_by_id[key[2]]; parsed=native_by_key.get(key); raw=row.get('raw'); lat.append(row['latency_ms'])
                ok=row['http_status']==200 and not row.get('error') and parsed is not None and parsed['status']!='invalid_response'
                if not ok: counts['errors']+=1
                if row['latency_ms']>=4000: counts['late']+=1
                if ok and parsed['verdict']=='violation':
                    kind='tp' if c['expected'] else 'fp'; counts['returned_'+kind]+=1
                    if row['latency_ms']<4000: counts['timely_'+kind]+=1
                usage=raw.get('usage') if isinstance(raw,dict) else None
                returned=usage.get('cost') if isinstance(usage,dict) else None
                if not e.s.numeric(returned) or returned<0: returned=None
                byok=isinstance(usage,dict) and usage.get('is_byok') is True
                details=usage.get('cost_details') if isinstance(usage,dict) else None
                upstream=details.get('upstream_inference_cost') if isinstance(details,dict) and byok else None
                if not e.s.numeric(upstream) or upstream<0: upstream=None
                costs+=(returned or 0)+(upstream or 0); unknown+=returned is None; upstream_unknown+=byok and upstream is None
                byok_unknown+=not (isinstance(usage,dict) and type(usage.get('is_byok')) is bool)
            result={'observed':len(selected),'scheduled':sum(1 for key in expected if key[0]==model and key[1]==variant),'returned_tp':counts['returned_tp'],'returned_fp':counts['returned_fp'],'timely_tp':counts['timely_tp'],'timely_fp':counts['timely_fp'],'errors':counts['errors'],'late':counts['late'],'latency_p95_ms':e.s.percentile(lat,.95),'known_cost_usd':costs,'unknown_returned_cost_attempts':unknown,'unknown_byok_upstream_attempts':upstream_unknown,'unknown_byok_status_attempts':byok_unknown}
            summary=analyzed['models'][model][variant]['overall']
            for name,value in result.items():
                if name=='late': continue  # analyzer exposes p95, but no late count
                other=summary[name]
                if isinstance(value,float) and isinstance(other,(int,float)):
                    equal=abs(value-other)<1e-9
                else: equal=value==other
                if not equal: metric_mismatches.append({'model':model,'variant':variant,'metric':name,'native':value,'analyzer':other})
            metrics[model][variant]=result
    missing=expected-set(rows); total_mismatches=len(mismatches)+native['mismatch_count']+len(metric_mismatches)
    mismatches.extend(native['mismatches']); mismatches.extend(metric_mismatches)
    return {'schema_version':1,'phase':meta['phase'],'complete':not missing,'expected_rows':len(expected),'observed_rows':len(rows),'missing_rows':len(missing),'missing_examples':[list(k) for k in sorted(missing)[:100]],'http_errors':dict(http_errors),'http_failure_messages':dict(http_failure_messages),'http_refusals':refusals,'successful_http_responses':successful,'production_source_hashes':snapshot['files'],'production_snapshot_sha256':e.sha(source/'snapshot.json'),'source_hashes':meta['source_hashes'],'meta_sha256':e.sha(out/'meta.json'),'requests_file_sha256':e.sha(out/'requests.json'),'request_bodies_sha256':meta['requests_sha256'],'intents_sha256':file_hash(out/'intents.jsonl'),'raw_sha256':file_hash(out/'raw.jsonl'),'baseline_request_comparisons':native['request_comparisons'],'response_comparisons':native['response_comparisons'],'invalid_response_comparisons':native['invalid_response_comparisons'],'native_mismatch_count':native['mismatch_count'],'metric_mismatch_count':len(metric_mismatches),'mismatch_count':total_mismatches,'mismatches':mismatches[:100],'metrics':metrics}


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--out',type=Path,required=True); parser.add_argument('--production-source',type=Path)
    args=parser.parse_args()
    try:
        report=audit(args.out,args.production_source)
        path=args.out/'audit.json'; temp=args.out/'audit.json.tmp'
        temp.write_text(json.dumps(report,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8'); temp.replace(path)
        print(json.dumps({k:report[k] for k in ('complete','expected_rows','observed_rows','mismatch_count','http_errors')}))
        return 0 if report['complete'] and not report['mismatch_count'] else 1
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as exc:
        print('error: '+str(exc),file=sys.stderr); return 2

if __name__=='__main__': sys.exit(main())
