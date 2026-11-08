import json,re,pathlib
P=pathlib.Path(__file__).parent
POLICY=json.loads((P/'policy.json').read_text())
def invited(context):
    # Exact invitation grammar from spam.ts, Unicode/case insensitive.
    deny=r"\b(?:don't|dont|do not|never|stop|no|not|prohibido|prohibida|nunca)\b"
    yes=r'\b(?:share|post|drop)\s+(?:your\s+)?(?:channel|twitch|social)(?:\s+links?)?\b|\b(?:comparte|compartan|compartid|publica|publiquen|deja|dejen)\s+(?:(?:tu|tus|su|sus|vuestro|vuestros)\s+)?(?:canal|canales|redes|enlaces)\b'
    return any(c.get('isBroadcaster') is True and not re.search(deny,c['message'],re.I) and re.search(yes,c['message'],re.I) for c in context)

def request_for(c,model):
    invitation=invited(c['context']); definitions=[]; qs={}
    for category in c['categories']:
        policy="Sharing the author's channel/social links or asking for follows is explicitly permitted by a verified broadcaster invitation in this conversation. The described unwanted self-promotion is absent." if category=='self_promotion' and invitation else POLICY['definitions'][category]
        definitions.append(policy)
        qs[category]={'type':'noul','instructions':POLICY['instructions'],'criteria':{'true':policy,'false':'The described behavior is absent from the final message.'}}
    qs['unsafe']={'type':'noul','instructions':POLICY['instructions'],'criteria':{'true':'The final message clearly exhibits ANY of these selected unwanted behaviors. Each behavior is independently prohibited:\n'+'\n'.join(definitions)+'\nOther behaviors are outside this check and are permitted.','false':'None of the selected unwanted behaviors is present in the final message.'}}
    return {'model':model,'questions':qs,'state':{'input':[{'role':'user','content':json.dumps(m,ensure_ascii=False,separators=(',',':'))} for m in c['context']],'output':{'role':'assistant','content':c['message']}}}

def verdict(scores,threshold=.85):
    highest=max(v for k,v in scores.items() if k!='unsafe'); safe=1-scores['unsafe']
    return 'allow' if safe>highest else 'violation' if safe<highest and highest>=threshold else 'uncertain'
