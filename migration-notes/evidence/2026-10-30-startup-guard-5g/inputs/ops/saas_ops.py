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
import stat
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
EXCLUDED = {"node_modules", "dist", "target", ".saas-native", ".git", ".angular", ".astro", "data", "coverage"}
# Rust 1.99.1 on Alpine/musl, using the already validated immutable image.
RUST_BUILD_IMAGE = "rust@sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9"
RUST_BINARIES = ("stream_activity", "raid_analytics", "follow_defense_baseline", "roulette_completion",
                 "ai_usage_receipts", "raid_sessions", "dashboard_activity", "cron_index")
GIB = 1024 ** 3
RUST_BUILD_CPUS = 6
RUST_BUILD_MEMORY_GIB = 6
RUST_BUILD_PIDS = 256
RUST_MEMORY_HEADROOM = 4 * GIB
RUST_CACHE_LIMIT = 8 * GIB
RUST_CACHE_MARKER = ".saas-ops-cache.json"
# Adding a future worker profile also requires reviewing the recipe's graph guard.
RUST_FEATURES = "mongo"
RUST_BASELINE_FEATURES = "mongo,redis"
# Dashboard activity needs the native HTTP client and its ICU collator for
# JS-compatible locale ties; it must stay out of the six existing worker graphs.
RUST_DASHBOARD_FEATURES = "mongo,redis,http-client,unicode-collation"
RUST_SUPERVISOR_FEATURES = "cron-supervisor"
RUST_PROFILES = "dev,test,release"
# Keep dev/test debuginfo and incremental artifacts out of the shared cache. These
# reduce compiler/test artifact size only: release profile and optimization
# settings are untouched, and all four profiles still run every check.
RUST_ARTIFACT_ENV = {"CARGO_PROFILE_DEV_DEBUG": "0", "CARGO_PROFILE_TEST_DEBUG": "0",
                     "CARGO_INCREMENTAL": "0"}
# Dependency name patterns that must never enter a graph; each profile names its
# own allowed optional clients rather than relying on feature unification.
RUST_GRAPH_FORBIDDEN = {
    "mongo": ("sqlx", "axum", "redis", "reqwest", "icu_collator"),
    "mongo-redis": ("sqlx", "axum", "reqwest", "icu_collator"),
    "dashboard": ("sqlx", "axum"),
    "cron-supervisor": ("mongodb", "sqlx", "axum", "reqwest", "icu_collator"),
}
# Cache hygiene is separate from the dependency recipe: remove only this
# package's release outputs inside the same capped compiler, retaining its deps.
RUST_CACHE_HYGIENE = '''RUSTUP_TOOLCHAIN="$(rustup default)"
RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN%% *}"
export RUSTUP_TOOLCHAIN
cargo clean --locked --release --package dima-rust
exec sh /rust-build.sh'''


def rust_worker_profiles():
    # Preserve the Mongo-only profile/receipt fields for these workers; the
    # baseline, AI usage receipt, and raid sessions workers need a Redis/Dragonfly
    # client, and dashboard activity additionally needs the native HTTP client
    # plus the ICU collator that preserves Node localeCompare ties. Standalone
    # supervision is a fourth independent graph without MongoDB, HTTP clients,
    # or ICU collation; Redis retains its URL/IDNA normalization dependencies.
    return {
        "mongo": {"features": RUST_FEATURES, "default_features": False,
                  "binaries": ["stream_activity", "raid_analytics", "roulette_completion"], "graph": "worker-dependencies.txt"},
        "mongo-redis": {"features": RUST_BASELINE_FEATURES, "default_features": False,
                        "binaries": ["follow_defense_baseline", "ai_usage_receipts", "raid_sessions"], "graph": "baseline-worker-dependencies.txt"},
        "dashboard": {"features": RUST_DASHBOARD_FEATURES, "default_features": False,
                      "binaries": ["dashboard_activity"], "graph": "dashboard-worker-dependencies.txt"},
        "cron-supervisor": {"features": RUST_SUPERVISOR_FEATURES, "default_features": False,
                            "binaries": ["cron_index"], "graph": "supervisor-dependencies.txt"},
    }


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
    "analytics": Target("dima-analytics", "analytics", "dima-analytics", command=("node", "src/index.mjs"), port=3210, health="/health"),
    "api": Target("dimabot", "api-server", "dima-server", command=("node", "dist/server/index.js"), port=3000, health="/config/site/analytics"),
    "bot": Target("dimabot", "chat-bot", "dima-bot", command=("node", "dist/bot/index.js")),
    "cron": Target("dimabot", "dima-cron", "dima-cron", command=("node", "dist/workers/cron.index.js")),
    "piper": Target("dimabot", "piper-tts", "piper-tts", dockerfile="dockerfile.piper", port=5000, health="/voices", runtime="python3"),
    "embeddings": Target("dimabot", "lfm2.5-embeddings", "lfm2.5-embeddings", dockerfile="dockerfile.lfm2-embeddings", port=8080, health="/health", runtime="python3"),
    "dimafx-server": Target("dimafx", "dimafx-server", "dimafx-server", compose="docker-compose.yml", context="server", dockerfile="Dockerfile", port=8080, health="/health"),
    "dimadb": Target("dimadb", "dimadb", "dimadb", port=80, health="/api/health"),
    "hoststats": Target("dima-hoststats", "hoststats", "dima-hoststats", command=("node", "src/index.mjs"), port=3211, health="/health"),
    "site": Target("dimasite", "dimabot-site", "dimabot-site", output="dist/dimasite/browser"),
    "admin": Target("admin", "dima-admin", "dima-admin", output="dist/admin/browser"),
    "docs": Target("dimadocs", "dimadocs", "dimadocs", compose="docker-compose.yml", output="dist"),
}
DEPENDENCIES = {
    "postgres": ("pgvector/pgvector:0.8.1-pg17", ("sh", "-c", "export POSTGRES_HOST_AUTH_METHOD=trust POSTGRES_DB=observability_test; exec docker-entrypoint.sh postgres")),
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

    def source_root(self, source_dir=None):
        if source_dir is None:
            return self.root
        source = Path(source_dir).resolve()
        common = lambda root: Path(run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root, capture=True).strip()).resolve()
        require(common(source) == common(self.root), "Source must be a worktree of this repository")
        top = run(["git", "rev-parse", "--show-toplevel"], cwd=source, capture=True).strip()
        require(Path(top).resolve() == source, "Source must be a worktree root")
        return source

    def snapshot(self, target, destination, source_dir=None, *, rust_only=False):
        source_root = self.source_root(source_dir)
        source = source_root / target.project / target.context
        relative = source.relative_to(source_root)
        listed = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relative],
                     cwd=source_root, capture=True).split("\0")
        destination.mkdir()
        for name in sorted(set(filter(None, listed))):
            file = source_root / name
            rel = file.relative_to(source)
            if any(part in EXCLUDED or part.startswith(".env") for part in rel.parts):
                continue
            if rust_only:
                if rel.parts[0] not in {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src", "tests", "examples"}:
                    continue
                # Rust and TypeScript share src/. Only the AST/permission
                # reference sources are needed by optional Rust parity tests;
                # do not copy the rest of the Node application to the compiler.
                if rel.parts[0] == "src" and rel.suffix != ".rs":
                    reference = rel.parts[:3] in {("src", "utils", "ast_parser"),
                                                 ("src", "utils", "permissions")}
                    if rel.suffix != ".ts" or not reference:
                        continue
            require(not file.is_symlink() and source in file.resolve().parents, f"Unsafe build input: {name}")
            if not file.exists():  # tracked deletions are part of the candidate
                continue
            require(file.is_file(), f"Unsupported build input: {name}")
            dest = destination / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, dest)
        # State ancestors stay 0700. Build input directories need normal traversal
        # permissions after Docker COPY changes their owner inside the image.
        for directory in [destination, *(p for p in destination.rglob("*") if p.is_dir())]:
            directory.chmod(0o755)
        require(any(destination.iterdir()), "Empty build context")

    @contextlib.contextmanager
    def rust_build_lock(self):
        # One compiler across worktrees/checkouts, not merely one per Ops receipt.
        lock_path = Path.home() / ".local/state/saas-ops-rust-build.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not lock_path.is_symlink(), "Rust compiler lock must not be a symlink")
        with lock_path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise OpsError("Another capped Rust compiler is running") from exc
            yield

    @staticmethod
    def rust_cpu_limit(cpus):
        require(type(cpus) is int and 1 <= cpus <= RUST_BUILD_CPUS,
                "Rust compiler CPUs must be an integer from 1 to 6")
        return cpus

    @staticmethod
    def rust_memory_limit(memory_gib):
        require(type(memory_gib) is int and memory_gib in (4, 6),
                "Rust compiler memory must be 4 or 6 GiB")
        return memory_gib

    def rust_headroom(self, *, starting=False, memory_gib=RUST_BUILD_MEMORY_GIB):
        memory_gib = self.rust_memory_limit(memory_gib)
        available = next(int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()
                         if line.startswith("MemAvailable:"))
        load = os.getloadavg()[0]
        minimum = RUST_MEMORY_HEADROOM
        if starting:
            minimum = (5 if memory_gib == 4 else 10) * GIB
        require(available >= minimum, "Rust build stopped: insufficient production memory headroom")
        require(load < max(1, os.cpu_count() or 1) * 0.85, "Rust build stopped: production host load is too high")
        require(shutil.disk_usage(self.state).free >= 5 * GIB, "Rust build stopped: less than 5 GiB disk headroom")
        return {"mem_available_bytes": available, "load_1m": load}

    def rust_cache_root(self):
        return Path.home() / ".local/state/saas-ops-rust-cache/v1"

    def rust_private_directory(self, path):
        # Validate the lexical path before mkdir/open: symlink ancestors are not
        # acceptable even when the final cache directory itself is a real directory.
        require(path.is_absolute() and path.resolve() == path, "Rust cache path must not contain symlinks")
        require(self.root != path and self.root not in path.parents, "Rust cache must be outside the checkout")
        require(not path.exists() or path.is_dir(), "Rust cache path must be a directory")
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = path.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.geteuid() and
                metadata.st_mode & 0o777 == 0o700, "Rust cache directory must be private and owned by this operator")

    def rust_cache_marker(self, entry, expected):
        marker = entry / RUST_CACHE_MARKER
        if marker.exists() or marker.is_symlink():
            metadata = marker.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid() and
                    metadata.st_mode & 0o077 == 0 and marker.stat().st_size <= 4096,
                    "Unsafe Rust cache ownership marker")
            require(json.loads(marker.read_text()) == expected, "Rust cache ownership marker does not match")
        else:
            require(not any(entry.iterdir()), "Refusing an unmarked Rust cache directory")
            atomic_json(marker, expected)

    def rust_cache_entries(self, root):
        """Validate before either mounting or targeted eviction; never follow symlinks."""
        entries = []
        for entry in root.iterdir():
            if entry.name == RUST_CACHE_MARKER:
                continue
            require(bool(re.fullmatch(r"[0-9a-f]{64}", entry.name)), "Unknown entry in dedicated Rust cache")
            self.rust_private_directory(entry)
            marker = entry / RUST_CACHE_MARKER
            require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size <= 4096,
                    "Missing Rust cache entry marker")
            value = json.loads(marker.read_text())
            require(isinstance(value, dict) and value.get("owner") == OWNER + ".rust-cache" and value.get("schema") == 1 and
                    value.get("key") == entry.name and isinstance(value.get("inputs"), dict) and
                    digest(json.dumps(value["inputs"], sort_keys=True).encode()) == entry.name,
                    "Invalid Rust cache entry ownership")
            self.rust_cache_marker(entry, value)
            size = 0
            for current, directories, filenames in os.walk(entry, followlinks=False):
                for name in [*directories, *filenames]:
                    try:
                        metadata = (Path(current) / name).lstat()
                    except FileNotFoundError:
                        # Cargo atomically retires temporary artifacts while the
                        # bounded compiler is running; these consume no space.
                        continue
                    require(not stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == os.geteuid() and
                            (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)),
                            "Unsafe file in dedicated Rust cache")
                    size += metadata.st_blocks * 512
            entries.append((entry, size, marker.stat().st_mtime_ns))
        return entries

    def rust_cache_usage(self, cache, *, reserve=0):
        root, active = Path(cache["root"]), Path(cache["entry"])
        self.rust_private_directory(root)
        self.rust_cache_marker(root, {"owner": OWNER + ".rust-cache", "schema": 1})
        entries = self.rust_cache_entries(root)
        total = sum(size for _, size, _ in entries)
        for entry, size, _ in sorted(entries, key=lambda row: row[2]):
            if total <= RUST_CACHE_LIMIT - reserve:
                break
            if entry != active:
                # Only the dedicated, fully validated, inactive cache entry.
                shutil.rmtree(entry)
                total -= size
        require(total <= RUST_CACHE_LIMIT, "Active Rust cache exceeds the 8 GiB limit; build stopped without raising limits")
        return total

    def prepare_rust_cache(self, path, receipt):
        root = self.rust_cache_root()
        self.rust_private_directory(root)
        self.rust_cache_marker(root, {"owner": OWNER + ".rust-cache", "schema": 1})
        inputs = {"toolchain": receipt["rust_toolchain_image"], "features": RUST_FEATURES,
                  "profiles": RUST_PROFILES, "worker_profiles": rust_worker_profiles(),
                  "profile_env": RUST_ARTIFACT_ENV,
                  "recipe": receipt["rust_recipe_digest"],
                  "manifest": digest((path / "rust-source/Cargo.toml").read_bytes()),
                  "lock": digest((path / "rust-source/Cargo.lock").read_bytes())}
        key = digest(json.dumps(inputs, sort_keys=True).encode())
        entry = root / key
        hit = entry.exists()
        self.rust_private_directory(entry)
        self.rust_cache_marker(entry, {"owner": OWNER + ".rust-cache", "schema": 1, "key": key, "inputs": inputs})
        for name in ("cargo", "target"):
            self.rust_private_directory(entry / name)
        cache = {"root": str(root), "entry": str(entry), "cargo": str(entry / "cargo"),
                 "target": str(entry / "target"), "key": key, "hit": hit}
        cache["bytes_before"] = self.rust_cache_usage(cache, reserve=GIB)
        cache["entry_bytes_before"] = next(size for candidate, size, _ in self.rust_cache_entries(root) if candidate == entry)
        (entry / RUST_CACHE_MARKER).touch()
        return cache

    def rust_container_args(self, path, receipt, image, cache):
        cpus = self.rust_cpu_limit(receipt.get("rust_cpus", RUST_BUILD_CPUS))
        memory_gib = self.rust_memory_limit(receipt.get("rust_memory_gib", RUST_BUILD_MEMORY_GIB))
        require(RUST_FEATURES == "mongo", "Unsupported worker feature profile; review its dependency graph guard before enabling it")
        require(RUST_BASELINE_FEATURES == "mongo,redis", "Unsupported baseline feature profile; review its dependency graph guard before enabling it")
        require(RUST_DASHBOARD_FEATURES == "mongo,redis,http-client,unicode-collation",
                "Unsupported dashboard feature profile; review its dependency graph guard before enabling it")
        require(RUST_SUPERVISOR_FEATURES == "cron-supervisor",
                "Unsupported supervisor feature profile; review its dependency graph guard before enabling it")
        return ["create", "--name", "saas-ops-" + receipt["run"] + "-rust-build", *self.labels(receipt["run"]),
                "--label", OWNER + ".rust-build=true",
                f"--cpus={cpus}", f"--memory={memory_gib}g",
                f"--memory-swap={memory_gib}g", f"--pids-limit={RUST_BUILD_PIDS}",
                "--security-opt=no-new-privileges",
                "--env=CARGO_BUILD_JOBS=2", "--env=CARGO_HOME=/cargo-cache", "--env=CARGO_TARGET_DIR=/target-cache",
                *(f"--env={key}={value}" for key, value in sorted(RUST_ARTIFACT_ENV.items())),
                "--env=SAAS_RUST_FEATURES=" + RUST_FEATURES,
                "--env=SAAS_RUST_BASELINE_FEATURES=" + RUST_BASELINE_FEATURES,
                "--env=SAAS_RUST_DASHBOARD_FEATURES=" + RUST_DASHBOARD_FEATURES,
                "--env=SAAS_RUST_SUPERVISOR_FEATURES=" + RUST_SUPERVISOR_FEATURES,
                "--env=SAAS_RUST_FEATURE_MATRIX=" + ("1" if receipt.get("rust_feature_matrix") else "0"),
                "--mount", f"type=bind,src={path / 'rust-source'},dst=/source,readonly",
                "--mount", f"type=bind,src={path / 'rust-work'},dst=/work",
                "--mount", f"type=bind,src={path / 'rust-artifacts'},dst=/artifacts",
                "--mount", f"type=bind,src={path / 'rust-build.sh'},dst=/rust-build.sh,readonly",
                "--mount", f"type=bind,src={cache['cargo']},dst=/cargo-cache",
                "--mount", f"type=bind,src={cache['target']},dst=/target-cache",
                "--workdir=/source", image, "sh", "-ceu", RUST_CACHE_HYGIENE]

    def verify_rust_limits(self, obj, receipt):
        cpus = self.rust_cpu_limit(receipt.get("rust_cpus", RUST_BUILD_CPUS))
        memory_gib = self.rust_memory_limit(receipt.get("rust_memory_gib", RUST_BUILD_MEMORY_GIB))
        limits = obj["HostConfig"]
        require(limits.get("NanoCpus") == cpus * 1_000_000_000 and
                limits.get("Memory") == memory_gib * GIB and
                limits.get("MemorySwap") == memory_gib * GIB and
                limits.get("PidsLimit") == RUST_BUILD_PIDS,
                "Rust compiler cgroup limits do not match the required policy")

    def build_rust(self, path, receipt, source_dir=None, *, feature_matrix=False):
        """Compile in a hard-capped musl container; never invoke host Cargo/BuildKit Cargo."""
        receipt["rust_cpus"] = cpus = self.rust_cpu_limit(receipt.get("rust_cpus", RUST_BUILD_CPUS))
        receipt["rust_memory_gib"] = memory_gib = self.rust_memory_limit(receipt.get("rust_memory_gib", RUST_BUILD_MEMORY_GIB))
        with self.rust_build_lock():
            # SIGKILL releases flock but may leave Docker work running. Never
            # overlap that orphan; its original receipt must clean it up.
            require(not self.docker("container", "ls", "--filter", "label=" + OWNER + ".rust-build=true", "--quiet", capture=True).strip(),
                    "A capped Rust compiler is already running; clean up its owning run first")
            receipt["rust_headroom_start"] = self.rust_headroom(starting=True, memory_gib=memory_gib)
            self.snapshot(Target("dimabot", "", ""), path / "rust-source", source_dir, rust_only=True)
            receipt["rust_source_digest"] = tree_hash(path / "rust-source")
            for filename in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
                require((path / "rust-source" / filename).is_file(), "Missing Rust build manifest: " + filename)
            recipe = Path(__file__).with_name("rust_build.sh")
            shutil.copy2(recipe, path / "rust-build.sh")
            receipt["rust_recipe_digest"] = digest(recipe.read_bytes())
            for name in ("rust-work", "rust-artifacts"):
                (path / name).mkdir(mode=0o755)
            image = self.inspect("image", RUST_BUILD_IMAGE, missing=True)
            if not image:
                self.docker("pull", RUST_BUILD_IMAGE)
                image = self.inspect("image", RUST_BUILD_IMAGE)
            require(bool(IMAGE_RE.fullmatch(image["Id"])), "Cannot resolve immutable Rust toolchain image")
            receipt["rust_toolchain_image"] = image["Id"]
            receipt["rust_features"] = RUST_FEATURES
            receipt["rust_worker_profiles"] = rust_worker_profiles()
            receipt["rust_build_profile_env"] = dict(RUST_ARTIFACT_ENV)
            receipt["rust_feature_matrix"] = bool(feature_matrix)
            receipt["rust_cache"] = cache = self.prepare_rust_cache(path, receipt)
            receipt["rust_cache_hygiene_digest"] = digest(RUST_CACHE_HYGIENE.encode())
            cache["project_release_clean"] = False
            print(f"Rust worker profiles: mongo={RUST_FEATURES}, mongo-redis={RUST_BASELINE_FEATURES}, "
                  f"dashboard={RUST_DASHBOARD_FEATURES}, cron-supervisor={RUST_SUPERVISOR_FEATURES}; artifact env: "
                  + ", ".join(f"{key}={value}" for key, value in sorted(RUST_ARTIFACT_ENV.items()))
                  + f"; private cache {cache['key'][:12]} "
                  f"({'existing' if cache['hit'] else 'new'}, limit 8 GiB); feature matrix: {bool(feature_matrix)}", flush=True)
            self.rust_headroom(starting=True, memory_gib=memory_gib)
            name = "saas-ops-" + receipt["run"] + "-rust-build"
            self.add_resource(path, receipt, "container", name)
            try:
                self.docker(*self.rust_container_args(path, receipt, image["Id"], cache), capture=True)
                obj = self.inspect("container", name)
                self.owned(obj, receipt["run"], "container")
                self.verify_rust_limits(obj, receipt)
                self.docker("start", obj["Id"], capture=True)
                started = time.monotonic()
                next_report = started
                while True:
                    current = self.inspect("container", name)
                    self.verify_rust_limits(current, receipt)
                    if not current["State"]["Running"]:
                        break
                    headroom = self.rust_headroom(memory_gib=memory_gib)
                    require(time.monotonic() - started < 7200, "Rust build exceeded the two-hour time limit")
                    if time.monotonic() >= next_report:
                        self.rust_cache_usage(cache)
                        print(f"Capped Rust build running ({cpus} CPUs/{memory_gib} GiB, "
                              f"available {headroom['mem_available_bytes'] / GIB:.1f} GiB)", flush=True)
                        next_report = time.monotonic() + 45
                    time.sleep(3)
                require(current["State"].get("ExitCode") == 0 and not current["State"].get("OOMKilled"),
                        f"Rust compiler/checks failed; inspect private log {path / 'rust-build.log'} (no host fallback)")
                cache["project_release_clean"] = True
                cache["bytes_after"] = self.rust_cache_usage(cache)
                receipt["rust_build_seconds"] = round(time.monotonic() - started, 3)
                for profile, metadata in receipt["rust_worker_profiles"].items():
                    dependencies = path / "rust-artifacts" / metadata["graph"]
                    require(dependencies.is_file() and not dependencies.is_symlink() and dependencies.stat().st_size <= 262144,
                            "Capped Rust build did not export its worker dependency graph: " + profile)
                    graph = dependencies.read_bytes()
                    forbidden = rb"^(" + b"|".join(name.encode() for name in RUST_GRAPH_FORBIDDEN[profile]) + rb")(?:-[^ ]+)? v"
                    require(not re.search(forbidden, graph, re.MULTILINE), "Unexpected dependencies in Rust worker graph: " + profile)
                    metadata["dependency_graph_digest"] = digest(graph)
                receipt["rust_worker_dependencies_digest"] = receipt["rust_worker_profiles"]["mongo"]["dependency_graph_digest"]
                artifacts = {binary: path / "rust-artifacts" / binary for binary in RUST_BINARIES}
                # Validate every output before staging any; host artifacts are excluded
                # from both source snapshots and cannot substitute for compiler outputs.
                for binary, artifact in artifacts.items():
                    require(artifact.is_file() and not artifact.is_symlink() and artifact.read_bytes()[:4] == b"\x7fELF",
                            "Capped Rust build did not export an ELF binary: " + binary)
                    artifact.chmod(0o755)
                receipt["rust_toolchain_version"] = (path / "rust-artifacts/toolchain.txt").read_text().strip()
                receipt["rust_binary_digests"] = {binary: digest(artifact.read_bytes()) for binary, artifact in artifacts.items()}
                receipt["rust_binary_digest"] = receipt["rust_binary_digests"]["stream_activity"]
                receipt["rust_binary_metadata"] = {
                    binary: {"profile": profile, "features": metadata["features"], "default_features": False,
                             "dependency_graph_digest": metadata["dependency_graph_digest"],
                             "binary_digest": receipt["rust_binary_digests"][binary]}
                    for profile, metadata in receipt["rust_worker_profiles"].items() for binary in metadata["binaries"]}
                # Docker COPY includes this only for cron; other dimabot targets stay unchanged.
                staged = path / "source/.saas-native"
                require(not staged.exists(), "Reserved native artifact directory already exists in source")
                staged.mkdir(mode=0o755)
                for binary, artifact in artifacts.items():
                    shutil.copy2(artifact, staged / binary)
                self.save(path, receipt)
            finally:
                try:
                    obj = self.inspect("container", name, missing=True)
                    if obj:
                        self.owned(obj, receipt["run"], "container")
                        log = self.docker("logs", obj["Id"], capture=True, combine_stderr=True)
                        (path / "rust-build.log").write_text(log)
                        (path / "rust-build.log").chmod(0o600)
                finally:
                    self.cleanup_resources(path, receipt)
                    shutil.rmtree(path / "rust-work")
                    # An oversized active entry is disposable only after its
                    # compiler has stopped and ownership has been checked.
                    for entry, size, _ in self.rust_cache_entries(Path(cache["root"])):
                        if entry == Path(cache["entry"]) and size > RUST_CACHE_LIMIT:
                            shutil.rmtree(entry)

    def build(self, name, source_dir=None, *, rust_feature_matrix=False, rust_memory_gib=None, rust_cpus=None):
        require(not rust_feature_matrix or name == "cron", "--rust-feature-matrix is only supported for cron")
        require(rust_memory_gib is None or name == "cron", "--rust-memory-gib is only supported for cron")
        require(rust_cpus is None or name == "cron", "--rust-cpus is only supported for cron")
        if name == "cron":
            rust_cpus = self.rust_cpu_limit(RUST_BUILD_CPUS if rust_cpus is None else rust_cpus)
            rust_memory_gib = self.rust_memory_limit(RUST_BUILD_MEMORY_GIB if rust_memory_gib is None else rust_memory_gib)
        target = TARGETS[name]
        live, config, config_hash, full_hash = self.baseline(target)
        run_id = name + "-" + uuid.uuid4().hex[:12]
        path = self.state / run_id
        path.mkdir(mode=0o700)
        receipt = {"run": run_id, "repo": str(self.root), "target": name, "status": "building",
                   "baseline_container": live["Id"], "baseline_image": live["Image"],
                   "config_hash": config_hash, "config_digest": full_hash,
                   "saved_config_digest": digest(json.dumps(config).encode()), "resources": []}
        if name == "cron":
            receipt["rust_cpus"] = rust_cpus
            receipt["rust_memory_gib"] = rust_memory_gib
        self.save(path, receipt)
        print(f"Run: {run_id}", flush=True)
        try:
            atomic_json(path / "compose.json", config)  # private: resolved config contains credentials
            self.snapshot(target, path / "source", source_dir)
            if name == "cron":
                self.build_rust(path, receipt, source_dir, feature_matrix=rust_feature_matrix)
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
        # Test containers may run as a non-root user. The enclosing state
        # directory stays private; only the copied behavior script is readable.
        saved_check.chmod(0o644)
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
        # Cron alone supervises less-privileged native children. It needs these
        # three capabilities to drop UID/GID and subsequently signal each child.
        child_caps = [part for cap in ("SETUID", "SETGID", "KILL") for part in ("--cap-add", cap)] if receipt["target"] == "cron" else []
        self.docker("create", "--pull=never", "--name", name, *self.labels(receipt["run"]),
                    "--network", network, "--memory", "3g", "--cpus", "2", "--pids-limit", "512",
                    "--security-opt", "no-new-privileges", "--cap-drop", "ALL", *child_caps, *env_args,
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
            for name in ("source", "fixtures", "rust-source", "rust-work", "rust-artifacts"):
                directory = path / name
                require(not directory.is_symlink(), "Refusing a symlinked temporary directory")
                if directory.is_dir():
                    shutil.rmtree(directory)
        self.save(path, receipt)
        print(f"Cleaned temporary resources for {run_id}; receipts and rollback artifacts retained")

    def preview(self, name, port, source_dir=None):
        target = TARGETS[name]
        require(bool(target.output), "preview supports site, admin, and docs")
        require(1024 <= port <= 65535, "Preview port must be between 1024 and 65535")
        self.initialize()
        # Copy source so even a project script cannot accidentally use the live output directory.
        with tempfile.TemporaryDirectory(prefix="preview-", dir=self.state) as temp:
            source = Path(temp) / "source"
            self.snapshot(target, source, source_dir)
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
        if command == "build":
            sub.add_argument("--source-dir", type=Path, help="isolated worktree of this repository; production ownership remains here")
            sub.add_argument("--rust-memory-gib", type=int, choices=(4, 6), help="cron only: compiler memory cap in GiB (default 6); requires 5/10 GiB available at startup for 4/6 GiB caps, 4 GiB while running; disables compiler swap")
            sub.add_argument("--rust-cpus", type=int, choices=range(1, RUST_BUILD_CPUS + 1), help="cron only: lower compiler CPU cap (integer 1-6, default 6); does not cap helper or Docker image-build work")
            sub.add_argument("--rust-feature-matrix", action="store_true", help="cron only: explicitly check optional Rust features inside the capped compiler; routine builds use mongo and mongo,redis worker profiles and a private cache capped at 8 GiB")
    sub = commands.add_parser("preview")
    sub.add_argument("target", choices=[n for n, t in TARGETS.items() if t.output])
    sub.add_argument("--port", type=int, default=4201)
    sub.add_argument("--source-dir", type=Path)
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
    if args.command == "build" and args.rust_feature_matrix and args.target != "cron":
        parser.error("--rust-feature-matrix is only supported for cron")
    if args.command == "build" and args.rust_memory_gib is not None and args.target != "cron":
        parser.error("--rust-memory-gib is only supported for cron")
    if args.command == "build" and args.rust_cpus is not None and args.target != "cron":
        parser.error("--rust-cpus is only supported for cron")
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
        details = {"target": args.target, "container": target.container, "project": target.project,
                          "service": target.service, "current_image": live["Image"],
                          "workflow": "build -> verify RUN --check SCRIPT -> deploy RUN",
                          "rollback": "rollback RUN", "bulk_operations": False}
        if args.target == "cron":
            details["rust"] = {"features": RUST_FEATURES, "worker_profiles": rust_worker_profiles(), "cache": str(ops.rust_cache_root()),
                               "profile_env": RUST_ARTIFACT_ENV,
                               "cache_limit_bytes": RUST_CACHE_LIMIT, "jobs": 2,
                               "cpus": RUST_BUILD_CPUS, "memory_bytes": RUST_BUILD_MEMORY_GIB * GIB,
                               "optional_lower_cpus": "build cron --rust-cpus 3",
                               "optional_lower_memory": "build cron --rust-memory-gib 4",
                               "optional_feature_matrix": "build cron --rust-feature-matrix"}
        print(json.dumps(details, indent=2))
        return 0
    if args.command == "preview":
        ops.preview(args.target, args.port, args.source_dir)
        return 0
    with ops.lock():
        if args.command == "status":
            _, receipt, _ = ops.load(args.run)
            print(json.dumps(receipt, indent=2))
        elif args.command == "build":
            ops.build(args.target, args.source_dir, rust_feature_matrix=args.rust_feature_matrix,
                      rust_memory_gib=args.rust_memory_gib, rust_cpus=args.rust_cpus)
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
