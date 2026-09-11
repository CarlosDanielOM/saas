"""Opt-in real Docker smoke test. Builds/runs/removes only disposable fixture resources.

Uses the already-present dimadb image as a Node base. Does not deploy any service.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import saas_ops as mod


class FixtureOps(mod.Ops):
    def baseline(self, target):
        # Deliberately no production target: the fixture cannot authorize deployment.
        config = {"services": {"dimadb": {"image": "fixture-only"}}}
        return {"Id": "fixture-only", "Image": "sha256:" + "0" * 64}, config, "fixture", "fixture"

    def readiness(self, container, target, **kwargs):
        inspected = self.inspect("container", container)
        assert not inspected["HostConfig"].get("Binds"), "Candidate has host/production mounts"
        assert not inspected["HostConfig"].get("PortBindings"), "Candidate published a port"
        network = inspected["HostConfig"]["NetworkMode"]
        assert network == "none" or network.startswith("saas-ops-"), "Candidate joined a production network"
        return super().readiness(container, target, **kwargs)


def production_ids(ops):
    ids = ops.docker("ps", "--all", "--format", "{{.ID}} {{.Names}}", capture=True)
    return {line for line in ids.splitlines() if "saas-ops-" not in line}


def main():
    with tempfile.TemporaryDirectory(prefix="saas-ops-docker-test-") as temp:
        root = Path(temp) / "repo"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        source = root / "dimadb"
        source.mkdir()
        source.joinpath("dockerfile").write_text('FROM dimadb:latest\nCOPY probe.mjs /ops-probe.mjs\nCMD ["node", "/ops-probe.mjs"]\n')
        source.joinpath("probe.mjs").write_text("import http from 'node:http'; http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({ok:true}));}).listen(80,'0.0.0.0');\n")
        ops = FixtureOps(root, Path(temp) / "state")
        ops.initialize()
        before = production_ids(ops)
        volumes_before = ops.docker("volume", "ls", "--quiet", capture=True).splitlines()
        run_id = None
        try:
            ops.build("dimadb")
            run_id = next(p.name for p in ops.state.iterdir() if p.is_dir())
            check = root / "check.mjs"
            check.write_text("import assert from 'node:assert/strict'; const r=await fetch('http://127.0.0.1/api/health'); assert.deepEqual(await r.json(),{ok:true}); console.log('Fixture behavior passed');")
            ops.verify(run_id, check)
            assert ops.load(run_id)[1]["status"] == "verified"
            assert ops.load(run_id)[1]["resources"] == []
            check.write_text("""import net from 'node:net';
import assert from 'node:assert/strict';
async function ping() {
  return await new Promise((resolve, reject) => {
    const s = net.createConnection({host:'redis',port:6379}, () => s.write('*1\\r\\n$4\\r\\nPING\\r\\n'));
    s.setTimeout(1000, () => s.destroy(new Error('timeout')));
    s.once('data', data => { s.destroy(); resolve(data.toString()); });
    s.once('error', reject);
  });
}
let response;
for(let n=0;n<15;n++) { try {response=await ping();break;} catch {await new Promise(r=>setTimeout(r,500));} }
assert.equal(response, '+PONG\\r\\n');
console.log('Disposable Redis responded over the isolated network');
""")
            ops.verify(run_id, check, dependencies=("redis",))
            assert ops.load(run_id)[1]["resources"] == []
            check.write_text("process.exit(17)")
            try:
                ops.verify(run_id, check)
            except mod.OpsError:
                pass
            else:
                raise AssertionError("Failed check was accepted")
            assert ops.load(run_id)[1]["status"] == "verify-failed"
            assert ops.load(run_id)[1]["resources"] == []
            try:
                ops.deploy(run_id)
            except mod.OpsError:
                pass
            else:
                raise AssertionError("Failed/unrelated fixture allowed to deploy")
        finally:
            if run_id:
                ops.cleanup(run_id)
            assert production_ids(ops) == before, "Production container identities changed"
            assert ops.docker("volume", "ls", "--quiet", capture=True).splitlines() == volumes_before, "Temporary volumes remain"
            remaining = ops.docker("ps", "--all", "--filter", "label=" + mod.OWNER + ".repo=" + ops.repo_id, "--quiet", capture=True)
            assert not remaining.strip(), "Fixture containers remain"
        print("Real Docker: build, startup, passing/failing behavior checks, deployment refusal, cleanup passed; production containers unchanged.")


if __name__ == "__main__":
    os.umask(0o077)
    main()
