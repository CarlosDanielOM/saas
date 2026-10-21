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
        project = self.root / "dima-rust"
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
        self.ops.snapshot(mod.Target("dima-rust", "", ""), self.path / "rust-source", rust_only=True)
        self.assertEqual([str(f.relative_to(self.path / "rust-source")) for f in mod.files_under(self.path / "rust-source")],
                         ["Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "src/lib.rs"])
        (project / "src/unsafe.rs").symlink_to(project / ".env.prod")
        with self.assertRaises(mod.OpsError):
            self.ops.snapshot(mod.Target("dima-rust", "", ""), self.path / "unsafe", rust_only=True)

    def test_rust_compiler_has_hard_caps_private_source_and_no_production_mounts(self):
        cache = {"cargo": str(self.root.parent / "cache/cargo"), "target": str(self.root.parent / "cache/target")}
        args = self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        for option in ("--cpus=4", "--memory=4g", "--memory-swap=4g", "--pids-limit=256", "--env=CARGO_BUILD_JOBS=2"):
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
        self.assertIn("--env=SAAS_RUST_FEATURE_MATRIX=0", args)
        matrix_args = self.ops.rust_container_args(self.path, {**self.receipt, "rust_feature_matrix": True}, NEW, cache)
        self.assertIn("--env=SAAS_RUST_FEATURE_MATRIX=1", matrix_args)
        with patch.object(mod, "RUST_FEATURES", "mongo,postgres"), self.assertRaises(mod.OpsError):
            self.ops.rust_container_args(self.path, self.receipt, NEW, cache)
        self.assertTrue(any("dst=/source,readonly" in mount for mount in mounts))
        self.assertNotIn("--privileged", args)
        self.assertNotIn("--env-file", args)
        self.assertNotIn("--network=host", args)
        self.assertFalse(any("docker.sock" in arg or ".env" in arg for arg in args))

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
            engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=True)
        with patch.object(mod, "Ops") as engine:
            mod.main(["build", "cron"])
            engine.return_value.build.assert_called_once_with("cron", None, rust_feature_matrix=False)

    def test_cron_plan_exposes_worker_features_cache_caps_and_optional_matrix_without_writes(self):
        output = io.StringIO()
        with patch.object(mod, "Ops") as engine, contextlib.redirect_stdout(output):
            engine.return_value.baseline.return_value = ({"Image": NEW}, {}, "hash", "digest")
            engine.return_value.rust_cache_root.return_value = self.root.parent / "private-cache"
            mod.main(["plan", "cron"])
            engine.return_value.lock.assert_not_called()
        details = json.loads(output.getvalue())["rust"]
        self.assertEqual(details["features"], "mongo")
        self.assertEqual(details["cache_limit_bytes"], 8 * mod.GIB)
        self.assertEqual(details["optional_feature_matrix"], "build cron --rust-feature-matrix")

    def test_rust_build_refuses_orphaned_compiler_before_copying_source(self):
        with patch.object(self.ops, "docker", return_value="orphan-id\n"), \
             patch.object(Path, "home", return_value=self.root), self.assertRaises(mod.OpsError):
            self.ops.build_rust(self.path, self.receipt)
        self.assertFalse((self.path / "rust-source").exists())

    def test_rust_headroom_refuses_unsafe_start_and_running_pressure(self):
        with patch.object(Path, "read_text", return_value="MemAvailable: 11534336 kB\n"), \
             patch.object(mod.os, "getloadavg", return_value=(0, 0, 0)), \
             patch.object(mod.shutil, "disk_usage", return_value=type("Disk", (), {"free": 10 * mod.GIB})()):
            with self.assertRaises(mod.OpsError):
                self.ops.rust_headroom(starting=True)
            self.ops.rust_headroom()
        with patch.object(Path, "read_text", return_value="MemAvailable: 7340032 kB\n"), self.assertRaises(mod.OpsError):
            self.ops.rust_headroom()
        with patch.object(Path, "read_text", return_value="MemAvailable: 16777216 kB\n"), \
             patch.object(mod.os, "getloadavg", return_value=(1000, 0, 0)), self.assertRaises(mod.OpsError):
            self.ops.rust_headroom()

    def simulated_rust_build(self, *, exit_code=0, wrong_limits=False, raid_artifact="valid", cache_bytes=0):
        self.rust_source()
        (self.path / "source").mkdir()
        self.ops.objects[("image", mod.RUST_BUILD_IMAGE)] = {"Id": NEW}
        name = "saas-ops-" + RUN + "-rust-build"
        original_docker = self.ops.docker
        def docker(*args, **kwargs):
            if args[0] == "create":
                self.ops.objects[("container", name)] = {
                    "Id": "compiler-id", "Config": {"Labels": self.labels()},
                    "HostConfig": {"NanoCpus": 1 if wrong_limits else 4_000_000_000,
                                   "Memory": 4 * mod.GIB, "MemorySwap": 4 * mod.GIB, "PidsLimit": 256},
                    "State": {"Running": False, "ExitCode": exit_code}}
            elif args[0] == "start":
                (self.path / "rust-artifacts/worker-dependencies.txt").write_text("dima-rust v0.1.0\nmongodb v3.9.1\n")
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
                (self.path / "rust-artifacts/toolchain.txt").write_text("host: x86_64-unknown-linux-musl")
            return original_docker(*args, **kwargs)
        return patch.object(self.ops, "docker", side_effect=docker)

    def test_rust_build_records_immutable_toolchain_source_artifact_and_cleans_compiler(self):
        simulation = self.simulated_rust_build()
        with simulation, patch.object(self.ops, "rust_headroom", return_value={}), \
             patch.object(Path, "home", return_value=self.root.parent):
            self.ops.build_rust(self.path, self.receipt)
        self.assertEqual(self.receipt["rust_toolchain_image"], NEW)
        self.assertEqual(self.receipt["rust_source_digest"], mod.tree_hash(self.path / "rust-source"))
        self.assertEqual(self.receipt["rust_binary_digest"], mod.digest(b"\x7fELFfixture"))
        self.assertEqual(self.receipt["rust_worker_dependencies_digest"], mod.digest(b"dima-rust v0.1.0\nmongodb v3.9.1\n"))
        self.assertEqual(self.receipt["rust_binary_digests"], {
            "stream_activity": mod.digest(b"\x7fELFfixture"), "raid_analytics": mod.digest(b"\x7fELFraidfixture")})
        staged = self.path / "source/.saas-native/stream_activity"
        self.assertEqual(staged.read_bytes(), b"\x7fELFfixture")
        self.assertEqual(staged.stat().st_mode & 0o777, 0o755)
        raid_staged = self.path / "source/.saas-native/raid_analytics"
        self.assertEqual(raid_staged.read_bytes(), b"\x7fELFraidfixture")
        self.assertEqual(raid_staged.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.receipt["resources"], [])
        self.assertFalse((self.path / "rust-work").exists())
        self.assertNotIn(("container", "saas-ops-" + RUN + "-rust-build"), self.ops.objects)
        self.assertTrue(Path(self.receipt["rust_cache"]["cargo"]).is_dir())
        self.assertTrue(Path(self.receipt["rust_cache"]["target"]).is_dir())
        self.assertEqual(self.receipt["rust_features"], "mongo")
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
        for failure in ("checks", "limits", "missing", "invalid", "symlink"):
            with self.subTest(failure=failure):
                # Each simulation uses the same task-owned directories, cleared here.
                for directory in ("dima-rust",):
                    if (self.root / directory).exists():
                        mod.shutil.rmtree(self.root / directory)
                for directory in ("source", "rust-source", "rust-artifacts"):
                    if (self.path / directory).exists():
                        mod.shutil.rmtree(self.path / directory)
                simulation = self.simulated_rust_build(exit_code=1 if failure == "checks" else 0,
                                                       wrong_limits=failure == "limits",
                                                       raid_artifact=failure if failure in ("missing", "invalid", "symlink") else "valid")
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
