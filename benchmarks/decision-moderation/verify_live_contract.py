#!/usr/bin/env python3
"""Offline parity replay of a run against its captured compiled production JavaScript."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def checked_child(root, relative):
    path=(root/relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('invalid or missing pinned file: '+str(relative))
    return path


def verify_inputs(run):
    source=run/'production-source'
    snapshot=load(source/'snapshot.json')
    required={'spam_categories.js','semantic.js','spam.js','advanced.js','app_attribution.util.js'}
    if not required <= set(snapshot['files']): raise ValueError('production snapshot missing required source hashes')
    for name, expected in snapshot['files'].items():
        if sha(checked_child(source,name)) != expected: raise ValueError('production source hash mismatch: '+name)
    frozen=run/'frozen-inputs'; meta=load(run/'run-meta.json')
    if sha(frozen/'manifest.json') != meta['manifest_sha256']: raise ValueError('frozen manifest hash mismatch')
    manifest=load(frozen/'manifest.json')
    required_inputs={'suite.py','legacy/cases.json','legacy/supplemental-cases.json','legacy/policy.json','legacy/native_contract.py','scenarios.json','obfuscation.json'}
    if not required_inputs <= set(manifest['files']): raise ValueError('frozen manifest missing required inputs')
    for name, expected in manifest['files'].items():
        if sha(checked_child(frozen,name)) != expected: raise ValueError('frozen file hash mismatch: '+name)
    for name, statement in [('advanced.js',"export const SEMANTIC_MODEL = 'respan/span-01-lite';"),
                            ('advanced.js','export const ALLOW_THRESHOLD = 0.1;'),
                            ('spam.js',"export const SPAM_RULE_ID = 'builtin-spam-protection';"),
                            ('spam_categories.js','export const DEFAULT_SPAM_THRESHOLD = 85;')]:
        if statement not in (source/name).read_text(encoding='utf-8'): raise ValueError('production constant mismatch: '+name)
    return snapshot,meta,frozen


def load_frozen_suite(frozen):
    spec=importlib.util.spec_from_file_location('verified_frozen_suite',frozen/'suite.py')
    suite=importlib.util.module_from_spec(spec); spec.loader.exec_module(suite)
    return suite


def read_complete_lines(path):
    if not path.exists(): return [],False
    data=path.read_bytes()
    partial=bool(data and not data.endswith(b'\n'))
    if partial: data=data[:data.rfind(b'\n')+1] if b'\n' in data else b''
    return [json.loads(line) for line in data.splitlines() if line.strip()], partial


def make_node(source, directory):
    categories=(source/'spam_categories.js').read_text(encoding='utf-8')
    headers=(source/'app_attribution.util.js').read_text(encoding='utf-8')
    # Remove only source map directives, preserving the full executable modules.
    for name, text in [('categories.mjs',categories),('headers.mjs',headers)]:
        (directory/name).write_text(re.sub(r'^//# sourceMappingURL=.*$', '', text, flags=re.M),encoding='utf-8')
    spam=(source/'spam.js').read_text(encoding='utf-8')
    semantic=(source/'semantic.js').read_text(encoding='utf-8')
    invitation=spam[spam.index('export function broadcasterInvitedPromotion('):spam.index('export function spamRuleForContext(')]
    core=semantic[semantic.index('export function fallbackResult('):semantic.index('export async function evaluateSemanticDecision(')]
    program="""import fs from 'node:fs';
import {categoryQuestions, DEFAULT_SPAM_THRESHOLD} from './categories.mjs';
import {OPENROUTER_APP_HEADERS} from './headers.mjs';
const SEMANTIC_MODEL='respan/span-01-lite', ALLOW_THRESHOLD=0.1, SPAM_RULE_ID='builtin-spam-protection';
"""+invitation+'\n'+core+"""
const input=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mismatches=[]; let responseComparisons=0, invalidResponses=0;
function record(kind,id) { mismatches.push({kind,id}); }
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])]));
  return v;
}
function equal(a,b) { return JSON.stringify(canon(a))===JSON.stringify(canon(b)); }
if (!equal(OPENROUTER_APP_HEADERS,input.headers)) record('headers','production');
for (const item of input.requests) {
  const c=item.case;
  const decision={rule:{id:SPAM_RULE_ID,semantic:{categories:c.categories,broadcasterInvitation:broadcasterInvitedPromotion(c.context),examples:[]}},messageText:c.message,username:'synthetic',context:c.context,matches:[]};
  if (!equal(semanticRequest(decision,item.model),item.expected)) record('request',item.id);
}
for (const item of input.responses) {
  const got=parseSpamResponse(item.raw,item.categories,85);
  responseComparisons++;
  if (item.expected === null) {
    invalidResponses++;
    if (got.status !== 'invalid_response') record('invalid_response',item.id);
    continue;
  }
  const expected=item.expected;
  const nativeScores={}; for (const c of item.categories) nativeScores[c]=got.scores?.[c];
  nativeScores.safe=got.scores?.safe; nativeScores.violation=got.scores?.violation;
  if (got.verdict!==expected.verdict || got.cost!==expected.cost || got.inputTokens!==expected.inputTokens || !equal(nativeScores,expected.scores)) record('response',item.id);
  const timely=got.verdict==='violation' && item.latency_ms<4000 && !item.error;
  if (timely!==expected.timely) record('timing',item.id);
}
console.log(JSON.stringify({request_comparisons:input.requests.length,response_comparisons:responseComparisons,invalid_response_comparisons:invalidResponses,mismatch_count:mismatches.length,mismatches:mismatches.slice(0,100)}));
"""
    (directory/'verify.mjs').write_text(program,encoding='utf-8')


def replay(run):
    snapshot,meta,frozen=verify_inputs(run)
    suite=load_frozen_suite(frozen)
    cases={name:{c['id']:(c,phase) for c,phase in suite.cases_for(name)} for name in ('legacy','expanded','obfuscation')}
    models=meta['models']; repeats=meta['repeats']
    if len(models)!=7 or len(set(models))!=7 or sum(len(v) for v in cases.values())!=507:
        raise ValueError('unexpected frozen model or case grid')
    requests=[]; cache={}
    for name,group in cases.items():
        for cid,(case,phase) in group.items():
            for model in models:
                req=suite.request(case,model); cache[(name,cid,model)]=req
                requests.append({'id':name+':'+cid+':'+model,'case':{k:case[k] for k in ('message','context','categories')},'model':model,'expected':req})
    rows,partial=read_complete_lines(run/'raw.jsonl')
    seen=set(); responses=[]; hash_errors=[]; nonenforcing=0; main_count=0; smoke_count=0
    for row in rows:
        if not isinstance(row,dict): raise ValueError('invalid raw row')
        name=row['suite']; model=row['requested_model']; cid=row['case']; rnd=row['round']
        source_name='legacy' if name=='smoke' else name
        if source_name not in cases or cid not in cases[source_name] or model not in models or type(rnd) is not int:
            raise ValueError('raw row references unknown case or model')
        case,phase=cases[source_name][cid]
        if (name=='smoke' and (rnd!=1 or row.get('phase')!='smoke' or case['expected'])) or (name!='smoke' and (not 1<=rnd<=repeats[name] or row.get('phase')!=phase)):
            raise ValueError('raw row outside planned grid')
        key=(name,cid,model,rnd)
        if key in seen: raise ValueError('duplicate raw grid row')
        seen.add(key)
        if name=='smoke': smoke_count+=1
        else: main_count+=1
        req=cache[(source_name,cid,model)]; expected_hash=suite.digest(req)
        wire_hash=suite.digest({**req,'user':meta['transport_user']})
        if row.get('request_sha256')!=expected_hash or row.get('wire_request_sha256')!=wire_hash:
            hash_errors.append({'kind':'request_hash','id':':'.join(map(str,key))})
        latency=row.get('latency_ms')
        if not suite.numeric(latency) or latency < 0: raise ValueError('invalid response latency')
        if row.get('http_status')!=200:
            nonenforcing+=1
            continue
        raw=row.get('raw'); parsed=suite.score(raw,case['categories']); expected=None
        if parsed is not None:
            scores={k:raw['answers'][k]['noul'] for k in case['categories']}
            scores['safe']=1-raw['answers']['unsafe']['noul']; scores['violation']=max(scores[k] for k in case['categories'])
            expected={'verdict':parsed[0],'cost':parsed[1],'inputTokens':raw['usage']['input_tokens'], 'scores':scores,
                      'timely':parsed[0]=='violation' and latency<4000 and not row.get('error')}
        if row.get('error') or parsed is None: nonenforcing+=1
        responses.append({'id':':'.join(map(str,key)),'raw':raw,'categories':case['categories'],'latency_ms':latency,'error':row.get('error'),'expected':expected})
    expected_main=sum(len(cases[k])*repeats[k] for k in cases)*len(models)
    header_expected={k:v for k,v in suite.HEADERS.items() if k.lower()!='content-type'}
    with tempfile.TemporaryDirectory(prefix='moderation-parity-') as tmp:
        directory=Path(tmp); make_node(run/'production-source',directory)
        input_path=directory/'input.json'
        input_path.write_text(json.dumps({'requests':requests,'responses':responses,'headers':header_expected},ensure_ascii=False,allow_nan=False),encoding='utf-8')
        process=subprocess.run(['node',str(directory/'verify.mjs'),str(input_path)],capture_output=True,text=True,timeout=120)
        if process.returncode: raise ValueError('production JS parity process failed: '+process.stderr[:500])
        native=json.loads(process.stdout)
    mismatches=hash_errors+native['mismatches']
    return {'production_source_hashes':snapshot['files'],'frozen_manifest_sha256':meta['manifest_sha256'],
            'request_comparisons':native['request_comparisons'],'response_comparisons':native['response_comparisons'],
            'invalid_response_comparisons':native['invalid_response_comparisons'],
            'raw_rows':len(rows),'smoke_rows':smoke_count,'main_rows':main_count,'expected_main_rows':expected_main,
            'full_grid_complete':main_count==expected_main and not partial,'partial_trailing_raw_line':partial,
            'nonenforcing_rows':nonenforcing,'mismatch_count':len(hash_errors)+native['mismatch_count'],
            'mismatches':mismatches[:100], 'coverage_note':'Only responses recorded at the time of this snapshot were replayed; an incomplete grid is not a complete benchmark.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,help='default: RUN_DIR/native-verification.json')
    args=parser.parse_args()
    try:
        report=replay(args.run_dir.resolve())
        output=args.output or args.run_dir/'native-verification.json'
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({k:v for k,v in report.items() if k!='mismatches'},ensure_ascii=False))
        return 1 if report['mismatch_count'] else 0
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as exc:
        print('error: '+str(exc),file=sys.stderr)
        return 2


if __name__=='__main__': sys.exit(main())
