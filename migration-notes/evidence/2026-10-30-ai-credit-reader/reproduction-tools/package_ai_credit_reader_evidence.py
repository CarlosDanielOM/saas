#!/usr/bin/env python3
"""Package immutable AI-credit-reader receipts and source inputs; never runs builds/tests."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


DEFAULT_STATE = Path("/root/.local/state/rust-full-migration-20261028-lu443ytp")
DEFAULT_REPO = Path("/root/saas-rust")
DEFAULT_TOOLS = Path("/tmp/dimabot-full-migration-tools")
CODE_COMMIT = "c6ac8d0fa4a68e98bc2dd3c8466bce0d1f6540c1"
SOURCE_TREE = "d674dd63d827f4b9c6ca0e6ce8a754f1cd5b6f05b2a4c1ac87fcf57f977e4b18"
FIRST_RUN = 1793346593981991577
FINAL_RUN = 1793347225049018031
SDK_BINDING_PATH = Path(
    "migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json"
)
EXTERNAL_CAPTURE = Path(
    "migration-notes/evidence/2026-10-30-ai-credit-reader-source"
)
REPRO_TOOLS = (
    "credit_reader_node1.sh",
    "credit_reader_node2.sh",
    "credit_reader_node3.sh",
    "credit_reader_quality3.sh",
    "credit_reader_runtime2.sh",
    "credit_validate.sh",
    "freeze_credit_reader.py",
    "freeze_advanced_oracle.py",
    "apply_format.py",
    "final_readback.py",
    "validate.py",
)
DIRECT_READER_INPUTS = (
    "dimabot/src/utils/ai_credit_reader.rs",
    "dimabot/tests/ai_credit_reader.rs",
    "dimabot/tests/ai_credit_reader_protocol.rs",
    "dimabot/tests/fixtures/ai_credit_reader_reference.cjs",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text())


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def git_bytes(repo: Path, commit: str, path: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:{path}"])


def copy_checked(src: Path, dst: Path, expected: str | None = None) -> dict:
    data = src.read_bytes()
    digest = sha256(data)
    if expected is not None and digest != expected:
        raise SystemExit(f"SHA-256 mismatch: {src}: expected {expected}, got {digest}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return {"sha256": digest, "bytes": len(data)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--tool-dir", type=Path, default=DEFAULT_TOOLS)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("/tmp/ai-credit-reader-evidence-package"),
        help="evidence directory; must not exist or must be empty",
    )
    args = parser.parse_args()
    state, repo, tool_dir, out = map(Path, (args.state, args.repo, args.tool_dir, args.out))
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"Refusing to overwrite nonempty evidence directory: {out}")
    out.mkdir(parents=True, exist_ok=True)

    facts = read_json(state / "artifacts/ai-credit-reader/final/parent-final-facts.json")
    if facts["codeCommit"] != CODE_COMMIT or facts["sourceTreeSha256"] != SOURCE_TREE:
        raise SystemExit("Parent facts do not match the frozen AI-credit-reader source identity")
    final_receipt_names = (
        f"node-{FINAL_RUN}-receipt.json",
        "compiler-fixtures-1793347225048910930-receipt.json",
    )
    receipts = [read_json(state / "artifacts" / name) for name in final_receipt_names]
    source_hashes = receipts[0]["source_hashes"]
    if len(source_hashes) != 1449 or any(r["source_hashes"] != source_hashes for r in receipts):
        raise SystemExit("Final accepted receipts do not bind the same 1,449 inputs")
    if any(r["source_tree_sha256"] != SOURCE_TREE or not r["success"] for r in receipts):
        raise SystemExit("Final accepted receipt identity or status mismatch")

    prior = read_json(repo / SDK_BINDING_PATH)
    sdk_hashes = prior["cache-and-types"]["archiveVerifiedSdkInputs"]
    if len(sdk_hashes) != 10:
        raise SystemExit(f"Expected ten SDK bindings, found {len(sdk_hashes)}")
    git_hashes = {k: v for k, v in source_hashes.items() if k not in sdk_hashes}
    if len(git_hashes) != 1439 or set(source_hashes) != set(git_hashes) | set(sdk_hashes):
        raise SystemExit("Frozen source input partition is not 1,439 Git plus ten SDK inputs")

    # Verify all frozen inputs and capture the exact accepted snapshot.
    for relative, expected in git_hashes.items():
        if sha256(git_bytes(repo, CODE_COMMIT, relative)) != expected:
            raise SystemExit(f"Accepted Git object does not match frozen input: {relative}")
    for relative, expected in sdk_hashes.items():
        if source_hashes[relative] != expected:
            raise SystemExit(f"Reused SDK input hash is not bound by final receipts: {relative}")
    for relative in DIRECT_READER_INPUTS:
        expected = git_hashes.get(relative)
        if expected is None:
            raise SystemExit(f"Direct reader capture is absent from Git bindings: {relative}")
        data = git_bytes(repo, CODE_COMMIT, relative)
        if sha256(data) != expected:
            raise SystemExit(f"Accepted Git object changed during capture: {relative}")
        destination = out / "source-snapshot" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    tree_hash = sha256(json.dumps(source_hashes, sort_keys=True).encode())
    if tree_hash != SOURCE_TREE:
        raise SystemExit(f"Frozen source tree digest mismatch: {tree_hash}")

    bindings = {
        "sourceTreeSha256": SOURCE_TREE,
        "codeCommit": CODE_COMMIT,
        "gitInputs": git_hashes,
        "reusedSdkInputs": sdk_hashes,
        "sdkBindingSource": f"{SDK_BINDING_PATH}#cache-and-types.archiveVerifiedSdkInputs",
        "verifiedGitMethod": "git show <codeCommit>:<path>, SHA-256 compared with accepted receipt",
        "capturedReaderFiles": {p: git_hashes[p] for p in DIRECT_READER_INPUTS},
        "fullSourceTreePolicy": "all hashes retained; non-reader Git files are reconstructed from the commit; SDK payloads are referenced through the verified prior binding, not copied",
        "inputCount": len(source_hashes),
    }
    write_json(out / "source-bindings.json", bindings)

    # Preserve the source-oracle dependency capture and its exact provenance manifest.
    for path in sorted((repo / EXTERNAL_CAPTURE).rglob("*")):
        if path.is_file():
            relative = path.relative_to(repo / EXTERNAL_CAPTURE)
            copy_checked(path, out / "source-captures" / relative)
    billing_capture = repo / "migration-notes/evidence/2026-10-29-billing-recovery-source/external-source-api-ee0635765a02/dimabot/src/utils/billing.ts"
    copy_checked(
        billing_capture,
        out / "source-captures/billing-55bd0bb.ts",
        "2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f",
    )

    # Preserve all three Node corpus attempts and the cache-maintenance receipt.
    task_artifacts = state / "artifacts/ai-credit-reader"
    shutil.copytree(task_artifacts, out / "artifacts/ai-credit-reader", dirs_exist_ok=True)
    shutil.copy2(
        state / "artifacts/ai-credit-reader/final/parent-final-facts.json",
        out / "artifacts/parent-final-facts.json",
    )
    shutil.copy2(
        state / "artifacts/ai-credit-reader/final/production-readback.json",
        out / "artifacts/final-production-readback.json",
    )

    # All task phase receipts/logs in the inclusive run interval, including failures.
    runs_dir = out / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    run_pattern = re.compile(r"^[a-z-]+-(\d+)(?:-receipt\.json|\.log)$")
    run_records = []
    for path in sorted((state / "artifacts").glob("*")):
        match = run_pattern.match(path.name)
        if not match or not FIRST_RUN <= int(match.group(1)) <= FINAL_RUN:
            continue
        if path.name.endswith(".log"):
            stored_name = path.name + ".gz"
            stored = gzip.compress(path.read_bytes(), mtime=0)
            (runs_dir / stored_name).write_bytes(stored)
        else:
            stored_name = path.name
            shutil.copy2(path, runs_dir / stored_name)
        if path.name.endswith("-receipt.json"):
            receipt = read_json(path)
            run_records.append(
                {
                    "file": stored_name,
                    "phase": receipt.get("phase"),
                    "success": receipt.get("success"),
                    "sourceTreeSha256": receipt.get("source_tree_sha256"),
                    "readerProtocolSourceSha256": receipt.get("source_hashes", {}).get(
                        "dimabot/tests/ai_credit_reader_protocol.rs"
                    ),
                    "steps": receipt.get("steps", []),
                    "log": path.name.removesuffix("-receipt.json") + ".log.gz",
                }
            )
    if not run_records or not any(r["file"] == final_receipt_names[0] for r in run_records):
        raise SystemExit("No complete task run history found in the requested interval")

    tool_hashes = {}
    tool_dir_dest = out / "reproduction-tools"
    for name in REPRO_TOOLS:
        tool_hashes[name] = copy_checked(tool_dir / name, tool_dir_dest / name)
    tool_hashes["package_ai_credit_reader_evidence.py"] = copy_checked(
        Path(__file__), tool_dir_dest / "package_ai_credit_reader_evidence.py"
    )
    # The reproduction scripts' shared helpers are retained explicitly by the manifest.
    write_json(tool_dir_dest / "manifest.json", {"files": tool_hashes})

    verification_summary = {
        "codeCommit": CODE_COMMIT,
        "sourceTreeSha256": SOURCE_TREE,
        "frozenInputs": {"total": 1449, "git": 1439, "reusedSdk": 10},
        "physicalSourceFiles": {
            "readerGitFiles": list(DIRECT_READER_INPUTS),
            "readerGitFileCount": len(DIRECT_READER_INPUTS),
            "fullSnapshotCopied": False,
            "sdkFilesCopied": False,
        },
        "acceptedRuns": [
            {
                "id": "node-1793347225049018031",
                "phase": "Node source oracle, 13 source DTO/wire cases",
                "success": True,
            },
            {
                "id": "compiler-fixtures-1793347225048910930",
                "phase": "isolated Rust compiler and fixtures",
                "success": True,
                "elapsedSeconds": 145.477,
                "limits": {"cpus": 6, "memoryBytes": 4294967296, "swapBytes": 4294967296, "pids": 256, "cargoJobs": 2},
                "minimumAvailableBytes": 8793755648,
                "peakPrivateCacheBytes": 8296251392,
            },
        ],
        "rustCoverage": {"normalTests": 3, "ignoredPrivateSuites": 2, "strictProfiles": ["reader", "minimal", "mongo-redis", "all-features"]},
        "history": run_records,
        "readerProtocolSourceHistory": [
            {
                "sha256": digest,
                "sourceTrees": sorted(
                    {r["sourceTreeSha256"] for r in run_records if r["readerProtocolSourceSha256"] == digest}
                ),
                "receipts": [r["file"] for r in run_records if r["readerProtocolSourceSha256"] == digest],
            }
            for digest in sorted({r["readerProtocolSourceSha256"] for r in run_records if r["readerProtocolSourceSha256"]})
        ],
        "priorCorrections": facts["compatibilityCorrections"],
        "cacheMaintenance": read_json(task_artifacts / "attempt2/private-cache-maintenance.json"),
        "finalProductionReadback": "artifacts/final-production-readback.json",
        "productionUnchanged": facts["compilerMetrics"]["production_unchanged"],
        "knownBoundaries": facts["knownBoundaries"],
        "status": facts["status"],
        "performanceClaim": None,
    }
    write_json(out / "verification-summary.json", verification_summary)

    # Index every payload except the index itself, recording original and stored bytes.
    index = {}
    for path in sorted(out.rglob("*")):
        if not path.is_file() or path == out / "artifact-sha256.json":
            continue
        data = path.read_bytes()
        if path.suffix == ".gz":
            try:
                raw = gzip.decompress(data)
            except OSError:
                raw = data
            index[str(path.relative_to(out))] = {
                "rawSha256": sha256(raw),
                "rawBytes": len(raw),
                "storedSha256": sha256(data),
                "storedBytes": len(data),
                "encoding": "gzip" if raw != data else "identity",
            }
        else:
            index[str(path.relative_to(out))] = {
                "rawSha256": sha256(data),
                "rawBytes": len(data),
                "storedSha256": sha256(data),
                "storedBytes": len(data),
                "encoding": "identity",
            }
    write_json(out / "artifact-sha256.json", {"indexedPayloads": len(index), "files": index})

    readme = f"""# AI-credit reader verification evidence

This evidence package binds the verified bounded reader source to code commit `{CODE_COMMIT}` and frozen source tree `{SOURCE_TREE}`. [source-bindings.json](source-bindings.json) retains SHA-256 bindings for all 1,449 inputs: 1,439 Git objects verified with `git show {CODE_COMMIT}:<path>` and ten reused SDK inputs referenced from the previously verified `cache-and-types` archive binding. To avoid duplicating the full monorepo snapshot, `source-snapshot/` contains only the four directly relevant reader source/test files; reconstruct the other Git inputs from the pinned commit and the SDK inputs from their prior binding.

The final accepted Node oracle run (`node-1793347225049018031`) and capped Rust compiler/fixtures run (`compiler-fixtures-1793347225048910930`) used the same frozen source tree. The Node corpus contains 13 source DTO and wire cases; three normal reader tests and two ignored private-service suites passed. The compiler receipt records the 6 CPU, 4 GiB memory/no-swap, 256 PID, two Cargo job limits. All receipts and logs in run interval `{FIRST_RUN}`–`{FINAL_RUN}` are retained, including failed and superseded runs. Their full per-run source hashes preserve both protocol-suite source revisions. Logs are gzip-compressed with deterministic metadata. The cache-maintenance receipt records removal of only eight obsolete task-owned debug test binaries (267,366,400 allocated bytes), with no source, dependency, quota, or shared-cache change. See [verification-summary.json](verification-summary.json) for statuses, limits, source corrections, and boundaries.

All three Node oracle outputs are retained under `artifacts/ai-credit-reader/`; the third corpus is byte-identical to the second. `source-captures/` contains the exact committed plan-cache helper and capture manifest plus the accepted billing source capture. `reproduction-tools/` retains the source-freeze, source oracle, checks, formatting helper, and final readback scripts with a helper hash manifest. These are historical reproduction tools; this packaging script itself reads Git objects and saved artifacts only and runs no application, test, Cargo, Node, container, or network command.

The parent review corrected fresh-version comparison to JavaScript UTF-16 ordering before the existing Redis Lua UTF-8 comparison; case 13 covers the astral/BMP ordering difference. The source semantic worker uses a 750 ms provider signal; the native provider duration is configurable and separate from an optional overall deadline. The reader reuses the existing credit projection/fence, pooled Mongo and Redis clients, and pooled Polar HTTP client. It does not implement cache-mode usage ingestion or lossless event-context ingestion, and no application image source binding is proven. Existing TypeScript callers remain unadopted. This is bounded local reader coverage only: billing remains partial, no benchmark or runtime-gain claim is made, and there is no caller adoption, TypeScript retirement, deployment, push, or full billing completion.

The index lists exactly {len(index) + 1} payloads and excludes itself; each entry reports raw and stored hashes/byte counts. For `.gz` payloads, check `storedSha256` before decompression and `rawSha256` after decompression. Verify all indexed artifacts before staging; source files under `source-snapshot/` may need `git add -f` if repository ignore rules apply. Rebuild the package into an empty output directory, for example with `--out /tmp/ai-credit-reader-evidence-package`; the default output path is the same temporary directory.
"""
    (out / "README.md").write_text(readme)
    # Re-index now that the README is present. The final count excludes only this index.
    index = {}
    for path in sorted(out.rglob("*")):
        if not path.is_file() or path == out / "artifact-sha256.json":
            continue
        data = path.read_bytes()
        is_gzip = path.suffix == ".gz"
        raw = gzip.decompress(data) if is_gzip else data
        index[str(path.relative_to(out))] = {
            "rawSha256": sha256(raw),
            "rawBytes": len(raw),
            "storedSha256": sha256(data),
            "storedBytes": len(data),
            "encoding": "gzip" if is_gzip else "identity",
        }
    write_json(out / "artifact-sha256.json", {"indexedPayloads": len(index), "files": index})
    print(json.dumps({"out": str(out), "indexedPayloads": len(index), "sourceInputs": len(source_hashes), "runReceipts": len(run_records)}, indent=2))


if __name__ == "__main__":
    main()
