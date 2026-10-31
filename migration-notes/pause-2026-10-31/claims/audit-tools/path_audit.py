import os, re, sys, json

ROOT = "/root/saas-rust/dimabot/src"

def strip_nc(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)

def parse_mods(path):
    out = {}
    try:
        src = strip_nc(open(path, encoding="utf-8", errors="replace").read())
    except OSError:
        return out
    pending = None
    for line in src.splitlines():
        line = line.strip()
        mp = re.match(r'#\[path\s*=\s*"([^"]+)"\]', line)
        if mp:
            pending = mp.group(1); continue
        mm = re.match(r"(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)\s*;", line)
        if mm:
            name = mm.group(1)
            if pending:
                base = os.path.dirname(path)
                cand = os.path.normpath(os.path.join(base, pending))
                out[name] = cand if cand.endswith(".rs") else os.path.join(cand, "mod.rs")
                pending = None
            else:
                d = os.path.dirname(path)
                n1 = os.path.join(d, name + ".rs")
                out[name] = n1 if os.path.isfile(n1) else os.path.join(d, name, "mod.rs")
    return out

ALIAS = {}
for name, p in parse_mods(os.path.join(ROOT, "lib.rs")).items():
    ALIAS["crate::" + name] = p

def mod_children(path):
    return parse_mods(path)

def resolve_module_prefix(ref):
    """ref: 'crate::a::b::c'. Return (module_file, item) where module_file is the file
    declaring the module path of 'crate::a::b' and item is 'c' (may be None)."""
    parts = [p for p in ref.split("::") if p]
    if not parts or parts[0] != "crate":
        return None
    # find longest alias prefix
    for i in range(len(parts), 0, -1):
        prefix = "::".join(parts[:i])
        if prefix in ALIAS:
            cur = ALIAS[prefix]
            rest_all = parts[i:]
            if not rest_all:
                return (cur, None)
            for seg in rest_all[:-1]:
                children = mod_children(cur)
                if seg in children:
                    cur = children[seg]
                    continue
                d = os.path.dirname(cur) if cur.endswith(".rs") else cur
                n1 = os.path.join(d, seg + ".rs")
                if os.path.isfile(n1):
                    cur = n1; continue
                n2 = os.path.join(d, seg, "mod.rs")
                if os.path.isfile(n2):
                    cur = n2; continue
                return None
            return (cur, rest_all[-1])
    return None

ITEM_RE = re.compile(r"\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?"
                     r"(?:struct|enum|trait|type|fn|const|static|macro_rules!|mod|union)\s+"
                     r"([A-Za-z0-9_]+)")

def item_exists(mod_file, item):
    try:
        src = strip_nc(open(mod_file, encoding="utf-8", errors="replace").read())
    except OSError:
        return False
    if re.search(r"\b(?:pub\s+)?use\s+[^;]*\b%s\b" % re.escape(item), src):
        return True
    return bool(re.search(r"\b%s\b" % re.escape(item), ITEM_RE.pattern and src)) and bool(
        re.search(r"(?:struct|enum|trait|type|fn|const|static|mod|union)\s+%s\b" % re.escape(item), src))

def audit(files):
    problems = []
    for f in files:
        src = strip_nc(open(f, encoding="utf-8", errors="replace").read())
        refs = set()
        for m in re.finditer(r"\buse\s+(crate::[A-Za-z0-9_:]+)", src):
            refs.add(m.group(1))
        for m in re.finditer(r"\b(crate::[A-Za-z0-9_]+::[A-Za-z0-9_]+)", src):
            refs.add(m.group(1))
        for r in sorted(refs):
            r = r.rstrip(":")
            res = resolve_module_prefix(r)
            if res is None:
                problems.append((os.path.relpath(f, ROOT), r, "MODULE PATH NOT FOUND"))
            else:
                mod_file, item = res
                if not os.path.isfile(mod_file):
                    problems.append((os.path.relpath(f, ROOT), r, f"missing file {mod_file}"))
                elif item is not None and not item_exists(mod_file, item):
                    problems.append((os.path.relpath(f, ROOT), r, f"item '{item}' not found in {os.path.relpath(mod_file, ROOT)}"))
    return problems

if __name__ == "__main__":
    groups = json.loads(sys.argv[1])
    total = 0
    for name, files in groups.items():
        if not files: continue
        probs = audit(files)
        print(f"=== {name}: {len(files)} files -> {len(probs)} problems")
        for f, r, why in probs:
            print(f"    {f}: {r}\n        -> {why}")
        total += len(probs)
    print("TOTAL:", total)
