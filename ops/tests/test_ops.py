"""Safety regression tests. All production deployment operations use an in-memory engine."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import saas_ops as mod


OLD = "sha256:" + "1" * 64
NEW = "sha256:" + "2" * 64
RUN = "dimadb-123456abcdef"


class FakeOps(mod.Ops):
    def __init__(self, root, state):
        super().__init__(root, state)
        self.calls = []
        self.objects = {}
        self.current = {"Id": "old-container", "Image": OLD}
        self.fail_candidate = False
        self.fail_rollback = False
        self.config_changed = False

    def inspect(self, kind, name, missing=False):
        obj = self.objects.get((kind, name))
        if obj is None and not missing:
            raise mod.OpsError("Missing object")
        return copy.deepcopy(obj)

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ("container", "rm"):
            for key, value in list(self.objects.items()):
                if key[0] == "container" and value["Id"] == args[-1]:
                    del self.objects[key]
        return ""

    def live(self, target):
        return copy.deepcopy(self.current)

    def unchanged(self, receipt, target):
        if self.config_changed:
            raise mod.OpsError("Configuration changed")
        return self.live(target)

    def replace_container(self, path, receipt, target, image, label):
        self.calls.append(("replace", target.service, image, label))
        self.current = {"Id": label + "-container", "Image": image}
        if (image == NEW and self.fail_candidate) or (image == OLD and self.fail_rollback):
            raise mod.OpsError("Readiness failed")
        return self.current["Id"]


class OpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.ops = FakeOps(self.root, Path(self.temp.name) / "state")
        self.ops.initialize()
        self.path = self.ops.state / RUN
        self.path.mkdir()
        self.receipt = {"run": RUN, "repo": str(self.root), "target": "dimadb", "status": "verified",
                        "baseline_container": "old-container", "baseline_image": OLD, "image": NEW,
                        "resources": [], "tag": "saas-ops/dimadb:" + RUN}
        self.ops.save(self.path, self.receipt)
        self.ops.objects[("image", NEW)] = {"Id": NEW, "Config": {"Labels": self.labels()}}

    def tearDown(self):
        self.temp.cleanup()

    def labels(self):
        return {mod.OWNER + ".repo": self.ops.repo_id, mod.OWNER + ".run": RUN}

    def saved(self):
        return self.ops.load(RUN)[1]

    def test_no_arguments_have_no_side_effects(self):
        with patch.object(mod, "Ops") as engine, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mod.main([]), 0)
            engine.assert_not_called()

    def test_all_and_container_names_are_not_targets(self):
        for target in ("all", "backend", "dima-server", "postgres", "NPM", "api;docker", "../piper"):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                mod.main(["build", target])

    def test_run_path_traversal_is_rejected(self):
        for value in ("../anything", "/root", "piper", RUN + "/../../"):
            with self.assertRaises(mod.OpsError):
                self.ops.path(value)

    def test_deployment_requires_successful_verification(self):
        for state in ("built", "verifying", "verify-failed", "cleaned"):
            self.receipt["status"] = state
            self.ops.save(self.path, self.receipt)
            with self.assertRaises(mod.OpsError):
                self.ops.deploy(RUN)
        self.assertEqual(self.ops.calls, [])

    def test_deployment_refuses_leftover_tests(self):
        self.receipt["resources"] = [{"kind": "container", "name": "leftover"}]
        self.ops.save(self.path, self.receipt)
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual(self.ops.calls, [])

    def test_stale_container_or_environment_cannot_deploy(self):
        self.ops.current["Id"] = "someone-elses-release"
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.ops.current["Id"] = "old-container"
        self.ops.config_changed = True
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual(self.ops.calls, [])

    def test_deploy_promotes_same_image_without_building(self):
        self.ops.deploy(RUN)
        self.assertEqual(self.ops.current["Image"], NEW)
        self.assertEqual(self.saved()["status"], "deployed")
        self.assertEqual(self.ops.calls, [("tag", OLD, "saas-ops/rollback:" + RUN),
                                        ("replace", "dimadb", NEW, "deploy")])

    def test_readiness_failure_restores_previous_image(self):
        self.ops.fail_candidate = True
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual(self.ops.current["Image"], OLD)
        self.assertEqual(self.saved()["status"], "rolled-back")

    def test_rollback_failure_is_not_reported_as_success(self):
        self.ops.fail_candidate = self.ops.fail_rollback = True
        with self.assertRaises(mod.OpsError), contextlib.redirect_stderr(io.StringIO()):
            self.ops.deploy(RUN)
        self.assertEqual(self.saved()["status"], "rollback-failed")

    def test_old_receipt_cannot_roll_back_newer_deployment(self):
        self.ops.deploy(RUN)
        self.ops.current["Id"] = "newer-release"
        with self.assertRaises(mod.OpsError):
            self.ops.rollback(RUN)
        self.assertEqual(self.ops.current["Id"], "newer-release")

    def test_current_release_can_roll_back(self):
        self.ops.deploy(RUN)
        self.ops.rollback(RUN)
        self.assertEqual(self.ops.current["Image"], OLD)

    def test_manual_rollback_failure_preserves_recovery_state(self):
        self.ops.deploy(RUN)
        self.ops.fail_rollback = True
        with self.assertRaises(mod.OpsError):
            self.ops.rollback(RUN)
        self.assertEqual(self.saved()["status"], "rollback-failed")
        self.ops.calls.clear()
        self.ops.cleanup(RUN)
        self.assertEqual(self.ops.calls, [])

    def test_cleanup_refuses_unowned_resources_even_with_expected_name(self):
        name = "saas-ops-" + RUN + "-app"
        self.receipt["resources"] = [{"kind": "container", "name": name}]
        self.ops.objects[("container", name)] = {"Id": "production-id", "Config": {"Labels": {}}}
        with self.assertRaises(mod.OpsError):
            self.ops.cleanup_resources(self.path, self.receipt)
        self.assertEqual(self.ops.calls, [])

    def test_cleanup_refuses_production_name_even_with_labels(self):
        self.receipt["resources"] = [{"kind": "container", "name": "dimadb"}]
        self.ops.objects[("container", "dimadb")] = {"Id": "production-id", "Config": {"Labels": self.labels()}}
        with self.assertRaises(mod.OpsError):
            self.ops.cleanup_resources(self.path, self.receipt)
        self.assertEqual(self.ops.calls, [])

    def test_cleanup_uses_inspected_id_and_only_removes_owned_test(self):
        name = "saas-ops-" + RUN + "-app"
        self.receipt["resources"] = [{"kind": "container", "name": name}]
        self.ops.objects[("container", name)] = {"Id": "test-id", "Config": {"Labels": self.labels()}}
        self.ops.objects[("container", "production")] = {"Id": "production-id"}
        self.ops.cleanup_resources(self.path, self.receipt)
        self.assertEqual(self.ops.calls, [("container", "rm", "--force", "--volumes", "test-id")])
        self.assertIn(("container", "production"), self.ops.objects)
        self.assertEqual(self.receipt["resources"], [])

    def test_cleanup_preserves_deployed_candidate_and_rollback(self):
        self.ops.deploy(RUN)
        self.ops.calls.clear()
        self.ops.cleanup(RUN)
        self.assertEqual(self.ops.calls, [])
        self.assertEqual(self.saved()["status"], "deployed")

    def test_behavior_script_is_readable_by_non_root_candidate(self):
        check = self.root / "check.mjs"
        check.write_text("process.exit(0)")
        check.chmod(0o600)
        with patch.object(self.ops, "verify_container") as verify:
            self.ops.verify(RUN, check)
        copied = verify.call_args.args[3]
        self.assertEqual(copied.stat().st_mode & 0o777, 0o644)
        self.assertEqual(copied.read_bytes(), check.read_bytes())
        self.assertEqual(self.ops.state.stat().st_mode & 0o777, 0o700)

    def test_failed_behavior_check_cleans_up_and_blocks_deploy(self):
        check = self.root / "check.py"
        check.write_text("raise RuntimeError('test failure')")
        def failing(*args):
            receipt = args[1]
            name = "saas-ops-" + RUN + "-app"
            self.ops.add_resource(self.path, receipt, "container", name)
            self.ops.objects[("container", name)] = {"Id": "test-id", "Config": {"Labels": self.labels()}}
            raise mod.OpsError("Behavior check failed")
        with patch.object(self.ops, "verify_container", side_effect=failing), self.assertRaises(mod.OpsError):
            self.ops.verify(RUN, check)
        self.assertEqual(self.saved()["status"], "verify-failed")
        self.assertEqual(self.saved()["resources"], [])
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)

    def test_image_labels_must_match_run_before_deploy(self):
        self.ops.objects[("image", NEW)]["Config"]["Labels"] = {}
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual(self.ops.calls, [])

    def test_release_config_only_contains_selected_service_and_exact_image(self):
        config = {"services": {"dimadb": {"build": {"context": "x"}, "image": "dimadb:latest"},
                               "unrelated": {"image": "postgres"}}, "networks": {"databases": {"external": True}}}
        mod.atomic_json(self.path / "compose.json", config)
        self.receipt.update(saved_config_digest=mod.digest(json.dumps(config).encode()), config_hash="canonical")
        file = self.ops.release_config(self.path, self.receipt, mod.TARGETS["dimadb"], NEW, "deploy")
        actual = json.loads(file.read_text())
        self.assertEqual(list(actual["services"]), ["dimadb"])
        service = actual["services"]["dimadb"]
        self.assertNotIn("build", service)
        self.assertEqual(service["image"], NEW)
        self.assertEqual(service["pull_policy"], "never")
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        config["services"]["dimadb"]["privileged"] = True
        mod.atomic_json(self.path / "compose.json", config)
        with self.assertRaises(mod.OpsError):
            self.ops.release_config(self.path, self.receipt, mod.TARGETS["dimadb"], NEW, "deploy")

    def test_production_command_has_no_build_pull_dependencies_or_other_services(self):
        target = mod.TARGETS["dimadb"]
        with patch.object(self.ops, "release_config", return_value=self.path / "deploy.json"), \
             patch.object(self.ops, "compose") as compose, patch.object(self.ops, "readiness"):
            mod.Ops.replace_container(self.ops, self.path, self.receipt, target, NEW, "deploy")
            self.assertEqual(compose.call_args.args[1:], ("up", "--detach", "--no-build", "--no-deps", "--pull", "never", "--force-recreate", "dimadb"))

    def test_bundle_publish_preserves_mount_inode_and_old_assets(self):
        source, destination = self.root / "candidate", self.root / "live"
        source.mkdir()
        destination.mkdir()
        (source / "index.html").write_text('new page')
        (source / "asset-new.js").write_text('new asset')
        (source / "es").mkdir()
        (source / "es/index.html").write_text('translated page')
        (destination / "index.html").write_text('old page')
        (destination / "asset-old.js").write_text('old asset')
        (destination / "removed-page.html").write_text('old page')
        inode = destination.stat().st_ino
        mask = os.umask(0o077)
        try:
            self.ops.publish(source, destination)
        finally:
            os.umask(mask)
        self.assertEqual(destination.stat().st_ino, inode)
        self.assertEqual((destination / "index.html").read_text(), 'new page')
        self.assertTrue((destination / "asset-old.js").is_file())
        self.assertFalse((destination / "removed-page.html").exists())
        self.assertEqual((destination / "es").stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / "es/index.html").stat().st_mode & 0o777, 0o644)

    def test_bundle_tampering_is_rejected(self):
        bundle = self.path / "bundle"
        bundle.mkdir()
        (bundle / "index.html").write_text("tested")
        self.receipt["artifact_digest"] = mod.tree_hash(bundle)
        (bundle / "index.html").write_text("untested")
        with self.assertRaises(mod.OpsError):
            self.ops.artifact(self.path, self.receipt, mod.TARGETS["site"])

    def test_symlinks_cannot_publish_outside_live_directory(self):
        source, live, unrelated = self.root / "candidate", self.root / "live", self.root / "unrelated"
        for path in (source, live, unrelated):
            path.mkdir()
        (source / "nested").mkdir()
        (source / "nested/index.html").write_text("page")
        (live / "nested").symlink_to(unrelated, target_is_directory=True)
        with self.assertRaises(mod.OpsError):
            self.ops.publish(source, live)
        self.assertFalse((unrelated / "index.html").exists())

    def test_worktree_snapshot_uses_isolated_source_and_preserves_owner(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        project = self.root / "dimadb"
        project.mkdir()
        (project / "source.js").write_text("committed")
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
        worktree = Path(self.temp.name) / "isolated"
        subprocess.run(["git", "-C", str(self.root), "worktree", "add", "--detach", "-q", str(worktree)], check=True)
        (project / "source.js").write_text("unrelated unfinished change")
        (worktree / "dimadb/source.js").write_text("verified feature")
        self.ops.snapshot(mod.TARGETS["dimadb"], self.path / "source", worktree)
        self.assertEqual((self.path / "source/source.js").read_text(), "verified feature")
        self.assertEqual((project / "source.js").read_text(), "unrelated unfinished change")
        self.assertEqual(self.ops.root, self.root)
        with self.assertRaises(mod.OpsError):
            self.ops.source_root(worktree / "dimadb")
        unrelated = Path(self.temp.name) / "other"
        subprocess.run(["git", "init", "-q", str(unrelated)], check=True)
        with self.assertRaises(mod.OpsError):
            self.ops.source_root(unrelated)

    def test_source_snapshot_excludes_secrets_outputs_and_preserves_edits(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        project = self.root / "dimadb"
        project.mkdir()
        (project / "source.js").write_text("current uncommitted source")
        (project / "static").mkdir()
        (project / "static/index.html").write_text("test asset")
        (project / ".env").write_text("SECRET=do-not-copy")
        (project / "data").mkdir()
        (project / "data/prod.json").write_text("private")
        (project / "dist").mkdir()
        (project / "dist/index.html").write_text("live")
        previous_umask = os.umask(0o077)
        try:
            self.ops.snapshot(mod.TARGETS["dimadb"], self.path / "source")
        finally:
            os.umask(previous_umask)
        self.assertEqual((self.path / "source").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.path / "source/static").stat().st_mode & 0o777, 0o755)
        self.assertEqual(sorted(f.name for f in mod.files_under(self.path / "source")), ["index.html", "source.js"])
        self.assertEqual((project / "source.js").read_text(), "current uncommitted source")
        self.assertEqual((project / "dist/index.html").read_text(), "live")

    def test_docker_and_compose_environment_overrides_are_removed(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote", "COMPOSE_FILE": "wrong.yml", "TWITCH_TOKEN": "secret"}):
            env = mod.clean_env()
        self.assertNotIn("DOCKER_HOST", env)
        self.assertNotIn("COMPOSE_FILE", env)
        self.assertNotIn("TWITCH_TOKEN", env)

    def test_explicit_test_database_settings_survive_defaults_but_storage_stays_disposable(self):
        settings = self.root / "test-env.json"
        settings.write_text(json.dumps({"DIMADB_REDIS_DRAGONFLY": "redis://redis:6379", "DATA_DIR": "/data"}))
        check = self.root / "check.mjs"
        check.write_text("process.exit(0)")
        inspected = {"Id": "test-id", "Config": {"Labels": self.labels()}}
        with patch.object(self.ops, "readiness"), patch.object(self.ops, "inspect", return_value=inspected):
            self.ops.verify_container(self.path, self.receipt, mod.TARGETS["dimadb"], check, None, False, settings, ())
        create = next(call for call in self.ops.calls if call[0] == "create")
        self.assertIn("DIMADB_REDIS_DRAGONFLY=redis://redis:6379", create)
        self.assertIn("DATA_DIR=/tmp/saas-data", create)
        self.assertNotIn("DATA_DIR=/data", create)
        self.assertEqual(create[create.index("--network") + 1], "none")
        self.assertNotIn("--env-file", create)
        self.assertNotIn("--mount", create)
        self.assertNotIn("--privileged", create)

    def test_cross_checkout_production_deploy_is_rejected(self):
        with self.assertRaises(mod.OpsError):
            mod.Ops.unchanged(self.ops, self.receipt, mod.TARGETS["dimadb"])

    def test_two_operations_cannot_share_checkout_lock(self):
        with self.ops.lock(), self.assertRaises(mod.OpsError):
            with mod.Ops(self.root, self.ops.state).lock():
                pass

    def rust_source(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        project = self.root / "dimabot"
        (project / "src").mkdir(parents=True)
        for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
            (project / name).write_text("fixture")
        (project / "src/lib.rs").write_text("// fixture")
        return project

    def test_rust_snapshot_excludes_env_host_artifacts_and_non_build_material(self):
        project = self.rust_source()
        for name in ("target", "benchmarks", ".saas-native"):
            (project / name).mkdir()
            (project / name / "stream_activity").write_text("unverified host artifact")
        (project / ".env.prod").write_text("SECRET=private")
        (project / "README.md").write_text("not compiler input")
        self.ops.snapshot(mod.Target("dimabot", "", ""), self.path / "rust-source", rust_only=True)
        self.assertEqual([str(f.relative_to(self.path / "rust-source")) for f in mod.files_under(self.path / "rust-source")],
                         ["Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "src/lib.rs"])
        (project / "src/unsafe.rs").symlink_to(project / ".env.prod")
        with self.assertRaises(mod.OpsError):
            self.ops.snapshot(mod.Target("dimabot", "", ""), self.path / "unsafe", rust_only=True)

    def test_combined_source_snapshots_keep_rust_fixtures_and_node_sources_separate(self):
        project = self.rust_source()
        inputs = {
            "src/workers/cron.index.rs": "fn main() {}",
            "src/workers/cron.index.ts": "console.log('node cron')",
            "src/utils/databases/mongodb.database.rs": "// native database module",
            "src/utils/ast_parser/parser.ts": "// hashed syntax reference",
            "src/utils/permissions/roles.ts": "// hashed permission reference",
            "src/server/index.ts": "// Node application, not Rust compiler input",
            "tests/parity.rs": "// native parity test",
            "tests/fixtures/cases.json": "{}",
            "tests/fixtures/reference.mjs": "// source-backed oracle",
            "examples/fixture.rs": "fn main() {}",
            "package.json": "{}",
            ".env.prod": "SECRET=private",
            "tests/fixtures/.env.test": "SECRET=private",
            "node_modules/fixture/index.rs": "// dependency artifact",
            "dist/workers/cron.index.js": "// live build",
            "target/release/cron_index": "unverified Rust artifact",
            ".saas-native/cron_index": "unverified staged artifact",
        }
        for name, content in inputs.items():
            path = project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.ops.snapshot(mod.Target("dimabot", "", ""), self.path / "rust-source", rust_only=True)
        rust_files = {str(path.relative_to(self.path / "rust-source"))
                      for path in mod.files_under(self.path / "rust-source")}
        self.assertEqual(rust_files, {
            "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/lib.rs",
            "src/workers/cron.index.rs", "src/utils/databases/mongodb.database.rs",
            "src/utils/ast_parser/parser.ts", "src/utils/permissions/roles.ts",
            "tests/parity.rs", "tests/fixtures/cases.json", "tests/fixtures/reference.mjs",
            "examples/fixture.rs",
        })
        self.ops.snapshot(mod.TARGETS["cron"], self.path / "source")
        node_files = {str(path.relative_to(self.path / "source"))
                      for path in mod.files_under(self.path / "source")}
        self.assertTrue({"src/workers/cron.index.ts", "src/server/index.ts", "package.json"} <= node_files)
        self.assertTrue(rust_files <= node_files)
        self.assertFalse({name for name in inputs if name.startswith(
            (".env", "tests/fixtures/.env", "node_modules/", "dist/", "target/", ".saas-native/"))} & node_files)

    def test_cron_dockerfile_stages_every_checked_native_binary(self):
        dockerfile = (mod.ROOT / "dimabot" / "dockerfile").read_text()
        self.assertEqual(len(mod.RUST_BINARIES), 8)
        self.assertIn("raid_sessions", mod.RUST_BINARIES)
        self.assertIn("dashboard_activity", mod.RUST_BINARIES)
        self.assertIn("cron_index", mod.RUST_BINARIES)
        for binary in mod.RUST_BINARIES:
            self.assertIn(f"install -m 0755 .saas-native/{binary} /usr/local/bin/{binary};", dockerfile)
        # Seven worker children and their supervisor are staged together.
        self.assertIn("install -m 0755 .saas-native/raid_sessions /usr/local/bin/raid_sessions;", dockerfile)
        self.assertIn("install -m 0755 .saas-native/dashboard_activity /usr/local/bin/dashboard_activity;", dockerfile)
        self.assertIn("if [ -d .saas-native ]", dockerfile)
        self.assertIn("rm -rf .saas-native", dockerfile)

    def test_native_binaries_are_built_installed_and_receipted_in_their_profiles(self):
        # Every declared binary must belong to exactly one dependency profile, and
        # the newer workers must use their dedicated profiles.
        profiles = mod.rust_worker_profiles()
        assigned = {binary: profile for profile, metadata in profiles.items() for binary in metadata["binaries"]}
        self.assertEqual(sorted(assigned), sorted(mod.RUST_BINARIES))
        self.assertEqual(len(assigned), len(mod.RUST_BINARIES))
        self.assertEqual(assigned["raid_sessions"], "mongo-redis")
        self.assertEqual(profiles["mongo-redis"]["features"], "mongo,redis")
        self.assertNotIn("raid_sessions", profiles["mongo"]["binaries"])
        self.assertEqual(assigned["dashboard_activity"], "dashboard")
        self.assertEqual(profiles["dashboard"]["features"], "mongo,redis,http-client,unicode-collation")
        self.assertEqual(profiles["dashboard"]["graph"], "dashboard-worker-dependencies.txt")
        self.assertNotIn("dashboard_activity", profiles["mongo"]["binaries"])
        self.assertNotIn("dashboard_activity", profiles["mongo-redis"]["binaries"])
        self.assertEqual(list(profiles), ["mongo", "mongo-redis", "dashboard", "cron-supervisor"])
        self.assertEqual(assigned["cron_index"], "cron-supervisor")
        self.assertEqual(profiles["cron-supervisor"], {
            "features": "cron-supervisor", "default_features": False,
            "binaries": ["cron_index"], "graph": "supervisor-dependencies.txt"})
        self.assertEqual(set(profiles), set(mod.RUST_GRAPH_FORBIDDEN))
        self.assertEqual(sum(len(profile["binaries"]) for profile in profiles.values()), 8)
        for profile in ("mongo", "mongo-redis", "dashboard"):
            self.assertNotIn("cron-supervisor", profiles[profile]["features"])
            self.assertNotIn("cron_index", profiles[profile]["binaries"])
        recipe = (mod.ROOT / "ops" / "rust_build.sh").read_text()
        redis_build = '--features "$SAAS_RUST_BASELINE_FEATURES" --bin follow_defense_baseline --bin ai_usage_receipts --bin raid_sessions'
        self.assertIn(redis_build, recipe)
        mongo_build = '--features "$SAAS_RUST_FEATURES" --bin stream_activity --bin raid_analytics --bin roulette_completion'
        self.assertIn(mongo_build, recipe)
        self.assertNotIn("raid_sessions", recipe[recipe.index(mongo_build):recipe.index(redis_build)])
        self.assertIn("install -m 0755 /target-cache/release/raid_sessions /artifacts/raid_sessions", recipe)
        self.assertIn("/artifacts/raid_sessions --dry-run", recipe)
        # The Redis profile must be compiled before its binary can be installed or dry-run.
        self.assertLess(recipe.index(redis_build), recipe.index("install -m 0755 /target-cache/release/raid_sessions"))
        self.assertLess(recipe.index("install -m 0755 /target-cache/release/raid_sessions"), recipe.index("/artifacts/raid_sessions --dry-run"))
        # The dashboard profile owns the native HTTP client and ICU collator; the
        # earlier profiles must keep rejecting both.
        dashboard_build = '--features "$SAAS_RUST_DASHBOARD_FEATURES" --bin dashboard_activity'
        self.assertIn(dashboard_build, recipe)
        self.assertIn("install -m 0755 /target-cache/release/dashboard_activity /artifacts/dashboard_activity", recipe)
        self.assertIn("/artifacts/dashboard_activity --dry-run", recipe)
        self.assertIn("dashboard-worker-dependencies.txt", recipe)
        self.assertLess(recipe.index(dashboard_build), recipe.index("install -m 0755 /target-cache/release/dashboard_activity"))
        self.assertLess(recipe.index("install -m 0755 /target-cache/release/dashboard_activity"),
                        recipe.index("/artifacts/dashboard_activity --dry-run"))
        mongo_guard = recipe[recipe.index("worker-dependencies.txt"):recipe.index("cargo check", recipe.index("worker-dependencies.txt"))]
        self.assertIn("reqwest", mongo_guard)
        self.assertIn("icu_collator", mongo_guard)
        baseline_guard = recipe[recipe.index("baseline-worker-dependencies.txt"):recipe.index("cargo check", recipe.index("baseline-worker-dependencies.txt"))]
        self.assertIn("reqwest", baseline_guard)
        self.assertIn("icu_collator", baseline_guard)
        dashboard_guard = recipe[recipe.index("dashboard-worker-dependencies.txt"):recipe.index("cargo check", recipe.index("dashboard-worker-dependencies.txt"))]
        self.assertNotIn("reqwest", dashboard_guard)
        self.assertNotIn("icu_collator", dashboard_guard)
        dockerfile = (mod.ROOT / "dimabot" / "dockerfile").read_text()
        self.assertIn("install -m 0755 .saas-native/raid_sessions /usr/local/bin/raid_sessions;", dockerfile)
        self.assertIn("install -m 0755 .saas-native/dashboard_activity /usr/local/bin/dashboard_activity;", dockerfile)
        # Installation happens before the cron image build, and staging is removed.
        self.assertLess(dockerfile.index("/usr/local/bin/dashboard_activity"),
                        dockerfile.index("RUN npm run build"))
        self.assertLess(dockerfile.index("/usr/local/bin/dashboard_activity"), dockerfile.index("rm -rf .saas-native"))
        supervisor_build = '--features "$SAAS_RUST_SUPERVISOR_FEATURES" --bin cron_index'
        self.assertIn(supervisor_build, recipe)
        self.assertLess(recipe.index("install -m 0755 /target-cache/release/dashboard_activity"),
                        recipe.index(supervisor_build))
        self.assertLess(recipe.index(supervisor_build), recipe.index("install -m 0755 /target-cache/release/cron_index"))
        self.assertLess(recipe.index("install -m 0755 /target-cache/release/cron_index"),
                        recipe.index("/artifacts/cron_index --dry-run"))
        self.assertIn("apk add --no-cache build-base python3", recipe)
        self.assertLess(recipe.index("apk add --no-cache build-base python3"), recipe.index("cargo test"))
        self.assertLess(dockerfile.index("/usr/local/bin/cron_index"), dockerfile.index("rm -rf .saas-native"))
        self.assertLess(dockerfile.index("/usr/local/bin/cron_index"), dockerfile.index("RUN npm run build"))

    def test_rust_compiler_has_hard_caps_private_source_and_no_production_mounts(self):
        cache = {"cargo": str(self.root.parent / "cache/cargo"), "target": str(self.root.parent / "cache/target")}
        args = self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        for option in ("--cpus=6", "--memory=6g", "--memory-swap=6g", "--pids-limit=256", "--env=CARGO_BUILD_JOBS=2"):
            self.assertIn(option, args)
        self.assertEqual(args[-4:], [NEW, "sh", "-ceu", mod.RUST_CACHE_HYGIENE])
        self.assertIn(mod.OWNER + ".rust-build=true", args)
        mounts = [args[i + 1] for i, arg in enumerate(args) if arg == "--mount"]
        self.assertEqual(len(mounts), 6)
        self.assertTrue(all(mount.startswith("type=bind,src=" + str(self.path) + "/") for mount in mounts[:4]))
        self.assertEqual(mounts[-2:], [f"type=bind,src={cache['cargo']},dst=/cargo-cache", f"type=bind,src={cache['target']},dst=/target-cache"])
        self.assertIn("--env=CARGO_HOME=/cargo-cache", args)
        self.assertIn("--env=CARGO_TARGET_DIR=/target-cache", args)
        self.assertIn("--env=SAAS_RUST_FEATURES=mongo", args)
        self.assertIn("--env=SAAS_RUST_BASELINE_FEATURES=mongo,redis", args)
        self.assertIn("--env=SAAS_RUST_DASHBOARD_FEATURES=mongo,redis,http-client,unicode-collation", args)
        self.assertIn("--env=SAAS_RUST_SUPERVISOR_FEATURES=cron-supervisor", args)
        self.assertIn("--env=SAAS_RUST_FEATURE_MATRIX=0", args)
        # Bounded compiler/test artifacts; release optimization is untouched.
        for key, value in mod.RUST_ARTIFACT_ENV.items():
            self.assertIn(f"--env={key}={value}", args)
        self.assertEqual(mod.RUST_CACHE_LIMIT, 8 * mod.GIB)
        self.assertEqual(mod.RUST_BUILD_CPUS, 6)
        self.assertEqual(mod.RUST_BUILD_PIDS, 256)
        self.assertEqual(mod.RUST_BUILD_MEMORY_GIB, 6)
        matrix_args = self.ops.rust_container_args(self.path, {**self.receipt, "rust_feature_matrix": True}, NEW, cache)
        self.assertIn("--env=SAAS_RUST_FEATURE_MATRIX=1", matrix_args)
        with patch.object(mod, "RUST_FEATURES", "mongo,postgres"), self.assertRaises(mod.OpsError):
            self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        with patch.object(mod, "RUST_BASELINE_FEATURES", "mongo,redis,http"), self.assertRaises(mod.OpsError):
            self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        with patch.object(mod, "RUST_DASHBOARD_FEATURES", "mongo,redis,http"), self.assertRaises(mod.OpsError):
            self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        with patch.object(mod, "RUST_SUPERVISOR_FEATURES", "cron-supervisor,mongo"), self.assertRaises(mod.OpsError):
            self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        self.assertTrue(any("dst=/source,readonly" in mount for mount in mounts))
        self.assertNotIn("--privileged", args)
        self.assertNotIn("--env-file", args)
        self.assertNotIn("--network=host", args)
        self.assertFalse(any("docker.sock" in arg or ".env" in arg for arg in args))

    def test_lower_memory_compiler_retains_other_caps_and_disables_swap(self):
        cache = {"cargo": "/private/cargo", "target": "/private/target"}
        args = self.ops.rust_container_args(self.path, {**self.receipt, "rust_memory_gib": 4}, NEW, cache)
        for option in ("--cpus=6", "--memory=4g", "--memory-swap=4g", "--pids-limit=256", "--env=CARGO_BUILD_JOBS=2"):
            self.assertIn(option, args)
        for key, value in mod.RUST_ARTIFACT_ENV.items():
            self.assertIn(f"--env={key}={value}", args)

    def test_invalid_memory_caps_are_rejected_in_api_and_receipts(self):
        for value in (0, 3, 5, 8, True, False, 4.0, 6.0, "4", "6", None):
            with self.subTest(value=value):
                with self.assertRaisesRegex(mod.OpsError, "4 or 6 GiB"):
                    self.ops.rust_headroom(memory_gib=value)
                with self.assertRaisesRegex(mod.OpsError, "4 or 6 GiB"):
                    self.ops.rust_container_args(self.path, {**self.receipt, "rust_memory_gib": value}, NEW, {})
                with self.assertRaisesRegex(mod.OpsError, "4 or 6 GiB"):
                    self.ops.build_rust(self.path, {**self.receipt, "rust_memory_gib": value})

    def test_lower_cpu_caps_change_only_cpu_creation_argument(self):
        cache = {"cargo": "/private/cargo", "target": "/private/target"}
        for memory_gib in (4, 6):
            receipt = {**self.receipt, "rust_memory_gib": memory_gib}
            legacy = self.ops.rust_container_args(self.path, receipt, NEW, cache)
            self.assertIn("--cpus=6", legacy)
            for cpus in range(1, 7):
                with self.subTest(cpus=cpus, memory_gib=memory_gib):
                    args = self.ops.rust_container_args(self.path, {**receipt, "rust_cpus": cpus}, NEW, cache)
                    self.assertEqual(args, [f"--cpus={cpus}" if arg == "--cpus=6" else arg for arg in legacy])

    def test_invalid_cpu_caps_are_rejected_before_side_effects_in_api_and_receipts(self):
        for value in (0, -1, 7, 100, True, False, 3.0, 6.0, "3", "6", None):
            with self.subTest(value=value), patch.object(self.ops, "baseline") as baseline, \
                 patch.object(self.ops, "docker") as docker, patch.object(self.ops, "rust_build_lock") as lock:
                if value is not None:  # None in the build API means use the default.
                    with self.assertRaisesRegex(mod.OpsError, "CPUs must be an integer from 1 to 6"):
                        self.ops.build("cron", rust_cpus=value)
                receipt = {**self.receipt, "rust_cpus": value}
                with self.assertRaisesRegex(mod.OpsError, "CPUs must be an integer from 1 to 6"):
                    self.ops.rust_container_args(self.path, receipt, NEW, {})
                with self.assertRaisesRegex(mod.OpsError, "CPUs must be an integer from 1 to 6"):
                    self.ops.build_rust(self.path, receipt)
                with self.assertRaisesRegex(mod.OpsError, "CPUs must be an integer from 1 to 6"):
                    self.ops.verify_rust_limits({}, receipt)
                baseline.assert_not_called()
                docker.assert_not_called()
                lock.assert_not_called()

    def test_selected_cpu_verification_retains_memory_swap_and_pid_guards(self):
        for cpus in range(1, 7):
            for memory_gib in (4, 6):
                receipt = {**self.receipt, "rust_cpus": cpus, "rust_memory_gib": memory_gib}
                limits = {"NanoCpus": cpus * 1_000_000_000, "Memory": memory_gib * mod.GIB,
                          "MemorySwap": memory_gib * mod.GIB, "PidsLimit": 256}
                self.ops.verify_rust_limits({"HostConfig": limits}, receipt)
                for field, value in (("NanoCpus", (cpus + 1) * 1_000_000_000), ("NanoCpus", 0),
                                     ("Memory", 0), ("MemorySwap", -1), ("PidsLimit", 512)):
                    with self.subTest(cpus=cpus, memory_gib=memory_gib, field=field, value=value), \
                         self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
                        self.ops.verify_rust_limits({"HostConfig": {**limits, field: value}}, receipt)
        legacy_limits = {"NanoCpus": 6_000_000_000, "Memory": 6 * mod.GIB,
                         "MemorySwap": 6 * mod.GIB, "PidsLimit": 256}
        self.ops.verify_rust_limits({"HostConfig": legacy_limits}, self.receipt)
        with self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
            self.ops.verify_rust_limits({"HostConfig": {**legacy_limits, "NanoCpus": 3_000_000_000}}, self.receipt)

    def test_rust_release_cache_hygiene_runs_before_recipe_and_fails_closed(self):
        # Execute only tiny mocked commands: no host Cargo/toolchain is invoked.
        commands = self.root.parent / "fake-toolchain"
        commands.mkdir()
        log = self.root.parent / "hygiene.log"
        scripts = {
            "rustup": '#!/bin/sh\nprintf "%s\\n" "fixture-musl (default)"\n',
            "cargo": '#!/bin/sh\nprintf "%s\\n" "$RUSTUP_TOOLCHAIN" "$@" > "$HYGIENE_LOG"\nexit "$CLEAN_EXIT"\n',
            "sh": '#!/bin/sh\nprintf "%s\\n" "recipe:$1" >> "$HYGIENE_LOG"\n',
        }
        for name, source in scripts.items():
            (commands / name).write_text(source)
            (commands / name).chmod(0o755)
        for code in (0, 7):
            with self.subTest(clean_exit=code):
                result = subprocess.run(["/bin/sh", "-ceu", mod.RUST_CACHE_HYGIENE],
                                        env={"PATH": str(commands), "HYGIENE_LOG": str(log), "CLEAN_EXIT": str(code)},
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, code)
                lines = log.read_text().splitlines()
                self.assertEqual(lines[:6], ["fixture-musl", "clean", "--locked", "--release", "--package", "dima-rust"])
                self.assertEqual(lines[6:], ["recipe:/rust-build.sh"] if code == 0 else [])

    def test_rust_compiler_lock_is_global_across_checkout_state(self):
        with patch.object(Path, "home", return_value=self.root):
            with self.ops.rust_build_lock(), self.assertRaises(mod.OpsError):
                with mod.Ops(self.root, self.root / "other-state").rust_build_lock():
                    pass

    def test_rust_recipe_checks_separate_profiles_and_guards_each_graph(self):
        # Run the shell recipe against tiny command mocks, never host Cargo.
        commands = self.root.parent / "recipe-toolchain"
        commands.mkdir()
        scripts = {
            "rustup": '#!/bin/sh\nprintf "%s\\n" "fixture-musl (default)"\n',
            "rustc": '#!/bin/sh\nprintf "%s\\n" "host: x86_64-unknown-linux-musl"\n',
            "apk": '#!/bin/sh\nprintf "apk %s\\n" "$*" >> "$RECIPE_LOG"\n',
            "cargo": '''#!/bin/sh
printf 'cargo %s\\n' "$*" >> "$RECIPE_LOG"
if [ "$1" = tree ]; then
  printf '%s\\n' 'dima-rust v0.1.0'
  case " $* " in
    *' --features cron-supervisor '*) ;;
    *) printf '%s\\n' 'mongodb v3.9.1' ;;
  esac
  case " $* " in
    *' --features cron-supervisor '*) printf '%s\\n' 'redis v1.7.1' 'serde v1.0.229' 'serde_json v1.0.154' 'tokio v1.54.0' 'uuid v1.28.0' 'libc v0.2.191' 'dotenvy v0.15.7' 'icu_normalizer v2.3.0' 'icu_provider v2.3.1'; printf '%s' "$SUPERVISOR_GRAPH_EXTRA" ;;
    *' --features mongo,redis,http-client,unicode-collation '*) printf '%s\\n' 'redis v0.32.7' 'reqwest v0.12.28' 'icu_collator v2.3.0'; printf '%s' "$DASHBOARD_GRAPH_EXTRA" ;;
    *' --features mongo,redis '*) printf '%s\\n' 'redis v0.32.7'; printf '%s' "$BASELINE_GRAPH_EXTRA" ;;
    *) printf '%s' "$MONGO_GRAPH_EXTRA" ;;
  esac
fi
''',
            "install": '''#!/bin/sh
printf 'install %s\\n' "$*" >> "$RECIPE_LOG"
for destination do :; done
printf '%s\\n' '#!/bin/sh' 'printf "dry-run %s %s\\n" "$0" "$*" >> "$RECIPE_LOG"' > "$destination"
/bin/chmod 755 "$destination"
''',
        }
        for name, source in scripts.items():
            (commands / name).write_text(source)
            (commands / name).chmod(0o755)
        recipe = Path(mod.__file__).with_name("rust_build.sh").read_text()
        cases = (
            # Existing three-profile cases retain their original injected graphs.
            ("valid", "", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("mongo-redis", "redis v0.32.7\n", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("mongo-sqlx", "sqlx-core v0.8.6\n", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("mongo-reqwest", "reqwest v0.12.28\n", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("mongo-icu", "icu_collator v2.3.0\n", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("baseline-axum", "", "axum-core v0.5.0\n", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("baseline-sqlx", "", "sqlx v0.8.6\n", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("baseline-reqwest", "", "reqwest v0.12.28\n", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("baseline-icu", "", "icu_collator v2.3.0\n", "mongo,redis", "", "mongo,redis,http-client,unicode-collation"),
            ("dashboard-sqlx", "", "", "mongo,redis", "sqlx-core v0.8.6\n", "mongo,redis,http-client,unicode-collation"),
            ("dashboard-axum", "", "", "mongo,redis", "axum v0.8.0\n", "mongo,redis,http-client,unicode-collation"),
            ("unsupported", "", "", "mongo,redis,http", "", "mongo,redis,http-client,unicode-collation"),
            ("dashboard-unsupported", "", "", "mongo,redis", "", "mongo,redis"),
        )
        cases = tuple(case + ("", "cron-supervisor") for case in cases) + tuple(
            ("supervisor-" + name, "", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation",
             dependency + "\n", "cron-supervisor")
            for name, dependency in (("mongo", "mongodb v3.9.1"), ("mongo-macros", "mongodb-internal-macros v3.9.1"),
                                     ("sqlx", "sqlx v0.9.0"),
                                     ("sqlx-core", "sqlx-core v0.9.0"), ("axum", "axum v0.8.9"),
                                     ("axum-core", "axum-core v0.5.0"), ("reqwest", "reqwest v0.12.28"),
                                     ("icu", "icu_collator v2.3.0"))
        ) + (("supervisor-unsupported", "", "", "mongo,redis", "", "mongo,redis,http-client,unicode-collation",
              "", "cron-supervisor,redis"),)
        for (name, mongo_extra, baseline_extra, baseline_features, dashboard_extra, dashboard_features,
             supervisor_extra, supervisor_features) in cases:
            with self.subTest(case=name):
                work = self.root.parent / ("recipe-" + name)
                work.mkdir()
                artifacts = work / "artifacts"
                artifacts.mkdir()
                log = work / "commands.log"
                script = recipe.replace("/artifacts", str(artifacts)).replace("/target-cache", str(work / "target"))
                result = subprocess.run(["/bin/sh", "-ceu", script],
                                        env={"PATH": str(commands) + ":" + os.defpath, "RECIPE_LOG": str(log),
                                             "MONGO_GRAPH_EXTRA": mongo_extra, "BASELINE_GRAPH_EXTRA": baseline_extra,
                                             "DASHBOARD_GRAPH_EXTRA": dashboard_extra,
                                             "SUPERVISOR_GRAPH_EXTRA": supervisor_extra,
                                             "SAAS_RUST_BASELINE_FEATURES": baseline_features,
                                             "SAAS_RUST_DASHBOARD_FEATURES": dashboard_features,
                                             "SAAS_RUST_SUPERVISOR_FEATURES": supervisor_features},
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0 if name == "valid" else 1, result.stderr)
                lines = log.read_text().splitlines() if log.exists() else []
                if name != "valid":
                    self.assertFalse(any(line.startswith("dry-run ") for line in lines))
                    continue
                builds = [line for line in lines if line.startswith("cargo build ")]
                self.assertIn("apk add --no-cache build-base python3", lines)
                self.assertEqual(builds, [
                    "cargo build --locked --release --no-default-features --features mongo --bin stream_activity --bin raid_analytics --bin roulette_completion",
                    "cargo build --locked --release --no-default-features --features mongo,redis --bin follow_defense_baseline --bin ai_usage_receipts --bin raid_sessions",
                    "cargo build --locked --release --no-default-features --features mongo,redis,http-client,unicode-collation --bin dashboard_activity",
                    "cargo build --locked --release --no-default-features --features cron-supervisor --bin cron_index"])
                for features in ("mongo", "mongo,redis", "mongo,redis,http-client,unicode-collation", "cron-supervisor"):
                    self.assertIn("cargo check --locked --all-targets --no-default-features --features " + features, lines)
                    self.assertIn("cargo clippy --locked --all-targets --no-default-features --features " + features + " -- -D warnings", lines)
                    self.assertIn("cargo test --locked --no-default-features --features " + features, lines)
                self.assertEqual(len([line for line in lines if line.startswith("dry-run ") and line.endswith(" --dry-run")]), 8)
                for binary in ["stream_activity", "raid_analytics", "roulette_completion"]:
                    self.assertIn("dry-run " + str(artifacts / binary) + " --dry-run", lines)
                    self.assertLess(next(i for i, line in enumerate(lines) if line.startswith("install ") and line.endswith("/" + binary)),
                                    lines.index(builds[1]))
                for binary in ["follow_defense_baseline", "ai_usage_receipts", "raid_sessions"]:
                    self.assertIn("dry-run " + str(artifacts / binary) + " --dry-run", lines)
                    self.assertIn("install -m 0755 " + str(work / "target/release" / binary) + " " + str(artifacts / binary), lines)
                # raid_sessions needs the Redis profile and must not come from the Mongo-only build.
                self.assertNotIn("--bin raid_sessions", builds[0])
                self.assertNotIn("--bin dashboard_activity", builds[0])
                self.assertNotIn("--bin dashboard_activity", builds[1])
                self.assertIn("dry-run " + str(artifacts / "dashboard_activity") + " --dry-run", lines)
                self.assertIn("install -m 0755 " + str(work / "target/release/dashboard_activity")
                              + " " + str(artifacts / "dashboard_activity"), lines)
                for binary in mod.RUST_BINARIES:
                    self.assertIn("dry-run " + str(artifacts / binary) + " --dry-run", lines)
                    if binary != "cron_index":
                        self.assertLess(next(i for i, line in enumerate(lines) if line.startswith("install ") and line.endswith("/" + binary)),
                                        lines.index(builds[3]))
                self.assertIn("install -m 0755 " + str(work / "target/release/cron_index")
                              + " " + str(artifacts / "cron_index"), lines)
                self.assertEqual((artifacts / "supervisor-dependencies.txt").read_text().splitlines(),
                                 ["dima-rust v0.1.0", "redis v1.7.1", "serde v1.0.229", "serde_json v1.0.154",
                                  "tokio v1.54.0", "uuid v1.28.0", "libc v0.2.191", "dotenvy v0.15.7",
                                  "icu_normalizer v2.3.0", "icu_provider v2.3.1"])
                self.assertFalse(any("feature-matrix" in line or "--all-features" in line for line in lines))

    def prepared_rust_cache(self, receipt=None):
        source = self.path / "rust-source"
        source.mkdir(exist_ok=True)
        for filename in ("Cargo.toml", "Cargo.lock"):
            if not (source / filename).exists():
                (source / filename).write_text("fixture " + filename)
        if receipt is None:
            receipt = {"rust_toolchain_image": NEW, "rust_recipe_digest": "recipe-v1"}
        with patch.object(Path, "home", return_value=self.root.parent):
            return self.ops.prepare_rust_cache(self.path, receipt)

    def test_rust_cache_reuses_identical_inputs_across_runs_and_worktrees(self):
        first = self.prepared_rust_cache()
        (Path(first["target"]) / "compiled-dependency.rlib").write_text("retained")
        second = self.prepared_rust_cache()
        self.assertFalse(first["hit"])
        self.assertTrue(second["hit"])
        self.assertEqual(first["key"], second["key"])
        with patch.object(mod, "RUST_CACHE_HYGIENE", mod.RUST_CACHE_HYGIENE + "\n# hygiene audit only"):
            self.assertEqual(self.prepared_rust_cache()["key"], first["key"], "cache hygiene does not invalidate dependency artifacts")
        other_root = self.root.parent / "worktree"
        other_root.mkdir()
        other_ops = mod.Ops(other_root, self.root.parent / "other-state")
        with patch.object(Path, "home", return_value=self.root.parent):
            other = other_ops.prepare_rust_cache(self.path, {"rust_toolchain_image": NEW, "rust_recipe_digest": "recipe-v1"})
        self.assertEqual(first["entry"], other["entry"])
        self.assertEqual((Path(other["target"]) / "compiled-dependency.rlib").read_text(), "retained")
        self.assertNotIn(self.root, Path(first["entry"]).parents)

    def test_rust_cache_identity_changes_with_toolchain_manifest_lock_recipe_or_features(self):
        original = self.prepared_rust_cache()
        for field in ("rust_toolchain_image", "rust_recipe_digest"):
            receipt = {"rust_toolchain_image": NEW, "rust_recipe_digest": "recipe-v1"}
            receipt[field] += "changed"
            self.assertNotEqual(self.prepared_rust_cache(receipt)["key"], original["key"])
        for filename in ("Cargo.toml", "Cargo.lock"):
            path = self.path / "rust-source" / filename
            previous = path.read_text()
            path.write_text(previous + " changed")
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
            path.write_text(previous)
        with patch.object(mod, "RUST_FEATURES", "mongo,redis"):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
        with patch.object(mod, "RUST_BASELINE_FEATURES", "mongo"):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
        with patch.object(mod, "RUST_DASHBOARD_FEATURES", "mongo,redis,http-client"):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
        with patch.object(mod, "RUST_SUPERVISOR_FEATURES", "cron-supervisor,redis"):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
        profiles = mod.rust_worker_profiles()
        del profiles["cron-supervisor"]
        with patch.object(mod, "rust_worker_profiles", return_value=profiles):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])
        # Missing or tampered artifact-profile settings must never reuse the old
        # cache entry; the exact mapping is part of the persistent identity.
        for profile_env in (
            {},
            {"CARGO_PROFILE_DEV_DEBUG": "0", "CARGO_PROFILE_TEST_DEBUG": "0"},
            {"CARGO_PROFILE_DEV_DEBUG": "2", "CARGO_PROFILE_TEST_DEBUG": "0", "CARGO_INCREMENTAL": "0"},
            {**mod.RUST_ARTIFACT_ENV, "CARGO_INCREMENTAL": "1"},
        ):
            with patch.object(mod, "RUST_ARTIFACT_ENV", profile_env):
                self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"], profile_env)
                self.assertNotEqual(self.prepared_rust_cache()["entry"], original["entry"], profile_env)
        with patch.object(mod, "RUST_ARTIFACT_ENV", dict(mod.RUST_ARTIFACT_ENV)):
            self.assertEqual(self.prepared_rust_cache()["key"], original["key"])
        profiles = mod.rust_worker_profiles()
        profiles["mongo-redis"]["binaries"].append("another_worker")
        with patch.object(mod, "rust_worker_profiles", return_value=profiles):
            self.assertNotEqual(self.prepared_rust_cache()["key"], original["key"])

    def test_rust_cache_rejects_symlinked_roots_and_paths_inside_checkout(self):
        external = self.root.parent / "external"
        external.mkdir(mode=0o700)
        linked = self.root.parent / "linked-cache"
        linked.symlink_to(external, target_is_directory=True)
        for root in (linked, linked / "child", self.root / "host-target"):
            with self.subTest(root=root), patch.object(self.ops, "rust_cache_root", return_value=root), self.assertRaises(mod.OpsError):
                self.prepared_rust_cache()
        self.assertEqual(list(external.iterdir()), [])

    def test_rust_cache_rejects_nonprivate_or_unmarked_directories(self):
        root = self.root.parent / "unsafe-cache"
        root.mkdir(mode=0o755)
        with patch.object(self.ops, "rust_cache_root", return_value=root), self.assertRaises(mod.OpsError):
            self.prepared_rust_cache()
        root.chmod(0o700)
        (root / "host-artifact").write_text("never import")
        with patch.object(self.ops, "rust_cache_root", return_value=root), self.assertRaises(mod.OpsError):
            self.prepared_rust_cache()
        self.assertEqual((root / "host-artifact").read_text(), "never import")

    def test_rust_cache_rejects_directory_and_marker_ownership_mismatch(self):
        cache = self.prepared_rust_cache()
        owner = os.geteuid()
        if owner != 0:
            self.skipTest("different-owner fixture requires root; ownership checks remain active")
        entry = Path(cache["entry"])
        os.chown(entry, 65534, 65534)
        try:
            with self.assertRaises(mod.OpsError):
                self.ops.rust_cache_usage(cache)
        finally:
            os.chown(entry, owner, os.getegid())
        marker = entry / mod.RUST_CACHE_MARKER
        os.chown(marker, 65534, 65534)
        with self.assertRaises(mod.OpsError):
            self.ops.rust_cache_usage(cache)

    def test_rust_cache_rejects_tampered_markers_and_nested_symlinks_without_following(self):
        cache = self.prepared_rust_cache()
        marker = Path(cache["entry"]) / mod.RUST_CACHE_MARKER
        previous = marker.read_text()
        marker.write_text('{"owner":"another tool"}')
        with self.assertRaises(mod.OpsError):
            self.ops.rust_cache_usage(cache)
        marker.write_text(previous)
        sentinel = self.root.parent / "private-sentinel"
        sentinel.write_text("keep")
        (Path(cache["cargo"]) / "unsafe-link").symlink_to(sentinel)
        with self.assertRaises(mod.OpsError):
            self.ops.rust_cache_usage(cache)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_rust_cache_evicts_only_validated_inactive_entries_and_bounds_active_entry(self):
        first = self.prepared_rust_cache()
        second = self.prepared_rust_cache({"rust_toolchain_image": NEW, "rust_recipe_digest": "recipe-v2"})
        (Path(first["target"]) / "old-dependency").write_bytes(b"x" * 600_000)
        (Path(second["target"]) / "active-dependency").write_bytes(b"x" * 600_000)
        sentinel = self.root.parent / "unrelated"
        sentinel.write_text("keep")
        with patch.object(mod, "RUST_CACHE_LIMIT", 1024 ** 2):
            self.assertLessEqual(self.ops.rust_cache_usage(second), 1024 ** 2)
            self.assertFalse(Path(first["entry"]).exists())
            self.assertTrue(Path(second["target"]).is_dir())
            (Path(second["target"]) / "too-large").write_bytes(b"x" * 1024 ** 2)
            with self.assertRaisesRegex(mod.OpsError, "8 GiB limit"):
                self.ops.rust_cache_usage(second)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_rust_cache_refuses_unknown_entries_instead_of_pruning_them(self):
        cache = self.prepared_rust_cache()
        unowned = Path(cache["root"]) / ("f" * 64)
        unowned.mkdir(mode=0o700)
        (unowned / "host-artifact").write_text("keep")
        with patch.object(mod, "RUST_CACHE_LIMIT", 0), self.assertRaises(mod.OpsError):
            self.ops.rust_cache_usage(cache)
        self.assertTrue((unowned / "host-artifact").is_file())

    def test_rust_feature_matrix_is_explicit_and_only_available_for_cron(self):
        for target in mod.TARGETS:
            if target == "cron":
                continue
            with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                mod.main(["build", target, "--rust-feature-matrix"])
            engine.assert_not_called()
        with patch.object(mod, "Ops") as engine:
            mod.main(["build", "cron", "--rust-feature-matrix"])
            engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=True, rust_memory_gib=None, rust_cpus=None)
        with patch.object(mod, "Ops") as engine:
            mod.main(["build", "cron"])
            engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=False, rust_memory_gib=None, rust_cpus=None)

    def test_rust_memory_option_is_explicit_validated_and_only_available_for_cron(self):
        for target in mod.TARGETS:
            if target == "cron":
                continue
            for memory_gib in (4, 6):
                with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                    mod.main(["build", target, "--rust-memory-gib", str(memory_gib)])
                engine.assert_not_called()
                with patch.object(self.ops, "baseline") as baseline, self.assertRaisesRegex(mod.OpsError, "only supported for cron"):
                    self.ops.build(target, rust_memory_gib=memory_gib)
                baseline.assert_not_called()
        for value in ("3", "5", "8", "4.0", "true"):
            with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                mod.main(["build", "cron", "--rust-memory-gib", value])
            engine.assert_not_called()
        for memory_gib in (4, 6):
            with patch.object(mod, "Ops") as engine:
                mod.main(["build", "cron", "--rust-memory-gib", str(memory_gib)])
                engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=False, rust_memory_gib=memory_gib, rust_cpus=None)

    def test_rust_cpu_option_is_explicit_validated_and_cron_only(self):
        for target in mod.TARGETS:
            if target == "cron":
                continue
            for cpus in (1, 3, 6):
                with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                    mod.main(["build", target, "--rust-cpus", str(cpus)])
                engine.assert_not_called()
                with patch.object(self.ops, "baseline") as baseline, self.assertRaisesRegex(mod.OpsError, "only supported for cron"):
                    self.ops.build(target, rust_cpus=cpus)
                baseline.assert_not_called()
        for value in ("0", "-1", "7", "100", "3.0", "true", ""):
            with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                mod.main(["build", "cron", "--rust-cpus", value])
            engine.assert_not_called()
        for cpus in range(1, 7):
            with patch.object(mod, "Ops") as engine:
                mod.main(["build", "cron", "--rust-cpus", str(cpus), "--rust-memory-gib", "4"])
                engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=False,
                                                                 rust_memory_gib=4, rust_cpus=cpus)
        for command in (["plan", "cron"], ["preview", "site"], ["status", RUN]):
            with contextlib.redirect_stderr(io.StringIO()), patch.object(mod, "Ops") as engine, self.assertRaises(SystemExit):
                mod.main([*command, "--rust-cpus", "3"])
            engine.assert_not_called()

    def test_default_api_dispatch_has_no_cron_cpu_override(self):
        with patch.object(mod, "Ops") as engine:
            mod.main(["build", "api"])
            engine.return_value.build.assert_called_once_with("api", None, rust_feature_matrix=False,
                                                             rust_memory_gib=None, rust_cpus=None)

    def test_default_api_build_does_not_enter_rust_path_or_record_rust_caps(self):
        def snapshot(target, destination, source_dir):
            destination.mkdir()
        with patch.object(self.ops, "baseline", return_value=(self.ops.current, {}, "hash", "digest")), \
             patch.object(self.ops, "snapshot", side_effect=snapshot), patch.object(self.ops, "build_rust") as compile_rust, \
             patch.object(self.ops, "inspect", return_value={"Id": NEW}), contextlib.redirect_stdout(io.StringIO()):
            self.ops.build("api")
        compile_rust.assert_not_called()
        receipts = list(self.ops.state.glob("api-*/receipt.json"))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text())
        self.assertEqual(receipt["status"], "built")
        self.assertNotIn("rust_cpus", receipt)
        self.assertNotIn("rust_memory_gib", receipt)
        self.assertEqual([call[0] for call in self.ops.calls], ["build"])

    def test_cron_build_persists_resource_options_before_compiling(self):
        def snapshot(target, destination, source_dir):
            destination.mkdir()
        def compile_rust(path, receipt, source_dir, **kwargs):
            self.assertEqual(receipt["rust_memory_gib"], 4)
            self.assertEqual(receipt["rust_cpus"], 3)
            self.assertEqual(json.loads((path / "receipt.json").read_text())["rust_memory_gib"], 4)
            self.assertEqual(json.loads((path / "receipt.json").read_text())["rust_cpus"], 3)
        with patch.object(self.ops, "baseline", return_value=(self.ops.current, {}, "hash", "digest")), \
             patch.object(self.ops, "snapshot", side_effect=snapshot), \
             patch.object(self.ops, "build_rust", side_effect=compile_rust), \
             patch.object(self.ops, "inspect", return_value={"Id": NEW}), contextlib.redirect_stdout(io.StringIO()):
            self.ops.build("cron", rust_memory_gib=4, rust_cpus=3)
        receipts = list(self.ops.state.glob("cron-*/receipt.json"))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(json.loads(receipts[0].read_text())["rust_memory_gib"], 4)
        self.assertEqual(json.loads(receipts[0].read_text())["rust_cpus"], 3)

    def test_cron_plan_exposes_worker_features_cache_caps_and_optional_matrix_without_writes(self):
        output = io.StringIO()
        with patch.object(mod, "Ops") as engine, contextlib.redirect_stdout(output):
            engine.return_value.baseline.return_value = ({"Image": NEW}, {}, "hash", "digest")
            engine.return_value.rust_cache_root.return_value = self.root.parent / "private-cache"
            mod.main(["plan", "cron"])
            engine.return_value.lock.assert_not_called()
        details = json.loads(output.getvalue())["rust"]
        self.assertEqual(details["features"], "mongo")
        self.assertEqual(details["worker_profiles"]["mongo"]["binaries"], ["stream_activity", "raid_analytics", "roulette_completion"])
        self.assertEqual(details["worker_profiles"]["mongo-redis"]["features"], "mongo,redis")
        self.assertEqual(details["worker_profiles"]["mongo-redis"]["binaries"], ["follow_defense_baseline", "ai_usage_receipts", "raid_sessions"])
        self.assertEqual(details["worker_profiles"]["dashboard"]["features"], "mongo,redis,http-client,unicode-collation")
        self.assertEqual(details["worker_profiles"]["dashboard"]["binaries"], ["dashboard_activity"])
        self.assertEqual(details["worker_profiles"]["dashboard"]["graph"], "dashboard-worker-dependencies.txt")
        self.assertEqual(details["worker_profiles"]["cron-supervisor"], {
            "features": "cron-supervisor", "default_features": False,
            "binaries": ["cron_index"], "graph": "supervisor-dependencies.txt"})
        self.assertEqual(details["cache_limit_bytes"], 8 * mod.GIB)
        self.assertEqual(details["jobs"], 2)
        self.assertEqual(details["cpus"], 6)
        self.assertEqual(details["memory_bytes"], 6 * mod.GIB)
        self.assertEqual(details["profile_env"], mod.RUST_ARTIFACT_ENV)
        self.assertEqual(details["profile_env"], {"CARGO_PROFILE_DEV_DEBUG": "0",
                                                  "CARGO_PROFILE_TEST_DEBUG": "0", "CARGO_INCREMENTAL": "0"})
        self.assertEqual(details["optional_lower_memory"], "build cron --rust-memory-gib 4")
        self.assertEqual(details["optional_lower_cpus"], "build cron --rust-cpus 3")
        self.assertEqual(details["optional_feature_matrix"], "build cron --rust-feature-matrix")

    def test_rust_build_refuses_orphaned_compiler_before_copying_source(self):
        with patch.object(self.ops, "docker", return_value="orphan-id\n"), \
             patch.object(Path, "home", return_value=self.root), self.assertRaises(mod.OpsError):
            self.ops.build_rust(self.path, self.receipt)
        self.assertFalse((self.path / "rust-source").exists())

    def test_rust_headroom_requires_10_gib_at_start_and_4_gib_while_running(self):
        for starting, minimum_gib in ((True, 10), (False, 4)):
            for offset_kib in (-1, 0, 1):
                with self.subTest(starting=starting, offset_kib=offset_kib):
                    available_kib = minimum_gib * 1024 ** 2 + offset_kib
                    with patch.object(Path, "read_text", return_value=f"MemAvailable: {available_kib} kB\n"), \
                         patch.object(mod.os, "getloadavg", return_value=(0, 0, 0)), \
                         patch.object(mod.shutil, "disk_usage", return_value=type("Disk", (), {"free": 10 * mod.GIB})()):
                        if offset_kib < 0:
                            with self.assertRaisesRegex(mod.OpsError, "memory headroom"):
                                self.ops.rust_headroom(starting=starting)
                        else:
                            details = self.ops.rust_headroom(starting=starting)
                            self.assertEqual(details["mem_available_bytes"], available_kib * 1024)

    def test_lower_memory_rust_headroom_requires_8_gib_at_start_and_4_gib_while_running(self):
        for starting, minimum_gib in ((True, 8), (False, 4)):
            for offset_kib in (-1, 0, 1):
                with self.subTest(starting=starting, offset_kib=offset_kib):
                    available_kib = minimum_gib * 1024 ** 2 + offset_kib
                    with patch.object(Path, "read_text", return_value=f"MemAvailable: {available_kib} kB\n"), \
                         patch.object(mod.os, "getloadavg", return_value=(0, 0, 0)), \
                         patch.object(mod.shutil, "disk_usage", return_value=type("Disk", (), {"free": 10 * mod.GIB})()):
                        if offset_kib < 0:
                            with self.assertRaisesRegex(mod.OpsError, "memory headroom"):
                                self.ops.rust_headroom(starting=starting, memory_gib=4)
                        else:
                            details = self.ops.rust_headroom(starting=starting, memory_gib=4)
                            self.assertEqual(details["mem_available_bytes"], available_kib * 1024)

    def test_rust_headroom_refuses_host_load_and_disk_pressure(self):
        with patch.object(Path, "read_text", return_value="MemAvailable: 16777216 kB\n"), \
             patch.object(mod.os, "getloadavg", return_value=(1000, 0, 0)), self.assertRaisesRegex(mod.OpsError, "host load"):
            self.ops.rust_headroom()
        with patch.object(Path, "read_text", return_value="MemAvailable: 16777216 kB\n"), \
             patch.object(mod.os, "getloadavg", return_value=(0, 0, 0)), \
             patch.object(mod.shutil, "disk_usage", return_value=type("Disk", (), {"free": 5 * mod.GIB - 1})()), \
             self.assertRaisesRegex(mod.OpsError, "disk headroom"):
            self.ops.rust_headroom()

    def simulated_rust_build(self, *, exit_code=0, applied_limits=None, raid_artifact="valid", baseline_artifact="valid",
                             roulette_artifact="valid", receipts_artifact="valid", sessions_artifact="valid",
                             dashboard_artifact="valid", supervisor_artifact="valid",
                             mongo_extra="", baseline_extra="", dashboard_extra="", supervisor_extra="",
                             supervisor_graph="valid", cache_bytes=0, memory_gib=6, cpus=6):
        self.rust_source()
        (self.path / "source").mkdir()
        self.ops.objects[("image", mod.RUST_BUILD_IMAGE)] = {"Id": NEW}
        name = "saas-ops-" + RUN + "-rust-build"
        original_docker = self.ops.docker
        def docker(*args, **kwargs):
            if args[0] == "create":
                self.ops.objects[("container", name)] = {
                    "Id": "compiler-id", "Config": {"Labels": self.labels()},
                    "HostConfig": {"NanoCpus": cpus * 1_000_000_000, "Memory": memory_gib * mod.GIB,
                                   "MemorySwap": memory_gib * mod.GIB, "PidsLimit": 256, **(applied_limits or {})},
                    "State": {"Running": False, "ExitCode": exit_code}}
            elif args[0] == "start":
                (self.path / "rust-artifacts/worker-dependencies.txt").write_text("dima-rust v0.1.0\nmongodb v3.9.1\n" + mongo_extra)
                (self.path / "rust-artifacts/baseline-worker-dependencies.txt").write_text("dima-rust v0.1.0\nmongodb v3.9.1\nredis v0.32.7\n" + baseline_extra)
                (self.path / "rust-artifacts/dashboard-worker-dependencies.txt").write_text(
                    "dima-rust v0.1.0\nmongodb v3.9.1\nredis v0.32.7\nreqwest v0.12.28\nicu_collator v2.3.0\n" + dashboard_extra)
                graph = self.path / "rust-artifacts/supervisor-dependencies.txt"
                if supervisor_graph == "valid":
                    graph.write_text("dima-rust v0.1.0\nredis v1.7.1\nserde v1.0.229\nserde_json v1.0.154\n"
                                     "tokio v1.54.0\nuuid v1.28.0\nlibc v0.2.191\ndotenvy v0.15.7\nicu_normalizer v2.3.0\nicu_provider v2.3.1\n" + supervisor_extra)
                elif supervisor_graph == "symlink":
                    graph.symlink_to(self.path / "rust-artifacts/worker-dependencies.txt")
                elif supervisor_graph == "oversized":
                    graph.write_bytes(b"x" * 262145)
                if cache_bytes:
                    (Path(self.receipt["rust_cache"]["target"]) / "dependency").write_bytes(b"x" * cache_bytes)
                (self.path / "rust-artifacts/stream_activity").write_bytes(b"\x7fELFfixture")
                raid = self.path / "rust-artifacts/raid_analytics"
                if raid_artifact == "valid":
                    raid.write_bytes(b"\x7fELFraidfixture")
                elif raid_artifact == "invalid":
                    raid.write_bytes(b"unverified host artifact")
                elif raid_artifact == "symlink":
                    raid.symlink_to(self.path / "rust-artifacts/stream_activity")
                baseline = self.path / "rust-artifacts/follow_defense_baseline"
                if baseline_artifact == "valid":
                    baseline.write_bytes(b"\x7fELFbaselinefixture")
                elif baseline_artifact == "invalid":
                    baseline.write_bytes(b"unverified host artifact")
                elif baseline_artifact == "symlink":
                    baseline.symlink_to(self.path / "rust-artifacts/stream_activity")
                roulette = self.path / "rust-artifacts/roulette_completion"
                if roulette_artifact == "valid":
                    roulette.write_bytes(b"\x7fELFroulettefixture")
                elif roulette_artifact == "invalid":
                    roulette.write_bytes(b"unverified host artifact")
                elif roulette_artifact == "symlink":
                    roulette.symlink_to(self.path / "rust-artifacts/stream_activity")
                receipts = self.path / "rust-artifacts/ai_usage_receipts"
                if receipts_artifact == "valid":
                    receipts.write_bytes(b"\x7fELFreceiptsfixture")
                elif receipts_artifact == "invalid":
                    receipts.write_bytes(b"unverified host artifact")
                elif receipts_artifact == "symlink":
                    receipts.symlink_to(self.path / "rust-artifacts/stream_activity")
                sessions = self.path / "rust-artifacts/raid_sessions"
                if sessions_artifact == "valid":
                    sessions.write_bytes(b"\x7fELFsessionsfixture")
                elif sessions_artifact == "invalid":
                    sessions.write_bytes(b"unverified host artifact")
                elif sessions_artifact == "symlink":
                    sessions.symlink_to(self.path / "rust-artifacts/stream_activity")
                dashboard = self.path / "rust-artifacts/dashboard_activity"
                if dashboard_artifact == "valid":
                    dashboard.write_bytes(b"\x7fELFdashboardfixture")
                elif dashboard_artifact == "invalid":
                    dashboard.write_bytes(b"unverified host artifact")
                elif dashboard_artifact == "symlink":
                    dashboard.symlink_to(self.path / "rust-artifacts/stream_activity")
                supervisor = self.path / "rust-artifacts/cron_index"
                if supervisor_artifact == "valid":
                    supervisor.write_bytes(b"\x7fELFsupervisorfixture")
                elif supervisor_artifact == "invalid":
                    supervisor.write_bytes(b"unverified host artifact")
                elif supervisor_artifact == "symlink":
                    supervisor.symlink_to(self.path / "rust-artifacts/stream_activity")
                (self.path / "rust-artifacts/toolchain.txt").write_text("host: x86_64-unknown-linux-musl")
            return original_docker(*args, **kwargs)
        return patch.object(self.ops, "docker", side_effect=docker)

    def test_rust_build_rejects_incorrect_applied_limits_before_start(self):
        for limits in ({"NanoCpus": 4_000_000_000}, {"Memory": 4 * mod.GIB},
                       {"MemorySwap": 4 * mod.GIB}, {"MemorySwap": 8 * mod.GIB}, {"PidsLimit": 512}):
            with self.subTest(limits=limits):
                for directory in (self.root / "dimabot", self.path / "source", self.path / "rust-source",
                                  self.path / "rust-artifacts"):
                    if directory.exists():
                        mod.shutil.rmtree(directory)
                self.ops.calls.clear()
                simulation = self.simulated_rust_build(applied_limits=limits)
                with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
                     patch.object(Path, "home", return_value=self.root.parent), \
                     self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
                    self.ops.build_rust(self.path, self.receipt)
                self.assertFalse(any(call[0] == "start" for call in self.ops.calls))
                self.assertFalse((self.path / "source/.saas-native").exists())
                self.assertFalse((self.path / "rust-work").exists())
                self.assertEqual(self.receipt["resources"], [])
                self.assertNotIn(("container", "saas-ops-" + RUN + "-rust-build"), self.ops.objects)

    def test_lower_resource_build_uses_receipt_limits_for_start_monitor_and_cgroups(self):
        self.receipt["rust_cpus"] = 3
        self.receipt["rust_memory_gib"] = 4
        simulation = self.simulated_rust_build(memory_gib=4, cpus=3)
        original_inspect = self.ops.inspect
        compiler_inspections = 0
        def inspect(kind, name, missing=False):
            nonlocal compiler_inspections
            obj = original_inspect(kind, name, missing)
            if kind == "container" and obj:
                compiler_inspections += 1
                # The first inspection checks caps; the next simulates running.
                obj["State"]["Running"] = compiler_inspections == 2
            return obj
        output = io.StringIO()
        with simulation, patch.object(self.ops, "inspect", side_effect=inspect), contextlib.redirect_stdout(output), \
             patch.object(self.ops, "verify_rust_limits", wraps=self.ops.verify_rust_limits) as verify_limits, \
             patch.object(self.ops, "rust_headroom", return_value={"mem_available_bytes": 8 * mod.GIB}) as headroom, \
             patch.object(mod.time, "sleep"), patch.object(Path, "home", return_value=self.root.parent):
            self.ops.build_rust(self.path, self.receipt)
        self.assertEqual([call.kwargs for call in headroom.call_args_list],
                         [{"starting": True, "memory_gib": 4}, {"starting": True, "memory_gib": 4}, {"memory_gib": 4}])
        create = next(call for call in self.ops.calls if call[0] == "create")
        self.assertIn("--cpus=3", create)
        self.assertIn("--memory=4g", create)
        self.assertIn("--memory-swap=4g", create)
        self.assertEqual(self.saved()["rust_memory_gib"], 4)
        self.assertEqual(self.saved()["rust_cpus"], 3)
        self.assertEqual(verify_limits.call_count, 3)  # Before start, while running, and on completion.
        self.assertIn("3 CPUs/4 GiB", output.getvalue())
        self.assertTrue((self.path / "source/.saas-native/stream_activity").is_file())
        self.assertEqual(self.receipt["resources"], [])

    def test_lower_cpu_build_refuses_default_cpu_cgroups_before_start(self):
        self.receipt["rust_cpus"] = 3
        simulation = self.simulated_rust_build()
        with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
             patch.object(Path, "home", return_value=self.root.parent), \
             self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
            self.ops.build_rust(self.path, self.receipt)
        self.assertFalse(any(call[0] == "start" for call in self.ops.calls))
        self.assertFalse((self.path / "source/.saas-native").exists())
        self.assertEqual(self.receipt["resources"], [])

    def test_cpu_drift_while_running_or_on_exit_refuses_artifacts_and_cleans_compiler(self):
        for running in (True, False):
            with self.subTest(running=running):
                for directory in (self.root / "dimabot", self.path / "source", self.path / "rust-source",
                                  self.path / "rust-artifacts"):
                    if directory.exists():
                        mod.shutil.rmtree(directory)
                self.ops.calls.clear()
                self.receipt["rust_cpus"] = 3
                simulation = self.simulated_rust_build(cpus=3)
                original_inspect = self.ops.inspect
                def inspect(kind, name, missing=False):
                    obj = original_inspect(kind, name, missing)
                    if kind == "container" and obj and any(call[0] == "start" for call in self.ops.calls):
                        obj["State"]["Running"] = running
                        obj["HostConfig"]["NanoCpus"] = 6_000_000_000
                    return obj
                with simulation, patch.object(self.ops, "inspect", side_effect=inspect), \
                     patch.object(self.ops, "rust_headroom", return_value={}), \
                     patch.object(Path, "home", return_value=self.root.parent), \
                     self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
                    self.ops.build_rust(self.path, self.receipt)
                self.assertTrue(any(call[0] == "start" for call in self.ops.calls))
                self.assertFalse((self.path / "source/.saas-native").exists())
                self.assertEqual(self.receipt["resources"], [])
                self.assertNotIn(("container", "saas-ops-" + RUN + "-rust-build"), self.ops.objects)

    def test_lower_memory_build_refuses_default_cgroups_before_start(self):
        self.receipt["rust_memory_gib"] = 4
        simulation = self.simulated_rust_build(memory_gib=6)
        with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
             patch.object(Path, "home", return_value=self.root.parent), \
             self.assertRaisesRegex(mod.OpsError, "cgroup limits"):
            self.ops.build_rust(self.path, self.receipt)
        self.assertFalse(any(call[0] == "start" for call in self.ops.calls))
        self.assertFalse((self.path / "source/.saas-native").exists())
        self.assertEqual(self.receipt["resources"], [])

    def test_rust_build_records_immutable_toolchain_source_artifact_and_cleans_compiler(self):
        simulation = self.simulated_rust_build()
        with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
             patch.object(Path, "home", return_value=self.root.parent):
            self.ops.build_rust(self.path, self.receipt)
        self.assertEqual(self.receipt["rust_toolchain_image"], NEW)
        self.assertEqual(self.saved()["rust_memory_gib"], 6)
        self.assertEqual(self.saved()["rust_cpus"], 6)
        self.assertEqual(self.receipt["rust_source_digest"], mod.tree_hash(self.path / "rust-source"))
        self.assertEqual(self.receipt["rust_binary_digest"], mod.digest(b"\x7fELFfixture"))
        self.assertEqual(self.receipt["rust_worker_dependencies_digest"], mod.digest(b"dima-rust v0.1.0\nmongodb v3.9.1\n"))
        self.assertEqual(self.receipt["rust_binary_digests"], {
            "stream_activity": mod.digest(b"\x7fELFfixture"), "raid_analytics": mod.digest(b"\x7fELFraidfixture"),
            "follow_defense_baseline": mod.digest(b"\x7fELFbaselinefixture"),
            "roulette_completion": mod.digest(b"\x7fELFroulettefixture"),
            "ai_usage_receipts": mod.digest(b"\x7fELFreceiptsfixture"),
            "raid_sessions": mod.digest(b"\x7fELFsessionsfixture"),
            "dashboard_activity": mod.digest(b"\x7fELFdashboardfixture"),
            "cron_index": mod.digest(b"\x7fELFsupervisorfixture")})
        for binary in mod.RUST_BINARIES:
            metadata = self.receipt["rust_binary_metadata"][binary]
            profile = ("mongo-redis" if binary in ("follow_defense_baseline", "ai_usage_receipts", "raid_sessions")
                       else "dashboard" if binary == "dashboard_activity"
                       else "cron-supervisor" if binary == "cron_index" else "mongo")
            self.assertEqual(metadata["profile"], profile)
            self.assertEqual(metadata["features"], {"mongo": "mongo", "mongo-redis": "mongo,redis",
                                                    "dashboard": "mongo,redis,http-client,unicode-collation",
                                                    "cron-supervisor": "cron-supervisor"}[profile])
            self.assertFalse(metadata["default_features"])
            self.assertEqual(metadata["binary_digest"], self.receipt["rust_binary_digests"][binary])
            self.assertEqual(metadata["dependency_graph_digest"], self.receipt["rust_worker_profiles"][profile]["dependency_graph_digest"])
        self.assertNotEqual(self.receipt["rust_worker_profiles"]["mongo"]["dependency_graph_digest"],
                            self.receipt["rust_worker_profiles"]["mongo-redis"]["dependency_graph_digest"])
        self.assertNotEqual(self.receipt["rust_worker_profiles"]["mongo-redis"]["dependency_graph_digest"],
                            self.receipt["rust_worker_profiles"]["dashboard"]["dependency_graph_digest"])
        staged = self.path / "source/.saas-native/stream_activity"
        self.assertEqual(staged.read_bytes(), b"\x7fELFfixture")
        self.assertEqual(staged.stat().st_mode & 0o777, 0o755)
        raid_staged = self.path / "source/.saas-native/raid_analytics"
        self.assertEqual(raid_staged.read_bytes(), b"\x7fELFraidfixture")
        self.assertEqual(raid_staged.stat().st_mode & 0o777, 0o755)
        baseline_staged = self.path / "source/.saas-native/follow_defense_baseline"
        self.assertEqual(baseline_staged.read_bytes(), b"\x7fELFbaselinefixture")
        self.assertEqual(baseline_staged.stat().st_mode & 0o777, 0o755)
        roulette_staged = self.path / "source/.saas-native/roulette_completion"
        self.assertEqual(roulette_staged.read_bytes(), b"\x7fELFroulettefixture")
        self.assertEqual(roulette_staged.stat().st_mode & 0o777, 0o755)
        receipts_staged = self.path / "source/.saas-native/ai_usage_receipts"
        self.assertEqual(receipts_staged.read_bytes(), b"\x7fELFreceiptsfixture")
        self.assertEqual(receipts_staged.stat().st_mode & 0o777, 0o755)
        sessions_staged = self.path / "source/.saas-native/raid_sessions"
        self.assertEqual(sessions_staged.read_bytes(), b"\x7fELFsessionsfixture")
        self.assertEqual(sessions_staged.stat().st_mode & 0o777, 0o755)
        dashboard_staged = self.path / "source/.saas-native/dashboard_activity"
        self.assertEqual(dashboard_staged.read_bytes(), b"\x7fELFdashboardfixture")
        self.assertEqual(dashboard_staged.stat().st_mode & 0o777, 0o755)
        supervisor_staged = self.path / "source/.saas-native/cron_index"
        self.assertEqual(supervisor_staged.read_bytes(), b"\x7fELFsupervisorfixture")
        self.assertEqual(supervisor_staged.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.receipt["rust_binary_metadata"]["cron_index"]["profile"], "cron-supervisor")
        self.assertNotEqual(self.receipt["rust_worker_profiles"]["dashboard"]["dependency_graph_digest"],
                            self.receipt["rust_worker_profiles"]["cron-supervisor"]["dependency_graph_digest"])
        self.assertEqual(sorted(file.name for file in supervisor_staged.parent.iterdir()), sorted(mod.RUST_BINARIES))
        # The seventh worker owns the dashboard Mongo+Redis+HTTP graph.
        self.assertEqual(self.receipt["rust_binary_metadata"]["dashboard_activity"]["features"], "mongo,redis,http-client,unicode-collation")
        self.assertEqual(self.receipt["rust_binary_metadata"]["dashboard_activity"]["profile"], "dashboard")
        self.assertEqual(self.receipt["rust_binary_metadata"]["dashboard_activity"]["dependency_graph_digest"],
                         self.receipt["rust_worker_profiles"]["dashboard"]["dependency_graph_digest"])
        # The sixth worker shares the baseline Mongo+Redis graph, not the Mongo-only one.
        self.assertEqual(self.receipt["rust_binary_metadata"]["raid_sessions"]["features"], "mongo,redis")
        self.assertEqual(self.receipt["rust_binary_metadata"]["raid_sessions"]["profile"], "mongo-redis")
        self.assertEqual(self.receipt["rust_binary_metadata"]["raid_sessions"]["dependency_graph_digest"],
                         self.receipt["rust_worker_profiles"]["mongo-redis"]["dependency_graph_digest"])
        self.assertEqual(self.receipt["resources"], [])
        self.assertFalse((self.path / "rust-work").exists())
        self.assertNotIn(("container", "saas-ops-" + RUN + "-rust-build"), self.ops.objects)
        self.assertTrue(Path(self.receipt["rust_cache"]["cargo"]).is_dir())
        self.assertTrue(Path(self.receipt["rust_cache"]["target"]).is_dir())
        self.assertEqual(self.receipt["rust_features"], "mongo")
        self.assertEqual(self.receipt["rust_build_profile_env"], {"CARGO_PROFILE_DEV_DEBUG": "0",
                                                                  "CARGO_PROFILE_TEST_DEBUG": "0", "CARGO_INCREMENTAL": "0"})
        self.assertEqual(self.receipt["rust_cache"]["key"], mod.digest(json.dumps({
            "toolchain": NEW, "features": mod.RUST_FEATURES, "profiles": mod.RUST_PROFILES,
            "worker_profiles": mod.rust_worker_profiles(), "profile_env": mod.RUST_ARTIFACT_ENV,
            "recipe": self.receipt["rust_recipe_digest"],
            "manifest": mod.digest((self.path / "rust-source/Cargo.toml").read_bytes()),
            "lock": mod.digest((self.path / "rust-source/Cargo.lock").read_bytes()),
        }, sort_keys=True).encode()))
        self.assertFalse(self.receipt["rust_feature_matrix"])
        self.assertTrue(self.receipt["rust_cache"]["project_release_clean"])
        self.assertEqual(self.receipt["rust_cache_hygiene_digest"], mod.digest(mod.RUST_CACHE_HYGIENE.encode()))
        self.ops.cleanup(RUN)
        self.assertFalse((self.path / "rust-source").exists())
        self.assertTrue(Path(self.receipt["rust_cache"]["cargo"]).is_dir())
        self.assertTrue(Path(self.receipt["rust_cache"]["target"]).is_dir())

    def test_oversized_active_rust_cache_stops_build_then_cleans_only_after_compiler_removal(self):
        simulation = self.simulated_rust_build(cache_bytes=128 * 1024)
        with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
             patch.object(Path, "home", return_value=self.root.parent), \
             patch.object(mod, "RUST_CACHE_LIMIT", 64 * 1024), self.assertRaises(mod.OpsError):
            self.ops.build_rust(self.path, self.receipt)
        self.assertEqual(self.receipt["resources"], [])
        self.assertNotIn(("container", "saas-ops-" + RUN + "-rust-build"), self.ops.objects)
        self.assertFalse(Path(self.receipt["rust_cache"]["entry"]).exists())
        self.assertFalse((self.path / "source/.saas-native").exists())

    def test_rust_build_failure_or_wrong_cgroups_never_stages_artifact(self):
        for failure in ("checks", "limits", "missing", "invalid", "symlink", "baseline_missing", "baseline_invalid",
                        "baseline_symlink", "roulette_missing", "roulette_invalid", "roulette_symlink",
                        "receipts_missing", "receipts_invalid", "receipts_symlink",
                        "sessions_missing", "sessions_invalid", "sessions_symlink",
                        "dashboard_missing", "dashboard_invalid", "dashboard_symlink",
                        "supervisor_missing", "supervisor_invalid", "supervisor_symlink",
                        "supervisor_graph_missing", "supervisor_graph_symlink", "supervisor_graph_oversized",
                        "mongo_redis", "mongo_axum", "mongo_reqwest", "mongo_icu",
                        "baseline_sqlx", "baseline_axum", "baseline_reqwest", "baseline_icu",
                        "dashboard_sqlx", "dashboard_axum",
                        "supervisor_mongo", "supervisor_mongo_macros", "supervisor_sqlx", "supervisor_sqlx_core",
                        "supervisor_axum", "supervisor_axum_core",
                        "supervisor_reqwest", "supervisor_icu"):
            with self.subTest(failure=failure):
                # Each simulation uses the same task-owned directories, cleared here.
                for directory in ("dimabot",):
                    if (self.root / directory).exists():
                        mod.shutil.rmtree(self.root / directory)
                for directory in ("source", "rust-source", "rust-artifacts"):
                    if (self.path / directory).exists():
                        mod.shutil.rmtree(self.path / directory)
                simulation = self.simulated_rust_build(exit_code=1 if failure == "checks" else 0,
                                                       applied_limits={"NanoCpus": 4_000_000_000, "Memory": 4 * mod.GIB,
                                                                       "MemorySwap": 4 * mod.GIB} if failure == "limits" else None,
                                                       raid_artifact=failure if failure in ("missing", "invalid", "symlink") else "valid",
                                                       baseline_artifact=failure.removeprefix("baseline_") if failure in ("baseline_missing", "baseline_invalid", "baseline_symlink") else "valid",
                                                       roulette_artifact=failure.removeprefix("roulette_") if failure in ("roulette_missing", "roulette_invalid", "roulette_symlink") else "valid",
                                                       receipts_artifact=failure.removeprefix("receipts_") if failure in ("receipts_missing", "receipts_invalid", "receipts_symlink") else "valid",
                                                       sessions_artifact=failure.removeprefix("sessions_") if failure in ("sessions_missing", "sessions_invalid", "sessions_symlink") else "valid",
                                                       dashboard_artifact=failure.removeprefix("dashboard_") if failure in ("dashboard_missing", "dashboard_invalid", "dashboard_symlink") else "valid",
                                                       supervisor_artifact=failure.removeprefix("supervisor_") if failure in ("supervisor_missing", "supervisor_invalid", "supervisor_symlink") else "valid",
                                                       supervisor_graph=failure.removeprefix("supervisor_graph_") if failure.startswith("supervisor_graph_") else "valid",
                                                       mongo_extra={"mongo_redis": "redis v0.32.7\n", "mongo_axum": "axum-core v0.5.0\n",
                                                                    "mongo_reqwest": "reqwest v0.12.28\n", "mongo_icu": "icu_collator v2.3.0\n"}.get(failure, ""),
                                                       baseline_extra={"baseline_sqlx": "sqlx-core v0.8.6\n", "baseline_axum": "axum v0.8.0\n",
                                                                       "baseline_reqwest": "reqwest v0.12.28\n", "baseline_icu": "icu_collator v2.3.0\n"}.get(failure, ""),
                                                       dashboard_extra={"dashboard_sqlx": "sqlx-core v0.8.6\n",
                                                                        "dashboard_axum": "axum v0.8.0\n"}.get(failure, ""),
                                                       supervisor_extra={"supervisor_mongo": "mongodb v3.9.1\n",
                                                                         "supervisor_mongo_macros": "mongodb-internal-macros v3.9.1\n",
                                                                         "supervisor_sqlx": "sqlx v0.9.0\n",
                                                                         "supervisor_sqlx_core": "sqlx-core v0.9.0\n",
                                                                         "supervisor_axum": "axum v0.8.9\n",
                                                                         "supervisor_axum_core": "axum-core v0.5.0\n",
                                                                         "supervisor_reqwest": "reqwest v0.12.28\n",
                                                                         "supervisor_icu": "icu_collator v2.3.0\n"}.get(failure, ""))
                with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
                     patch.object(Path, "home", return_value=self.root.parent), self.assertRaises(mod.OpsError):
                    self.ops.build_rust(self.path, self.receipt)
                self.assertFalse((self.path / "source/.saas-native").exists())
                self.assertFalse((self.path / "rust-work").exists())
                self.assertEqual(self.receipt["resources"], [])

    def test_only_cron_candidate_gets_capabilities_for_unprivileged_native_child(self):
        check = self.root / "check.mjs"
        check.write_text("process.exit(0)")
        inspected = {"Id": "test-id", "Config": {"Labels": self.labels()}}
        for target in ("cron", "bot", "api"):
            self.ops.calls.clear()
            self.receipt["target"] = target
            with patch.object(self.ops, "readiness"), patch.object(self.ops, "inspect", return_value=inspected):
                self.ops.verify_container(self.path, self.receipt, mod.TARGETS[target], check, None, False, None, ())
            create = next(call for call in self.ops.calls if call[0] == "create")
            caps = [create[i + 1] for i, arg in enumerate(create) if arg == "--cap-add"]
            self.assertEqual(caps, ["SETUID", "SETGID", "KILL"] if target == "cron" else [])
            self.assertEqual(create[create.index("--cap-drop") + 1], "ALL")

    def website(self):
        target = mod.TARGETS["site"]
        output = self.root / target.project / target.output
        output.mkdir(parents=True)
        (output / "index.html").write_text("old homepage")
        (output / "old.js").write_text("old script")
        bundle = self.path / "bundle"
        bundle.mkdir()
        (bundle / "index.html").write_text("new homepage")
        (bundle / "new.js").write_text("new script")
        (bundle / "new-page.html").write_text("new page")
        self.receipt.update(target="site", artifact_digest=mod.tree_hash(bundle), baseline_bundle=mod.tree_hash(output))
        self.ops.current["Mounts"] = [{"Destination": "/usr/share/nginx/html", "Source": str(output), "Type": "bind", "RW": False}]
        self.ops.save(self.path, self.receipt)
        return output

    def test_frontend_failure_restores_previous_pages_and_keeps_old_assets(self):
        output = self.website()
        with patch.object(self.ops, "verify_served", side_effect=[mod.OpsError("new page failed"), None]), self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual((output / "index.html").read_text(), "old homepage")
        self.assertTrue((output / "old.js").exists())
        self.assertFalse((output / "new-page.html").exists())
        self.assertEqual(self.saved()["status"], "rolled-back")
        self.assertEqual(self.ops.calls, [])

    def test_frontend_publish_refuses_wrong_mount(self):
        output = self.website()
        self.ops.current["Mounts"][0]["Source"] = str(self.root / "wrong")
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual((output / "index.html").read_text(), "old homepage")

    def test_frontend_newer_external_build_blocks_publication(self):
        output = self.website()
        (output / "index.html").write_text("someone else's work")
        with self.assertRaises(mod.OpsError):
            self.ops.deploy(RUN)
        self.assertEqual((output / "index.html").read_text(), "someone else's work")

    def test_frontend_rollback_does_not_overwrite_newer_release(self):
        output = self.website()
        with patch.object(self.ops, "verify_served"):
            self.ops.deploy(RUN)
        (output / "index.html").write_text("newer release")
        with self.assertRaises(mod.OpsError):
            self.ops.rollback(RUN)
        self.assertEqual((output / "index.html").read_text(), "newer release")

    def test_frontend_verification_serves_exact_bundle_without_changing_live_files(self):
        output = self.website()
        (self.path / "bundle/index.html").write_text('<html><script src="new.js"></script></html>')
        (self.path / "bundle/index.csr.html").write_text('<html><script src="new.js"></script></html>')
        self.receipt["artifact_digest"] = mod.tree_hash(self.path / "bundle")
        self.ops.save(self.path, self.receipt)
        self.ops.verify(RUN, Path(__file__).resolve().parents[1] / "checks/web.py")
        self.assertEqual(self.saved()["status"], "verified")
        self.assertEqual((output / "index.html").read_text(), "old homepage")
        self.assertEqual(self.ops.calls, [])

    def test_frontend_verify_rejects_missing_asset_returning_fallback_html(self):
        self.website()
        (self.path / "bundle/index.html").write_text('<html><script src="missing.js"></script></html>')
        (self.path / "bundle/index.csr.html").write_text('<html>fallback</html>')
        self.receipt["artifact_digest"] = mod.tree_hash(self.path / "bundle")
        self.ops.save(self.path, self.receipt)
        with self.assertRaises(mod.OpsError):
            self.ops.verify(RUN, Path(__file__).resolve().parents[1] / "checks/web.py")
        self.assertEqual(self.saved()["status"], "verify-failed")


if __name__ == "__main__":
    unittest.main()
