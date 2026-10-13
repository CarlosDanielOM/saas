#!/usr/bin/env python3
"""First-install procedure for the new analytics service; never changes database Compose.

verify SOURCE RECEIPT builds and runs the exact image on disposable dependencies.
install RECEIPT provisions only analytics roles/database and installs that tested image.
Existing analytics releases use saas-ops target analytics after bootstrap.
"""
import argparse, hashlib, json, os, secrets, shutil, subprocess, tempfile, time, uuid
from pathlib import Path
from urllib.parse import urlparse, quote

LABEL='io.domdimabot.analytics-bootstrap'

def run(args, data=None):
    result=subprocess.run([str(x) for x in args],input=data,text=True,capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1] if len(args)>1 else ""} failed (exit {result.returncode}); output withheld because it may contain credentials')
    return result.stdout.strip()

def docker(*args,data=None):return run(['docker','--host','unix:///var/run/docker.sock',*args],data)
def inspect(kind,name):return json.loads(docker(kind,'inspect',name))[0]
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def image_digest(source):
    value=hashlib.sha256()
    for path in sorted(Path(source).rglob('*')):
        if path.is_file() and not any(p in ['node_modules','.git'] or p.startswith('.env') for p in path.relative_to(source).parts):
            value.update(str(path.relative_to(source)).encode());value.update(path.read_bytes())
    return value.hexdigest()
def save(path,data):
    path=Path(path);path.write_text(json.dumps(data,indent=2)+'\n');path.chmod(0o600)
def wait_ready(name):
    for _ in range(60):
        state=inspect('container',name)
        if not state['State']['Running']:raise RuntimeError('Candidate exited; inspect its private log')
        try:
            docker('exec',name,'node','-e',"fetch('http://127.0.0.1:3210/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))");return
        except RuntimeError:time.sleep(1)
    raise RuntimeError('Candidate readiness deadline exceeded')

def verify(source,receipt):
    source=Path(source).resolve();rid=uuid.uuid4().hex[:12];prefix='analytics-test-'+rid;resources=[]
    assert (source/'package-lock.json').exists()
    record={'run':rid,'source':str(source),'source_digest':image_digest(source),'status':'building'};save(receipt,record)
    try:
        with tempfile.TemporaryDirectory(prefix='analytics-build-') as directory:
            snapshot=Path(directory)/'source';shutil.copytree(source,snapshot,ignore=shutil.ignore_patterns('node_modules','.env','.env.*'))
            result=subprocess.run(['docker','--host','unix:///var/run/docker.sock','build','-t','dima-analytics-candidate:'+rid,str(snapshot)],capture_output=True,text=True)
            log=Path(str(receipt)+'.build.log');log.write_text(result.stdout+result.stderr);log.chmod(0o600)
            if result.returncode:raise RuntimeError('Analytics build failed; see '+str(log))
        record['image']=inspect('image','dima-analytics-candidate:'+rid)['Id'];save(receipt,record)
        net=prefix+'-net';docker('network','create','--internal','--label',LABEL+'='+rid,net);resources.append(('network',net))
        for name,image,alias,env,command in [
            ('pg','pgvector/pgvector:0.8.1-pg17','postgres',{'POSTGRES_HOST_AUTH_METHOD':'trust','POSTGRES_DB':'observability_test'},[]),
            ('redis','ghcr.io/dragonflydb/dragonfly:latest','redis',{},['--logtostderr','--proactor_threads=1'])]:
            name=prefix+'-'+name;image=inspect('image',image)['Id']
            args=['run','-d','--pull=never','--name',name,'--label',LABEL+'='+rid,'--network',net,'--network-alias',alias,'--memory','512m','--cpus','1','--pids-limit','128','--security-opt','no-new-privileges']
            for key,value in env.items():args+=['--env',key+'='+value]
            docker(*args,image,*command);resources.append(('container',name))
        for _ in range(30):
            try:docker('exec',prefix+'-pg','pg_isready','-U','postgres');break
            except RuntimeError:time.sleep(1)
        app=prefix+'-app'
        env={'DATABASE_URL':'postgres://postgres@postgres:5432/observability_test','REDIS_URL':'redis://redis:6379','OWNER_TWITCH_ID':'1','COLLECTORS_DISABLED':'true','ANALYTICS_TEST':'1','ANALYTICS_TEST_URL':'http://127.0.0.1:3210'}
        args=['run','-d','--name',app,'--label',LABEL+'='+rid,'--network',net,'--memory','512m','--cpus','1','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--tmpfs','/tmp:size=16m']
        for key,value in env.items():args+=['--env',key+'='+value]
        docker(*args,record['image']);resources.append(('container',app));wait_ready(app)
        result=subprocess.run(['docker','--host','unix:///var/run/docker.sock','exec',app,'node','--test','--test-isolation=none','test/analytics.test.mjs'],text=True,capture_output=True)
        log=Path(str(receipt)+'.test.log');log.write_text(result.stdout+result.stderr);log.chmod(0o600)
        print(result.stdout,flush=True)
        if result.returncode:raise RuntimeError('Analytics integration checks failed; see '+str(log))
        wait_ready(app);record['status']='verified';record['verified_at']=time.time();save(receipt,record)
    finally:
        for kind,name in reversed(resources):
            obj=inspect(kind,name);labels=obj.get('Config',{}).get('Labels',{}) if kind=='container' else obj.get('Labels',{})
            if labels.get(LABEL)!=rid:raise RuntimeError('Test resource ownership mismatch')
            if kind=='container':
                log=Path(str(receipt)+'.'+name+'.log');log.write_text(docker('logs','--tail','100',obj['Id']));log.chmod(0o600)
                docker('rm','-f','-v',obj['Id'])
            else:docker('network','rm',obj['Id'])
        record['tests_cleaned']=True;save(receipt,record)
    print('Verified candidate '+record['image']+'; disposable resources removed',flush=True)

def install(receipt):
    record=json.loads(Path(receipt).read_text());project=Path('/root/saas/dima-analytics')
    assert record['status']=='verified' and record.get('tests_cleaned')
    assert record['source_digest']==image_digest(project),'Install only the exact verified project files'
    assert inspect('image',record['image'])['Id']==record['image']
    names=docker('ps','-a','--format','{{.Names}}').splitlines();assert 'dima-analytics' not in names,'Existing releases must use saas-ops'
    database_compose=Path('/root/databases/docker-compose.yaml');before=digest(database_compose)
    pg=inspect('container','postgres');assert pg['Config']['Labels']['com.docker.compose.project']=='databases'
    api=inspect('container','dima-server');api_env=dict(x.split('=',1) for x in api['Config']['Env'] if '=' in x)
    pg_env=dict(x.split('=',1) for x in pg['Config']['Env'] if '=' in x);pguser=pg_env.get('POSTGRES_USER','postgres')
    def sql(command):return docker('exec','-i','postgres','psql','-v','ON_ERROR_STOP=1','-U',pguser,'-d','postgres','-At',data=command)
    envpath=project/'.env'
    if not envpath.exists():
        assert sql("SELECT count(*) FROM pg_roles WHERE rolname='observability_app';")=='0','Preexisting analytics role requires review'
        assert sql("SELECT count(*) FROM pg_database WHERE datname='observability';")=='0','Preexisting analytics database requires review'
        password=secrets.token_hex(32);mongo_password=secrets.token_hex(32)
        mongo_uri=api_env['MONGO_URI'];parsed=urlparse(mongo_uri);database=parsed.path.strip('/') or 'dimabot'
        # Source credentials stay inside the API container. This creates only the
        # analytics monitor account, with read/cluster-monitor privileges.
        script="""const {MongoClient}=require('mongodb');(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);const u=await c.db().collection('users').findOne({accounts:{$elemMatch:{type:'twitch',name:'cdom201'}}},{projection:{accounts:1}});const a=u?.accounts.find(a=>a.type==='twitch'&&a.name==='cdom201');if(!a)throw Error('Owner missing');console.log(a.id);await c.close();})().catch(()=>process.exit(1));"""
        owner=docker('exec','dima-server','node','-e',script);assert owner.isdigit()
        mongo_url=f'mongodb://observability_monitor:{mongo_password}@{parsed.hostname}:{parsed.port or 27017}/{database}?authSource=admin'
        config={'DATABASE_URL':f'postgres://observability_app:{password}@postgres:5432/observability','REDIS_URL':f"redis://{api_env.get('DRAGONFLY_HOST','dragonfly')}:{api_env.get('DRAGONFLY_PORT','6379')}",'OWNER_TWITCH_ID':owner,'MONGO_METRICS_URI':mongo_url,'QDRANT_URL':f"http://{api_env['QDRANT_HOST']}:{api_env['QDRANT_PORT']}",'QDRANT_API_KEY':api_env['QDRANT_API_KEY']}
        # Write credentials before provisioning so a failed first install is recoverable.
        envpath.write_text(''.join(k+'='+v+'\n' for k,v in config.items()));envpath.chmod(0o600)
        record['provisioning_started']=True;save(receipt,record)
        sql(f"CREATE ROLE observability_app LOGIN PASSWORD '{password}';\nCREATE DATABASE observability OWNER observability_app;")
        monitor_script="const {MongoClient}=require('mongodb');(async()=>{const c=await MongoClient.connect(process.env.MONGO_URI);await c.db('admin').command({createUser:'observability_monitor',pwd:"+json.dumps(mongo_password)+",roles:[{role:'clusterMonitor',db:'admin'},{role:'read',db:"+json.dumps(database)+"}]});await c.close();})().catch(()=>process.exit(1));"
        docker('exec','-i','dima-server','node',data=monitor_script)
        record['provisioned']=True;save(receipt,record)
    else:assert record.get('provisioned'),'Partial provisioning requires inspection; do not rotate existing credentials automatically'
    assert digest(database_compose)==before
    config_hash=docker('compose','--project-directory',project,'--project-name','dima-analytics','-f',project/'docker-compose.yaml','config','--hash','analytics').split()
    assert len(config_hash)==2 and config_hash[0]=='analytics'
    override=Path(str(receipt)+'.compose.json');save(override,{'services':{'analytics':{'image':record['image'],'labels':{'io.domdimabot.saas-ops.config-hash':config_hash[1]}}}})
    docker('compose','--project-directory',project,'--project-name','dima-analytics','-f',project/'docker-compose.yaml','-f',override,'up','-d','--no-build','--no-deps','--pull','never','analytics')
    try:
        wait_ready('dima-analytics');assert inspect('container','dima-analytics')['Image']==record['image'];assert digest(database_compose)==before
    except Exception:
        candidate=inspect('container','dima-analytics')
        if candidate['Image']==record['image'] and candidate['Config']['Labels'].get('com.docker.compose.project')=='dima-analytics':
            docker('rm','-f',candidate['Id'])
        record['status']='install-failed';save(receipt,record)
        raise
    record['status']='installed';record['database_compose_digest']=before;save(receipt,record)
    print('Installed verified analytics image. Existing database Compose hash is unchanged.',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('verify');p.add_argument('source');p.add_argument('receipt')
    p=sub.add_parser('install');p.add_argument('receipt')
    args=parser.parse_args()
    if args.action=='verify':verify(args.source,args.receipt)
    else:install(args.receipt)
