import pathlib,hashlib,json,os,re,stat,importlib.util
s=pathlib.Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
spec=importlib.util.spec_from_file_location('validate',pathlib.Path(__file__).with_name('validate.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
out=s/'artifacts/lossless-json-document/cache-maintenance.json';assert not out.exists()
pattern=re.compile(r'(lossless_json_document|lossless_json_view|ai_usage_receipt_parser|ai_usage_ledger_queries|timer_chat_schema_types|additional_schemas|twitch_functions|delete_twitch_message)-[0-9a-f]{16}')
def save(a):
 temporary=out.with_suffix('.tmp');temporary.write_text(json.dumps(a,indent=2)+'\n');os.replace(temporary,out)
with v.ops.rust_build_lock():
 assert not v.docker('ps','-q','--filter','label=saas.task=full-rust-5ad445d87cdc')
 assert not v.docker('ps','-q','--filter','label=saas.task=full-rust-b229df0d577f')
 audit={'scope':'completed task-owned private debug test executables only; no shared caches, source, release artifacts or production resources','cacheBefore':v.cache_bytes(s),'removed':[],'status':'planning'};save(audit);freed=0
 for p in sorted((s/'target/debug/deps').iterdir(),key=lambda p:p.stat().st_mtime):
  if not pattern.fullmatch(p.name):continue
  st=p.lstat()
  if not stat.S_ISREG(st.st_mode) or p.is_symlink() or not (st.st_mode&0o111):continue
  with p.open('rb') as f:
   if f.read(4)!=b'\x7fELF':continue
  if freed>=500*1024**2:break
  raw=p.read_bytes();entry={'path':str(p.relative_to(s)),'bytes':st.st_size,'allocatedBytes':st.st_blocks*512,'sha256':hashlib.sha256(raw).hexdigest(),'removed':False};audit['removed'].append(entry);audit['status']='removing';save(audit)
  check=p.lstat();assert (check.st_ino,check.st_size,check.st_mtime_ns)==(st.st_ino,st.st_size,st.st_mtime_ns)
  p.unlink();entry['removed']=True;freed+=entry['allocatedBytes'];audit['freedAllocatedBytes']=freed;save(audit)
 audit['cacheAfter']=v.cache_bytes(s);audit['status']='complete';save(audit)
 print(json.dumps({k:v for k,v in audit.items() if k!='removed'}));print('Removed completed test executables:',len(audit['removed']))
