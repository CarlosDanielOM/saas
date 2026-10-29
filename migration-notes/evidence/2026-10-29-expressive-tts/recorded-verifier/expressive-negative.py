import hashlib,json,os,pathlib,shutil,subprocess
source=pathlib.Path('/source/dimabot'); root=pathlib.Path('/tmp/expressive-negative')
root.mkdir()
for name in ['Cargo.toml','Cargo.lock','rust-toolchain.toml']: shutil.copy2(source/name,root/name)
for name in ['src','tests','examples']: shutil.copytree(source/name,root/name)
p=root/'src/utils/tts/mod.rs'; original=p.read_text(); start=original.index('pub fn filter_expressive_tts_tags_js('); body=original.index('{',start)+1
mutated=original[:body]+'\n    let replaced_surrogates = super::js_string::JsString::from(text.to_utf8_lossy());\n    let text = &replaced_surrogates;\n'+original[body:];p.write_text(mutated)
log=pathlib.Path('/artifacts/expressive-negative-control.log')
with log.open('w') as out:
 result=subprocess.run(['cargo','test','--manifest-path',str(root/'Cargo.toml'),'--locked','--offline','--no-default-features','--features','tts-utilities','--test','expressive_source','--','--ignored','--nocapture'],stdout=out,stderr=subprocess.STDOUT,env={**os.environ,"EXPRESSIVE_TTS_FIXTURE_DIR":"/artifacts/expressive-tts"})
text=log.read_text()
assert result.returncode!=0,'lossy negative control unexpectedly passed'
assert 'case surrogateBefore-piper-absent (filter)' in text,'negative control failed before the expected surrogate parity assertion'
record={'source':'dimabot/src/utils/tts/mod.rs','originalSha256':hashlib.sha256(original.encode()).hexdigest(),'mutatedSha256':hashlib.sha256(mutated.encode()).hexdigest(),'mutation':'replace unpaired UTF-16 units with U+FFFD at general filter entry; keep actual filter behavior otherwise','exitCode':result.returncode,'expectedFailureCase':'surrogateBefore-piper-absent (filter)','failedAtExpectedAssertion':True,'sourceSnapshotUnchanged':(source/'src/utils/tts/mod.rs').read_text()==original}
pathlib.Path('/artifacts/expressive-negative-control.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
