import subprocess,sys
from pathlib import Path
p=Path(__file__).parent
subprocess.run([sys.executable,str(p/'freeze_credit_reader.py'),'--include-protocol'],check=True)
