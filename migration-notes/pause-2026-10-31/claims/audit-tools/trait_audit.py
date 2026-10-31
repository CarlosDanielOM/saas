"""Public trait without a concrete production adapter (house rule).

A trait declared in a lane must have a concrete adapter. The adapter may live in
another file of the same lane, so the search is crate-wide across the lane's files,
not per-file. The `#[cfg(test)]` module is stripped first, so a test double never
counts as a production adapter.
"""
import os, re, sys, json

def strip_nc(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)

def prod_source(path):
    raw = open(path, encoding="utf-8", errors="replace").read()
    idx = raw.find("#[cfg(test)]")
    return strip_nc(raw if idx < 0 else raw[:idx])

def audit(group_files):
    traits = {}   # trait name -> declaring file
    impls = {}    # trait name -> list of (file, type)
    all_src = []
    for f in group_files:
        src = prod_source(f)
        all_src.append((f, src))
        for m in re.finditer(r"\bpub(?:\([^)]*\))?\s+trait\s+([A-Za-z0-9_]+)", src):
            traits[m.group(1)] = f
        for m in re.finditer(r"\bimpl(?:<[^>]*>)?\s+([A-Za-z0-9_]+)(?:<[^>]*>)?\s+for\s+([A-Za-z0-9_:<>, ]+)", src):
            impls.setdefault(m.group(1), []).append((f, m.group(2).strip()))
    rows = []
    for t, decl in sorted(traits.items()):
        adapters = impls.get(t, [])
        rows.append((decl, t, adapters))
    return rows

if __name__ == "__main__":
    groups = json.loads(sys.argv[1])
    total_missing = 0
    for name, files in groups.items():
        if not files: continue
        rows = audit(files)
        print(f"=== {name} ({len(files)} files)")
        for decl, t, adapters in rows:
            status = "OK  " if adapters else "MISSING CONCRETE ADAPTER"
            if not adapters: total_missing += 1
            where = ", ".join(f"{os.path.basename(f)}:{ty}" for f, ty in adapters) or "NONE in production code"
            print(f"    [{status}] trait {t} (declared in {os.path.basename(decl)}) -> {where}")
        if not rows:
            print("    (no public traits)")
    print("TOTAL TRAITS WITHOUT A PRODUCTION ADAPTER:", total_missing)
