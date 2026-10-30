import subprocess,sys
from pathlib import Path
p=Path(__file__).parent
subprocess.run([sys.executable,str(p/'freeze_redis_application.py')],check=True)
