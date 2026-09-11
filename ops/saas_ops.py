#!/usr/bin/env python3
"""Bounded production delivery commands. Python standard library only."""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
OWNER = "io.domdimabot.saas-ops"
RUN_RE = re.compile(r"[a-z][a-z0-9-]*-[0-9a-f]{12}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
EXCLUDED = {"node_modules", "dist", ".git", ".angular", ".astro", "data", "coverage"}


class OpsError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Target:
    project: str
    service: str
    container: str
    compose: str = "docker-compose.yaml"
    context: str = ""
    dockerfile: str = "dockerfile"
    command: tuple[str, ...] = ()
    port: int = 0
    health: str = "/"
    runtime: str = "node"
    output: str = ""


TARGETS = {
    "api": Target("dimabot", "api-server", "dima-server", command=("node", "dist/server/index.js"), port=3000, health="/config/site/analytics"),
    "bot": Target("dimabot", "chat-bot", "dima-bot", command=("node", "dist/bot/index.js")),
    "cron": Target("dimabot", "dima-cron", "dima-cron", command=("node", "dist/workers/cron.index.js")),
    "piper": Target("dimabot", "piper-tts", "piper-tts", dockerfile="dockerfile.piper", port=5000, health="/voices", runtime="python3"),
    "embeddings": Target("dimabot", "lfm2.5-embeddings", "lfm2.5-embeddings", dockerfile="dockerfile.lfm2-embeddings", port=8080, health="/health", runtime="python3"),
    "dimafx-server": Target("dimafx", "dimafx-server", "dimafx-server", compose="docker-compose.yml", context="server", dockerfile="Dockerfile", port=8080, health="/health"),
    "dimadb": Target("dimadb", "dimadb", "dimadb", port=80, health="/api/health"),
    "site": Target("dimasite", "dimabot-site", "dimabot-site", output="dist/dimasite/browser"),
    "admin": Target("admin", "dima-admin", "dima-admin", output="dist/admin/browser"),
    "docs": Target("dimadocs", "dimadocs", "dimadocs", compose="docker-compose.yml", output="dist"),
}
DEPENDENCIES = {
    "mongo": ("mongo:8.2.6", ("mongod", "--bind_ip_all")),
    "redis": ("ghcr.io/dragonflydb/dragonfly:latest", ("--logtostderr", "--proactor_threads=1")),
}


def require(condition, message):
    if not condition:
        raise OpsError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def clean_env():
    # Never inherit DOCKER_HOST, COMPOSE_FILE, npm overrides, or app credentials.
    return {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "LANG", "TERM"}}


def run(argv, *, cwd=None, capture=False, timeout=1800, env=None, combine_stderr=False):
    process = None
    try:
        process = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env or clean_env(),
                                   text=True, stdout=subprocess.PIPE if capture else None,
                                   stderr=subprocess.STDOUT if combine_stderr else (subprocess.PIPE if capture else None),
                                   start_new_session=True)
        stdout, _ = process.communicate(timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise OpsError(f"{argv[0]} failed: {exc}") from exc
    finally:
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    if process.returncode:
        # Captured Compose output may contain secrets; never dump it on errors.
        raise OpsError(f"{argv[0]} {argv[1] if len(argv) > 1 else ''} failed (exit {process.returncode})")
    return stdout or ""


def atomic_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    tmp.chmod(0o600)
    os.replace(tmp, path)


def files_under(path):
    """Do not follow symlinks, including a symlinked directory root."""
    require(path.is_dir() and not path.is_symlink(), f"Expected real directory: {path}")
    result = []
    for base, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            child = Path(base) / name
            require(not child.is_symlink(), f"Symlinks are not supported: {child}")
        result.extend(Path(base) / name for name in sorted(files))
    return sorted(result)


def tree_hash(path):
    hasher = hashlib.sha256()
    for file in files_under(path):
        hasher.update(str(file.relative_to(path)).encode() + b"\0")
        hasher.update(str(file.stat().st_mode & 0o777).encode() + b"\0")
        hasher.update(file.read_bytes())
    return hasher.hexdigest()


class Ops:
    def __init__(self, root=ROOT, state=None):
        self.root = root.resolve()
        self.repo_id = digest(str(self.root).encode())[:16]
        self.state = state or Path.home() / ".local/state/saas-ops" / self.repo_id

    def initialize(self):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not self.state.is_symlink(), "State directory must not be a symlink")
        self.state.chmod(0o700)

    @contextlib.contextmanager
    def lock(self):
        self.initialize()
        with (self.state / "operation.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise OpsError("Another build/verify/deploy/cleanup is running for this checkout") from exc
            yield

    def docker(self, *args, **kwargs):
        return run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs)

    def inspect(self, kind, name, missing=False):
        try:
            return json.loads(self.docker(kind, "inspect", name, capture=True, timeout=30))[0]
        except OpsError:
            if missing:
                # Distinguish a missing object from an unavailable daemon.
                self.docker("info", "--format", "{{.ServerVersion}}", capture=True, timeout=30)
                return None
            raise

    def compose(self, target, *args, config=None, **kwargs):
        project = self.root / target.project
        return self.docker("compose", "--project-directory", project, "--project-name", target.project,
                           "--file", config or project / target.compose, *args, **kwargs)

    def live(self, target):
        obj = self.inspect("container", target.container)
        labels = obj["Config"].get("Labels") or {}
        require(obj["Name"] == "/" + target.container, "Production container name mismatch")
        require(labels.get("com.docker.compose.project") == target.project and
                labels.get("com.docker.compose.service") == target.service and
                labels.get("com.docker.compose.project.working_dir") == str(self.root / target.project),
                "Container Compose ownership does not match this checkout/target")
        require(obj["State"]["Running"], "Production target is not running; use a separate recovery procedure")
        return obj

    def config(self, target):
        raw = self.compose(target, "config", "--format", "json", capture=True)
        config = json.loads(raw)
        value = self.compose(target, "config", "--hash", target.service, capture=True).split()
        require(len(value) == 2 and value[0] == target.service, "Cannot determine Compose config hash")
        return config, value[1], digest(raw.encode())

    def baseline(self, target):
        live = self.live(target)
        config, config_hash, full_hash = self.config(target)
        labels = live["Config"].get("Labels") or {}
        deployed_hash = labels.get(OWNER + ".config-hash", labels.get("com.docker.compose.config-hash"))
        require(deployed_hash == config_hash,
                "Compose/environment configuration differs from production. This tool delivers code/assets only; review configuration changes separately.")
        return live, config, config_hash, full_hash

    def path(self, run_id):
        require(bool(RUN_RE.fullmatch(run_id)), "Invalid run ID; use the exact ID printed by build")
        path = self.state / run_id
        require(path.is_dir() and not path.is_symlink(), "Unknown run ID")
        return path

    def load(self, run_id):
        path = self.path(run_id)
        receipt = json.loads((path / "receipt.json").read_text())
        require(receipt.get("run") == run_id and receipt.get("repo") == str(self.root), "Run ownership mismatch")
        require(receipt.get("target") in TARGETS, "Unknown target in receipt")
        return path, receipt, TARGETS[receipt["target"]]

    def save(self, path, receipt):
        atomic_json(path / "receipt.json", receipt)

    def labels(self, run_id):
        return ["--label", OWNER + ".repo=" + self.repo_id, "--label", OWNER + ".run=" + run_id]

    def owned(self, obj, run_id, kind):
        labels = (obj.get("Config", {}).get("Labels") if kind in {"container", "image"} else obj.get("Labels")) or {}
        require(labels.get(OWNER + ".repo") == self.repo_id and labels.get(OWNER + ".run") == run_id,
                "Refusing to remove a resource without matching repository/run ownership labels")

    def snapshot(self, target, destination):
        source = self.root / target.project / target.context
        relative = source.relative_to(self.root)
        listed = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relative],
                     cwd=self.root, capture=True).split("\0")
        destination.mkdir()
        for name in sorted(set(filter(None, listed))):
            file = self.root / name
            rel = file.relative_to(source)
            if any(part in EXCLUDED or part.startswith(".env") for part in rel.parts):
                continue
            require(not file.is_symlink() and source in file.resolve().parents, f"Unsafe build input: {name}")
            if not file.exists():  # tracked deletions are part of the candidate
                continue
            require(file.is_file(), f"Unsupported build input: {name}")
            dest = destination / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, dest)
        require(any(destination.iterdir()), "Empty build context")

    def build(self, name):
        target = TARGETS[name]
        live, config, config_hash, full_hash = self.baseline(target)
        run_id = name + "-" + uuid.uuid4().hex[:12]
        path = self.state / run_id
        path.mkdir(mode=0o700)
        receipt = {"run": run_id, "repo": str(self.root), "target": name, "status": "building",
                   "baseline_container": live["Id"], "baseline_image": live["Image"],
                   "config_hash": config_hash, "config_digest": full_hash,
                   "saved_config_digest": digest(json.dumps(config).encode()), "resources": []}
        self.save(path, receipt)
        print(f"Run: {run_id}", flush=True)
        try:
            atomic_json(path / "compose.json", config)  # private: resolved config contains credentials
            self.snapshot(target, path / "source")
            receipt["source_digest"] = tree_hash(path / "source")
            if target.output:
                # Install/build only inside an unserved snapshot, never inside the live output.
                run(["npm", "ci"], cwd=path / "source")
                run(["npm", "run", "build"], cwd=path / "source")
                output = path / "source" / target.output
                require((output / "index.html").is_file(), "Build did not produce index.html")
                if name == "site":
                    require((output / "index.csr.html").is_file(), "Missing Angular CSR fallback")
                shutil.copytree(output, path / "bundle")
                receipt["artifact_digest"] = tree_hash(path / "bundle")
                receipt["baseline_bundle"] = tree_hash(self.live_output(target, live))
            else:
                tag = "saas-ops/" + name + ":" + run_id
                receipt["tag"] = tag
                self.save(path, receipt)
                self.docker("build", *self.labels(run_id), "--tag", tag, "--file", path / "source" / target.dockerfile,
                            path / "source")
                receipt["image"] = self.inspect("image", tag)["Id"]
            receipt["status"] = "built"
        except BaseException:
            receipt["status"] = "build-failed"
            raise
        finally:
            self.save(path, receipt)
        print(f"Built {run_id}. Next: scripts/saas-ops verify {run_id} --check <behavior-check>")

    def live_output(self, target, live):
        expected = self.root / target.project / target.output
        require(expected.resolve() == expected and expected.is_dir(), "Live output must be an existing real directory")
        matches = [m for m in live["Mounts"] if m["Destination"] == "/usr/share/nginx/html"]
        require(len(matches) == 1 and matches[0]["Type"] == "bind" and
                matches[0]["Source"] == str(expected) and not matches[0]["RW"], "Unexpected nginx content mount")
        return expected

    def artifact(self, path, receipt, target):
        if target.output:
            require(tree_hash(path / "bundle") == receipt["artifact_digest"], "Built bundle changed after build/verification")
        else:
            image = self.inspect("image", receipt["image"])
            self.owned(image, receipt["run"], "image")
            require(image["Id"] == receipt["image"] and bool(IMAGE_RE.fullmatch(image["Id"])), "Candidate image mismatch")

    def add_resource(self, path, receipt, kind, name):
        receipt["resources"].append({"kind": kind, "name": name})
        self.save(path, receipt)  # record before creation so interrupted runs remain cleanable

    def cleanup_resources(self, path, receipt):
        for resource in list(reversed(receipt["resources"])):
            kind, name = resource["kind"], resource["name"]
            require(kind in {"container", "network"} and name.startswith("saas-ops-" + receipt["run"] + "-"),
                    "Unexpected cleanup resource")
            obj = self.inspect(kind, name, missing=True)
            if obj:
                self.owned(obj, receipt["run"], kind)
                if kind == "container":
                    # Inspect the generated name, remove the immutable ID; no name race.
                    self.docker("container", "rm", "--force", "--volumes", obj["Id"], capture=True)
                else:
                    require(not obj.get("Containers"), "Test network still has attached containers")
                    self.docker("network", "rm", obj["Id"], capture=True)
            receipt["resources"].remove(resource)
            self.save(path, receipt)

    def check_file(self, file):
        file = Path(file).resolve()
        require(file.is_file() and file.suffix in {".py", ".mjs", ".sh"}, "Check must be an existing .py, .mjs, or .sh script")
        return file

    def readiness(self, container, target, timeout=120, image=None):
        deadline = time.monotonic() + timeout
        stable = 0
        while time.monotonic() < deadline:
            obj = self.inspect("container", container)
            require(not image or obj["Image"] == image, "Running image does not match the expected image")
            state = obj["State"]
            require(state["Running"] and not state.get("Restarting") and obj.get("RestartCount", 0) == 0,
                    "Container exited or restarted during verification")
            health = state.get("Health", {}).get("Status")
            require(health != "unhealthy", "Container is unhealthy")
            if target.port:
                url = f"http://127.0.0.1:{target.port}{target.health}"
                if target.runtime == "python3":
                    command = ["python3", "-c", "import urllib.request; urllib.request.urlopen(" + repr(url) + ", timeout=3).read()"]
                else:
                    command = ["node", "-e", "fetch(" + json.dumps(url) + ", {signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
                try:
                    self.docker("exec", obj["Id"], *command, capture=True, timeout=10)
                    if health in {None, "healthy"}:
                        return
                except OpsError:
                    pass
            elif health in {None, "healthy"}:
                stable += 1
                if stable >= 5:
                    return  # behavior check must still establish bot/worker functionality
            time.sleep(1)
        raise OpsError("Readiness timed out")

    @contextlib.contextmanager
    def serve_bundle(self, bundle):
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(bundle), **kwargs)

            def log_message(self, *args):
                pass

            def do_GET(self):
                # Match the Angular fallback for preview; Astro files resolve normally.
                path = self.translate_path(self.path)
                if not os.path.exists(path) and (bundle / "index.csr.html").exists():
                    self.path = "/index.csr.html"
                elif not os.path.exists(path) and not (bundle / "_astro").exists():
                    self.path = "/index.html"
                super().do_GET()

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def verify(self, run_id, check, fixtures=None, seed_models=False, test_env=None, dependencies=()):
        path, receipt, target = self.load(run_id)
        require(receipt["status"] in {"built", "verify-failed", "verified"}, "Run is not available for verification")
        require(not receipt["resources"], "Clean up interrupted test resources first")
        self.artifact(path, receipt, target)
        check = self.check_file(check)
        saved_check = path / ("behavior-check" + check.suffix)
        shutil.copyfile(check, saved_check)
        receipt["status"] = "verifying"
        receipt["check_digest"] = digest(saved_check.read_bytes())
        self.save(path, receipt)
        try:
            if target.output:
                require(not (fixtures or seed_models or test_env or dependencies), "Container options do not apply to websites")
                with self.serve_bundle(path / "bundle") as url:
                    print(f"Candidate URL: {url}", flush=True)
                    env = clean_env() | {"SAAS_PREVIEW_URL": url, "SAAS_TARGET": receipt["target"]}
                    interpreter = {".py": "python3", ".mjs": "node", ".sh": "sh"}[check.suffix]
                    run([interpreter, saved_check], env=env, timeout=300)
            else:
                self.verify_container(path, receipt, target, saved_check, fixtures, seed_models, test_env, dependencies)
            self.artifact(path, receipt, target)
            receipt["status"] = "verified"
        except BaseException:
            receipt["status"] = "verify-failed"
            raise
        finally:
            try:
                self.cleanup_resources(path, receipt)
            except BaseException:
                receipt["status"] = "verify-failed"
                raise
            finally:
                self.save(path, receipt)
        print(f"Verified {run_id}; temporary containers removed. Next: scripts/saas-ops deploy {run_id}")

    def verify_container(self, path, receipt, target, check, fixtures, seed_models, test_env, dependencies):
        prefix = "saas-ops-" + receipt["run"] + "-"
        network = "none"
        if dependencies:
            network = prefix + "net"
            self.add_resource(path, receipt, "network", network)
            self.docker("network", "create", "--internal", *self.labels(receipt["run"]), network, capture=True)
            for dependency in dict.fromkeys(dependencies):
                image, command = DEPENDENCIES[dependency]
                image_id = self.inspect("image", image)["Id"]  # local-only; never pull a surprise dependency
                name = prefix + dependency
                self.add_resource(path, receipt, "container", name)
                self.docker("run", "--detach", "--pull=never", "--name", name, *self.labels(receipt["run"]),
                            "--network", network, "--network-alias", dependency, "--memory", "1g", "--cpus", "1",
                            "--pids-limit", "256", "--security-opt", "no-new-privileges", image_id, *command, capture=True)
        env = {"NODE_ENV": "production"}
        if receipt["target"] == "piper":
            env["PIPER_EXTRA_VOICES"] = ""
        if receipt["target"] == "dimadb":
            env.update(DIMADB_REDIS_DRAGONFLY="", DIMADB_MONGO_DIMABOT="")
        if test_env:
            supplied = json.loads(Path(test_env).read_text())
            require(isinstance(supplied, dict) and all(re.fullmatch(r"[A-Z][A-Z0-9_]*", k) and isinstance(v, str) for k, v in supplied.items()),
                    "Test environment must be a JSON object of uppercase names and string values")
            env.update(supplied)
        if receipt["target"] == "piper":
            env["PIPER_DATA_DIR"] = "/tmp/saas-fixtures"
        if receipt["target"] == "dimadb":
            env["DATA_DIR"] = "/tmp/saas-data"
        if seed_models:
            require(receipt["target"] == "piper" and not fixtures, "--seed-models is only for Piper and cannot be combined with --fixtures")
            fixtures = path / "fixtures"
            require(not fixtures.exists(), "Seed fixtures already exist; use --fixtures with that directory")
            fixtures.mkdir()
            production = self.live(target)
            self.docker("cp", production["Id"] + ":/voices/.", fixtures, capture=True)
        if fixtures:
            files_under(Path(fixtures))  # reject external symlinks before docker cp
        name = prefix + "app"
        self.add_resource(path, receipt, "container", name)
        env_args = [part for key, value in env.items() for part in ("--env", key + "=" + value)]
        self.docker("create", "--pull=never", "--name", name, *self.labels(receipt["run"]),
                    "--network", network, "--memory", "3g", "--cpus", "2", "--pids-limit", "512",
                    "--security-opt", "no-new-privileges", "--cap-drop", "ALL", *env_args,
                    receipt["image"], *target.command, capture=True)
        obj = self.inspect("container", name)
        self.owned(obj, receipt["run"], "container")
        container = obj["Id"]
        if fixtures:
            self.docker("cp", Path(fixtures), container + ":/tmp/saas-fixtures", capture=True)
        self.docker("cp", check, container + ":/tmp/saas-check" + check.suffix, capture=True)
        self.docker("start", container, capture=True)
        try:
            self.readiness(container, target, image=receipt["image"])
            interpreter = {".py": "python3", ".mjs": "node", ".sh": "sh"}[check.suffix]
            self.docker("exec", "--env", "SAAS_TARGET=" + receipt["target"], container,
                        interpreter, "/tmp/saas-check" + check.suffix, timeout=300)
            self.readiness(container, target, timeout=15, image=receipt["image"])
        finally:
            logs = self.docker("logs", "--tail", "150", container, capture=True, combine_stderr=True)
            (path / "test.log").write_text(logs)
            print(f"Test logs saved privately in {path / 'test.log'}")

    def unchanged(self, receipt, target):
        require(self.root == Path("/root/saas"), "Production deploy/rollback is restricted to /root/saas")
        live = self.live(target)
        _, _, config_digest = self.config(target)
        require(config_digest == receipt["config_digest"], "Compose/environment changed since build; rebuild and reverify")
        return live

    def release_config(self, path, receipt, target, image, label):
        require(bool(IMAGE_RE.fullmatch(image)), "Invalid image ID")
        config = json.loads((path / "compose.json").read_text())
        require(digest(json.dumps(config).encode()) == receipt["saved_config_digest"], "Saved configuration changed")
        service = config["services"][target.service]
        require(not service.get("depends_on") and not service.get("links"), "This service requires a reviewed dependency deployment adapter")
        config["services"] = {target.service: service}
        service.pop("build", None)
        service["image"] = image
        service["pull_policy"] = "never"
        service.setdefault("labels", {}).update({OWNER + ".config-hash": receipt["config_hash"], OWNER + ".release": label})
        file = path / (label + ".json")
        atomic_json(file, config)
        return file

    def replace_container(self, path, receipt, target, image, label):
        config = self.release_config(path, receipt, target, image, label)
        self.compose(target, "up", "--detach", "--no-build", "--no-deps", "--pull", "never", "--force-recreate",
                     target.service, config=config)
        live = self.live(target)
        self.readiness(live["Id"], target, image=image)
        return live["Id"]

    def publish(self, source, destination):
        # Keep the bind-mounted directory inode and previous hashed assets intact.
        # Each file is replaced atomically, with HTML last; this is not a whole-site atomic switch.
        files = files_under(source)
        require((source / "index.html").is_file(), "Refusing to publish a bundle without index.html")
        old_html = {file.relative_to(destination): file for file in files_under(destination) if file.suffix == ".html"}
        for file in sorted(files, key=lambda f: (f.suffix == ".html", str(f))):
            rel = file.relative_to(source)
            dest = destination / rel
            require(destination in dest.resolve().parents, "Publication path escapes output directory")
            dest.parent.mkdir(parents=True, exist_ok=True)
            directory = dest.parent
            while directory != destination:
                directory.chmod(0o755)
                directory = directory.parent
            require(not dest.is_symlink(), "Refusing to replace a symlink in served output")
            temp = dest.parent / (".saas-ops-" + uuid.uuid4().hex)
            try:
                shutil.copyfile(file, temp)
                temp.chmod(0o644)
                os.replace(temp, dest)
            finally:
                temp.unlink(missing_ok=True)
        # Remove obsolete page entrypoints only; keep old assets for open browser tabs.
        new_paths = {file.relative_to(source) for file in files}
        for rel, file in old_html.items():
            if rel not in new_paths:
                file.unlink()

    def verify_served(self, target, live, bundle):
        # Read through the exact nginx container; no public DNS/proxy ambiguity.
        self.docker("exec", live["Id"], "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/", capture=True, timeout=15)
        for name in ("index.html", "index.csr.html"):
            file = bundle / name
            if file.exists():
                served = self.docker("exec", live["Id"], "wget", "-qO-", "http://127.0.0.1/" + name, capture=True, timeout=15)
                require(served.encode() == file.read_bytes(), f"Served {name} differs from tested bundle")

    def deploy(self, run_id):
        path, receipt, target = self.load(run_id)
        require(receipt["status"] == "verified" and not receipt["resources"], "Deployment requires a verified run with test resources cleaned up")
        self.artifact(path, receipt, target)
        live = self.unchanged(receipt, target)
        require(live["Id"] == receipt["baseline_container"] and live["Image"] == receipt["baseline_image"], "Production changed since build; create a new run")
        if target.output:
            output = self.live_output(target, live)
            require(tree_hash(output) == receipt["baseline_bundle"], "Live bundle changed since build; create a new run")
            shutil.copytree(output, path / "previous-bundle")
            receipt["previous_bundle_digest"] = tree_hash(path / "previous-bundle")
        else:
            rollback_tag = "saas-ops/rollback:" + run_id
            self.docker("tag", live["Image"], rollback_tag)
            receipt["rollback_tag"] = rollback_tag
        receipt["status"] = "deploying"
        self.save(path, receipt)
        try:
            if target.output:
                self.publish(path / "bundle", output)
                self.verify_served(target, live, path / "bundle")
                receipt["deployed_bundle"] = tree_hash(output)
            else:
                receipt["deployed_container"] = self.replace_container(path, receipt, target, receipt["image"], "deploy")
            receipt["status"] = "deployed"
        except BaseException:
            receipt["status"] = "deploy-failed"
            self.save(path, receipt)
            try:
                self.restore(path, receipt, target)
                receipt["status"] = "rolled-back"
            except BaseException:
                receipt["status"] = "rollback-failed"
                print(f"Automatic rollback failed. Preserve {path} and inspect this target.", file=sys.stderr)
                raise
            raise
        finally:
            self.save(path, receipt)
        print(f"Deployed {run_id}. Rollback: scripts/saas-ops rollback {run_id}")

    def restore(self, path, receipt, target):
        if target.output:
            previous = path / "previous-bundle"
            require(tree_hash(previous) == receipt["previous_bundle_digest"], "Rollback bundle was modified")
            live = self.live(target)
            self.publish(previous, self.live_output(target, live))
            self.verify_served(target, live, previous)
        else:
            self.replace_container(path, receipt, target, receipt["baseline_image"], "rollback")

    def rollback(self, run_id):
        path, receipt, target = self.load(run_id)
        require(receipt["status"] == "deployed", "Only the currently deployed run can be rolled back")
        live = self.unchanged(receipt, target)
        if target.output:
            require(tree_hash(self.live_output(target, live)) == receipt["deployed_bundle"], "A newer/external website deployment exists")
        else:
            require(live["Id"] == receipt["deployed_container"] and live["Image"] == receipt["image"], "A newer/external container deployment exists")
        receipt["status"] = "rolling-back"
        self.save(path, receipt)
        try:
            self.restore(path, receipt, target)
            receipt["status"] = "rolled-back"
        except BaseException:
            receipt["status"] = "rollback-failed"
            raise
        finally:
            self.save(path, receipt)
        print(f"Rolled back {run_id}")

    def cleanup(self, run_id):
        path, receipt, target = self.load(run_id)
        self.cleanup_resources(path, receipt)
        # Never delete candidate/rollback images needed by a release.
        if receipt["status"] not in {"deployed", "deploying", "deploy-failed", "rolling-back", "rollback-failed"} and receipt.get("tag"):
            image = self.inspect("image", receipt["tag"], missing=True)
            if image:
                self.owned(image, run_id, "image")
                self.docker("image", "rm", receipt["tag"], capture=True)  # no force; Docker protects in-use images
            receipt["status"] = "cleaned"
        if receipt["status"] not in {"building", "verifying", "deploying", "rolling-back", "rollback-failed"}:
            for name in ("source", "fixtures"):
                directory = path / name
                require(not directory.is_symlink(), "Refusing a symlinked temporary directory")
                if directory.is_dir():
                    shutil.rmtree(directory)
        self.save(path, receipt)
        print(f"Cleaned temporary resources for {run_id}; receipts and rollback artifacts retained")

    def preview(self, name, port):
        target = TARGETS[name]
        require(bool(target.output), "preview supports site, admin, and docs")
        require(1024 <= port <= 65535, "Preview port must be between 1024 and 65535")
        self.initialize()
        # Copy source so even a project script cannot accidentally use the live output directory.
        with tempfile.TemporaryDirectory(prefix="preview-", dir=self.state) as temp:
            source = Path(temp) / "source"
            self.snapshot(target, source)
            run(["npm", "ci"], cwd=source)
            command = ["npm", "run", "dev" if name == "docs" else "start", "--", "--host", "127.0.0.1", "--port", str(port)]
            if name != "docs":
                command += ["--configuration", "development"]
            print(f"Preview http://127.0.0.1:{port}; Ctrl-C stops it and removes its isolated copy.", flush=True)
            process = subprocess.Popen(command, cwd=source, env=clean_env(), start_new_session=True)
            try:
                require(process.wait() == 0, "Preview exited with an error")
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Explicit, isolated SaaS delivery. No default deploy, bulk target, pull, prune, or arbitrary container names.")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("list", help="show fixed target mappings")
    for command in ("plan", "build"):
        sub = commands.add_parser(command)
        sub.add_argument("target", choices=TARGETS)
    sub = commands.add_parser("preview")
    sub.add_argument("target", choices=[n for n, t in TARGETS.items() if t.output])
    sub.add_argument("--port", type=int, default=4201)
    sub = commands.add_parser("verify")
    sub.add_argument("run")
    sub.add_argument("--check", required=True, help="behavior script; runs inside candidate container, or against candidate web URL")
    sub.add_argument("--fixtures", type=Path)
    sub.add_argument("--seed-models", action="store_true", help="copy Piper voices from production read-only into disposable test storage")
    sub.add_argument("--test-env", type=Path, help="JSON test settings; never inherits production .env")
    sub.add_argument("--dependency", action="append", choices=DEPENDENCIES, default=[])
    for command in ("status", "deploy", "rollback", "cleanup"):
        commands.add_parser(command).add_argument("run")
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    ops = Ops()
    if args.command == "list":
        for name, target in TARGETS.items():
            print(f"{name:16} {target.project}/{target.compose} -> {target.service} ({target.container})")
        return 0
    if args.command == "plan":
        target = TARGETS[args.target]
        live, _, _, _ = ops.baseline(target)
        if target.output:
            ops.live_output(target, live)
        print(json.dumps({"target": args.target, "container": target.container, "project": target.project,
                          "service": target.service, "current_image": live["Image"],
                          "workflow": "build -> verify RUN --check SCRIPT -> deploy RUN",
                          "rollback": "rollback RUN", "bulk_operations": False}, indent=2))
        return 0
    if args.command == "preview":
        ops.preview(args.target, args.port)
        return 0
    with ops.lock():
        if args.command == "status":
            _, receipt, _ = ops.load(args.run)
            print(json.dumps(receipt, indent=2))
        elif args.command == "build":
            ops.build(args.target)
        elif args.command == "verify":
            ops.verify(args.run, args.check, args.fixtures, args.seed_models, args.test_env, args.dependency)
        else:
            getattr(ops, args.command)(args.run)
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except (OpsError, ValueError, KeyError, OSError) as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Interrupted; use cleanup RUN if test resources remain.", file=sys.stderr)
        sys.exit(130)
