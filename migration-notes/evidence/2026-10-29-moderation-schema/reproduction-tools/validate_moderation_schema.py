import argparse, contextlib, hashlib, importlib.util, json, os, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path

ROOT=Path('/root/saas-rust'); BASE=Path('/root/.local/state'); GIB=1024**3
RUST_IMAGE='sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9'
NODE_IMAGE='sha256:a001f865dc47694124ef59a1f71cdf80e6214f64613f4e5b4d891088f71dca82'
MONGO_IMAGE='sha256:9690b268c50317b2988a7f84f514a2cdcf4de6836e12c295b48f3a203731fce1'
REDIS_IMAGE='sha256:18afa43e911f1dff18c7d1eb452361876d9702bb1cdff5c5d75c69617a4065c9'
CACHE=BASE/'saas-ops-rust-cache/v1/f843c5789b178ac5748e2e4bf398bf0bd55b1811b92b82b6189e934bb09c900d'

def cmd(args): return subprocess.check_output([str(a) for a in args],text=True).strip()
def docker(*args):return cmd(['docker',*args])
def hashes(root):return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}
def production():
 ids=docker('ps','-q').split()
 objects=json.loads(docker('inspect',*ids)) if ids else []
 return {o['Name']:{'id':o['Id'],'image':o['Image'],'started':o['State']['StartedAt'],'mounts':o['Mounts'],'config_image':o['Config']['Image'],'entrypoint':o['Config']['Entrypoint'],'command':o['Config']['Cmd'],'compose':{k:v for k,v in (o['Config'].get('Labels') or {}).items() if k.startswith('com.docker.compose.')}} for o in objects if not (o['Config'].get('Labels') or {}).get('saas.task','').startswith('full-rust-')}
def cache_bytes(state):
 total=0
 for root in [state/'cargo',state/'target']:
  for directory,_,files in os.walk(root):
   for name in files:
    try:total+=(Path(directory)/name).lstat().st_blocks*512
    except FileNotFoundError:pass
 return total

spec=importlib.util.spec_from_file_location('full_migration_ops',ROOT/'ops/saas_ops.py')
mod=importlib.util.module_from_spec(spec);sys.modules[spec.name]=mod;spec.loader.exec_module(mod)
ops=mod.Ops(root=ROOT)

def prepare(state):
 if state is None:
  state=Path(tempfile.mkdtemp(prefix='rust-full-migration-20261028-',dir=BASE))
  (state/'artifacts').mkdir();(state/'production-before.json').write_text(json.dumps(production(),indent=2)+'\n')
  (state/'baseline-commit').write_text(cmd(['git','-C',ROOT,'rev-parse','HEAD'])+'\n')
 for dirname in ['source','format-copy']:
  if (state/dirname).exists():shutil.rmtree(state/dirname)
 project=state/'source/dimabot';project.mkdir(parents=True)
 for name in ['Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json']:
  shutil.copy2(ROOT/'dimabot'/name,project/name)
 for name in ['src','tests','examples']:
  shutil.copytree(ROOT/'dimabot'/name,project/name,ignore=shutil.ignore_patterns('.env*','node_modules','target','__pycache__'))
 (project/'node_modules').mkdir()
 # Archives are source references only; no application/config/data is included.
 archive=ROOT/'archives/dimabot-typescript/2026-10-28'
 if archive.exists():shutil.copytree(archive,state/'source/archives/dimabot-typescript/2026-10-28')
 notes=state/'source/migration-notes';notes.mkdir()
 for name in ['dimabot-ts-baseline-2026-10-28.json','dimabot-dependency-matrix-2026-10-28.mjs']:
  shutil.copy2(ROOT/'migration-notes'/name,notes/name)
 # Exact accepted production-source references captured before this validation.
 # These are immutable evidence, never a live production mount or test target.
 external=Path('migration-notes/evidence/2026-10-29-tts-tag-types/external-source-api-bc6455f1979f')
 shutil.copytree(ROOT/external,state/'source'/external)
 (state/'snapshot.json').write_text(json.dumps(hashes(state/'source'),indent=2)+'\n')
 shutil.copy2(__file__,state/'validate.py')
 print(state,flush=True)

def run(state,phase,script):
 assert state.parent==BASE and state.name.startswith('rust-full-migration-20261028-') and state.resolve()==state
 ops.state=state
 initial=json.loads((state/'production-before.json').read_text())
 assert production()==initial,'Production identity/configuration changed since task start: stop without repair'
 source=state/'source'
 if phase=='format':
  source=state/'format-copy';shutil.copytree(state/'source',source)
 name='full-rust-'+hashlib.sha256((str(state)+phase).encode()).hexdigest()[:12]
 is_rust=phase in ['compiler','compiler-fixtures','format']
 fixtures=phase in ['compiler-fixtures','node-fixtures']
 network=name+'-network';dependencies=[];network_created=False
 receipt={'phase':phase,'success':False,'steps':[],'limits':{'cpus':6,'memory':4*GIB,'memory_swap':4*GIB,'pids':256,'cargo_jobs':2 if is_rust else None}}
 label=phase+'-'+str(time.time_ns());logpath=state/'artifacts'/(label+'.log')
 receipt['source_hashes']=json.loads((state/'snapshot.json').read_text())
 receipt['source_tree_sha256']=hashlib.sha256(json.dumps(receipt['source_hashes'],sort_keys=True).encode()).hexdigest()
 receipt['toolchain_image']=RUST_IMAGE if is_rust else NODE_IMAGE
 created=False;started=time.monotonic()
 lock=ops.rust_build_lock() if is_rust else contextlib.nullcontext()
 with lock:
  if is_rust:
   assert not docker('ps','-q','--filter','label='+mod.OWNER+'.rust-build=true'),'another capped compiler is running'
  receipt['headroom_start']=ops.rust_headroom(starting=True,memory_gib=4)
  receipt['minimum_available_bytes']=receipt['headroom_start']['mem_available_bytes']
  if is_rust:
   if not (state/'cargo').exists():
    for part in ['cargo','target']:
     subprocess.run(['cp','-a','--reflink=auto',str(CACHE/part),str(state/part)],check=True)
   receipt['peak_cache_bytes']=cache_bytes(state);assert receipt['peak_cache_bytes']<=8*GIB
  try:
   if fixtures:
    docker('network','create','--internal','--label','saas.task='+name,network);network_created=True
    for kind,image,alias,memory,pids,command in [
      ('mongo',MONGO_IMAGE,'moderation-schema-mongo-taskowned','768m','128',['mongod','--bind_ip_all','--wiredTigerCacheSizeGB','0.25']),
]:
     resource=name+'-'+kind
     docker('create','--name',resource,'--label','saas.task='+name,'--network',network,'--network-alias',alias,'--cpus=1','--memory='+memory,'--memory-swap='+memory,'--pids-limit='+pids,'--security-opt=no-new-privileges',image,*command)
     dependencies.append(resource);docker('start',resource)
     probe=['mongosh','--quiet','--eval','db.adminCommand({ping:1}).ok'] if kind=='mongo' else ['redis-cli','PING']
     for attempt in range(60):
      ready=subprocess.run(['docker','exec',resource,*probe],capture_output=True,text=True)
      if ready.returncode==0 and ready.stdout.strip()==('1' if kind=='mongo' else 'PONG'):break
      ops.rust_headroom(memory_gib=4);time.sleep(.25)
     else:raise AssertionError('Task-owned '+kind+' readiness failed')
   initial_network='bridge' if is_rust else network if fixtures else 'none'
   args=['create','--name',name,'--label','saas.task='+name,'--cpus=6','--memory=4g','--memory-swap=4g','--pids-limit=256','--security-opt=no-new-privileges','--network='+initial_network,'--workdir=/source/dimabot','--mount',f'type=bind,src={source},dst=/source'+(',readonly' if phase in ['compiler','compiler-fixtures','inventory','node','node-fixtures'] else ''),'--mount',f'type=bind,src={state}/artifacts,dst=/artifacts','--mount',f'type=bind,src={Path(__file__).parent},dst=/task-tools,readonly']
   if fixtures:
    namespace=hashlib.sha256(name.encode()).hexdigest()[:12]
    fixture_env={'DIMA_RUST_TEST_RESOURCE_OWNER':'dimabot-migration','DIMA_TEST_MONGO_URI':'mongodb://moderation-schema-mongo-taskowned:27017','DIMA_TEST_REDIS_URL':'redis://keyword-redis:6379/','KEYWORD_FIXTURE_MONGO_URI':'mongodb://moderation-schema-mongo-taskowned:27017','KEYWORD_FIXTURE_REDIS_URL':'redis://keyword-redis:6379/','KEYWORD_FIXTURE_NAMESPACE':'keyword-fixture-'+namespace+':','APPLICATION_SCHEMAS_TEST_MONGO_URI':'mongodb://moderation-schema-mongo-taskowned:27017','APPLICATION_SCHEMAS_TEST_DATABASE':'rust_schema_fixture_'+namespace,'TZ':'UTC'}
    fixture_env.update({'ADDITIONAL_SCHEMAS_TEST_DATABASE':'rust_additional_schema_fixture_'+namespace,'TWITCH_FUNCTION_FIXTURE_MONGO_URI':'mongodb://moderation-schema-mongo-taskowned:27017','TWITCH_FUNCTION_FIXTURE_REDIS_URL':'redis://keyword-redis:6379/','TWITCH_FUNCTION_FIXTURE_DATABASE':'twitch_function_fixture_'+namespace})
    for key,value in fixture_env.items():args+=['--env',key+'='+value]
   if is_rust:
    args+=['--label',mod.OWNER+'.rust-build=true','--env=CARGO_BUILD_JOBS=2','--env=CARGO_HOME=/cargo-cache','--env=CARGO_TARGET_DIR=/target-cache','--env=CARGO_PROFILE_DEV_DEBUG=0','--env=CARGO_PROFILE_TEST_DEBUG=0','--env=CARGO_INCREMENTAL=0','--env=RUSTUP_TOOLCHAIN=1.99.1-x86_64-unknown-linux-musl']
    for part,dest in [('cargo','/cargo-cache'),('target','/target-cache')]:args+=['--mount',f'type=bind,src={state/part},dst={dest}']
    args+=['--entrypoint=sh',RUST_IMAGE,'-c','while :; do sleep 60; done']
   else:
    args+=['--mount',f'type=bind,src={ROOT}/dimabot/node_modules,dst=/source/dimabot/node_modules,readonly','--env=MIGRATION_BASELINE_COMMIT='+(state/'baseline-commit').read_text().strip(),'--entrypoint=sh',NODE_IMAGE,'-c','while :; do sleep 60; done']
   docker(*args);created=True
   obj=json.loads(docker('inspect',name))[0];limits=obj['HostConfig']
   assert (limits['NanoCpus'],limits['Memory'],limits['MemorySwap'],limits['PidsLimit'])==(6_000_000_000,4*GIB,4*GIB,256)
   assert obj['HostConfig']['NetworkMode']==initial_network
   docker('start',name);receipt['limits_verified']=True
   # Only dependency installation/download has a network. Test execution is disconnected.
   if is_rust:
    bootstrap='apk add --no-cache build-base python3 tzdata; apk info --who-owns /usr/share/zoneinfo/Etc/UTC; sha256sum /usr/share/zoneinfo/Etc/UTC /usr/share/zoneinfo/America/New_York /usr/share/zoneinfo/Europe/Berlin /usr/share/zoneinfo/Australia/Lord_Howe /usr/share/zoneinfo/Pacific/Apia; rustup component add rustfmt clippy; rustc -vV'
   else:bootstrap='node --version'
   def monitor():
    h=ops.rust_headroom(memory_gib=4);receipt['minimum_available_bytes']=min(receipt['minimum_available_bytes'],h['mem_available_bytes'])
    if is_rust:
     size=cache_bytes(state);receipt['peak_cache_bytes']=max(receipt['peak_cache_bytes'],size);assert size<=8*GIB,'Private compiler cache exceeded 8 GiB'
    assert time.monotonic()-started<3600,'Validation exceeded one hour'
   def step(title,code):
    print(json.dumps({'step':title,'log':str(logpath),'container':name}),flush=True);then=time.monotonic()
    with logpath.open('a') as log:
     process=subprocess.Popen(['docker','exec',name,'sh','-ceu',code],stdout=log,stderr=subprocess.STDOUT)
     try:
      check=0
      while process.poll() is None:
       if time.monotonic()>check:monitor();check=time.monotonic()+4
       time.sleep(.5)
      monitor();assert process.returncode==0,title+' failed; see '+str(logpath)
     finally:
      if process.poll() is None:docker('kill',name);process.wait(timeout=20)
    receipt['steps'].append({'name':title,'seconds':round(time.monotonic()-then,3),'exit_code':process.returncode})
   step('bootstrap',bootstrap)
   if is_rust:
    # Fetch uses the existing lockfile only; no dependency is added or upgraded.
    step('locked-fetch','cargo fetch --locked')
    docker('network','disconnect','bridge',name)
    if fixtures:docker('network','connect',network,name)
   step(phase,script)
   if phase in ['compiler','compiler-fixtures','inventory','node','node-fixtures']:assert hashes(state/'source')==json.loads((state/'snapshot.json').read_text()),'Frozen source changed'
   receipt['success']=True
  except BaseException as exc:
   receipt['error']=str(exc);raise
  finally:
   if created:
    obj=json.loads(docker('inspect',name))[0];assert obj['Config']['Labels']['saas.task']==name
    docker('rm','-f','--volumes',name)
   for resource in reversed(dependencies):
    obj=json.loads(docker('inspect',resource))[0];assert obj['Config']['Labels']['saas.task']==name
    docker('rm','-f','--volumes',resource)
   if network_created:
    obj=json.loads(docker('network','inspect',network))[0];assert obj['Labels']['saas.task']==name
    docker('network','rm',network)
   after=production();receipt['production_unchanged']=after==initial
   if not receipt['production_unchanged']:receipt['success']=False
   receipt['elapsed_seconds']=round(time.monotonic()-started,3)
   (state/'artifacts'/(label+'-receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n')
   print(json.dumps({key:value for key,value in receipt.items() if key!='source_hashes'}),flush=True)
   assert receipt['production_unchanged'],'Production changed unexpectedly; stop without repair'

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('phase',choices=['prepare','inventory','node','node-fixtures','compiler','compiler-fixtures','format']);p.add_argument('state',type=Path,nargs='?');p.add_argument('--script',default='true');a=p.parse_args()
 if a.phase=='prepare':prepare(a.state)
 else:run(a.state,a.phase,a.script)
