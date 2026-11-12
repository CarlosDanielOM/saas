#!/usr/bin/env python3
"""Local-only release/Node comparison; same fixture files, missing Docker socket, 15 s ticks."""
import json, os, pathlib, socket, subprocess, tempfile, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[3]
HZ = os.sysconf('SC_CLK_TCK')
def metrics(pid):
    status = pathlib.Path(f'/proc/{pid}/status').read_text()
    rss = int(next(l.split()[1] for l in status.splitlines() if l.startswith('VmRSS:')))
    fields = pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
    return {'rss_kib': rss, 'cpu_seconds': (int(fields[11]) + int(fields[12])) / HZ}
def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]
def main():
    procs = []
    with tempfile.TemporaryDirectory(prefix='hoststats-bench-') as temp:
        base = pathlib.Path(temp)
        fixture = json.loads((ROOT/'dima-rust/rig/scenarios/hoststats/routes.json').read_text())['seed']['files']
        for path, value in fixture.items():
            dst=base/path; dst.parent.mkdir(parents=True,exist_ok=True);dst.write_text(value['text'])
        try:
            results = {}
            for name, command, cwd in [
                ('node',['node','src/index.mjs'],ROOT/'dima-hoststats'),
                ('rust',[str(ROOT/'dima-rust/target/release/dima-hoststats')],ROOT)]:
                p = port()
                env = dict(os.environ, PORT=str(p), HOSTSTATS_PROC=str(base/'proc'), HOSTSTATS_NET_DEV=str(base/'net'), HOSTSTATS_DISK_PATH='/', DOCKER_SOCKET=str(base/'absent.sock'), HOSTSTATS_SAMPLE_MS='15000')
                started=time.monotonic(); proc=subprocess.Popen(command,cwd=cwd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);procs.append(proc)
                while True:
                    if proc.poll() is not None: raise RuntimeError(f'{name} exited')
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{p}/health',timeout=.2) as res:
                            assert res.status==200
                        break
                    except OSError:
                        if time.monotonic()-started>10: raise
                        time.sleep(.01)
                results[name]={'startup':metrics(proc.pid),'startup_seconds':time.monotonic()-started,'pid':proc.pid}
            start=time.monotonic()
            for minute in range(1,6):
                time.sleep(max(0,start+60*minute-time.monotonic()))
                print(f'{minute} minute(s) sampled',flush=True)
            for name, result in results.items():
                result['after_300s']=metrics(result.pop('pid'))
                result['sampling_cpu_seconds']=result['after_300s']['cpu_seconds']-result['startup']['cpu_seconds']
            output={'elapsed_seconds':time.monotonic()-start,'clock_ticks_per_second':HZ,'results':results}
            (ROOT/'dima-rust/services/hoststats/bench-results.json').write_text(json.dumps(output,indent=2)+'\n')
            print(json.dumps(output,indent=2),flush=True)
        finally:
            for proc in procs:
                proc.terminate()
            for proc in procs:
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill();proc.wait()
if __name__=='__main__': main()
