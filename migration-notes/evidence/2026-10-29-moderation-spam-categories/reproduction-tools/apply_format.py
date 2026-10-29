import hashlib,json,shutil,sys
from pathlib import Path
state=Path(sys.argv[1]); baseline=json.loads((state/'snapshot.json').read_text());count=0
for path in (state/'format-copy/dimabot').rglob('*.rs'):
 relative=path.relative_to(state/'format-copy');target=Path('/root/saas-rust')/relative
 if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==baseline.get(str(relative)) and target.read_bytes()!=path.read_bytes():
  shutil.copy2(path,target);count+=1
print('Applied isolated formatting:',count,'unchanged source/test files')
