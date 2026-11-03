"""Geometry kernel for the duel rebuild.

Everything is authored in the original three.js space (Y up, fighters face +Z) and
converted to Blender space (Z up, front = -Y) only when meshes are created. The helpers
mirror the three.js primitives the web version used, so the ported build code stays a
near line-for-line translation, but with higher resolution and proper caps.
"""
import math
from mathutils import Matrix, Vector

PI = math.pi
TAU = 2 * PI
C = Matrix.Rotation(PI / 2, 4, 'X')  # three (x, y, z) -> blender (x, -z, y)


def hexcol(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def euler(r, order='XYZ'):
    """three.js Euler -> matrix. three's 'XYZ' means R = Rx @ Ry @ Rz."""
    m = {'X': Matrix.Rotation(r[0], 4, 'X'), 'Y': Matrix.Rotation(r[1], 4, 'Y'), 'Z': Matrix.Rotation(r[2], 4, 'Z')}
    return m[order[0]] @ m[order[1]] @ m[order[2]]


def trs(p=(0, 0, 0), r=(0, 0, 0), s=(1, 1, 1), order='XYZ'):
    return Matrix.Translation(Vector(p)) @ euler(r, order) @ Matrix.Diagonal((*s, 1))


class Geo:
    """Plain polygon soup with per-corner UVs. `flat` marks faceted pieces (gems)."""

    def __init__(self, flat=False):
        self.v, self.f, self.uv, self.flat = [], [], [], flat

    def vert(self, x, y, z):
        self.v.append(Vector((x, y, z)))
        return len(self.v) - 1

    def face(self, idx, uvs=None):
        self.f.append(tuple(idx))
        self.uv.append(tuple(uvs) if uvs else tuple((0.0, 0.0) for _ in idx))

    def transform(self, m):
        self.v = [m @ v for v in self.v]
        return self

    def extend(self, other):
        base = len(self.v)
        self.v += other.v
        self.f += [tuple(i + base for i in f) for f in other.f]
        self.uv += other.uv
        return self

    def weld(self, eps=1e-6):
        key, remap, nv = {}, [], []
        for v in self.v:
            k = (round(v.x / eps), round(v.y / eps), round(v.z / eps))
            if k not in key:
                key[k] = len(nv)
                nv.append(v)
            remap.append(key[k])
        nf, nuv = [], []
        for f, uv in zip(self.f, self.uv):
            idx, cuv = [], []
            for i, u in zip(f, uv):
                j = remap[i]
                if idx and idx[-1] == j:
                    continue
                idx.append(j)
                cuv.append(u)
            if len(idx) > 1 and idx[0] == idx[-1]:
                idx.pop()
                cuv.pop()
            if len(set(idx)) >= 3 and len(set(idx)) == len(idx):
                nf.append(tuple(idx))
                nuv.append(tuple(cuv))
        self.v, self.f, self.uv = nv, nf, nuv
        return self

    def planar_uv(self, scale=1.0):
        """Fallback UVs: project each face along its dominant normal axis."""
        out = []
        for f in self.f:
            n = face_normal([self.v[i] for i in f])
            ax = max(range(3), key=lambda a: abs(n[a]))
            a, b = [(1, 2), (0, 2), (0, 1)][ax]
            out.append(tuple((self.v[i][a] * scale, self.v[i][b] * scale) for i in f))
        self.uv = out
        return self


def face_normal(pts):
    n = Vector((0, 0, 0))
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))


def grid(g, rows, cols, base, uvs, wrap=False):
    """Quad faces over a (rows+1) x (cols+1) vertex grid starting at index `base`."""
    stride = cols + 1
    for r in range(rows):
        for c in range(cols):
            a = base + r * stride + c
            g.face((a, a + 1, a + stride + 1, a + stride),
                   (uvs(r, c), uvs(r, c + 1), uvs(r + 1, c + 1), uvs(r + 1, c)))


# ---------------------------------------------------------------- primitives

def lathe(points, segs=28):
    g, n = Geo(), len(points)
    for i in range(segs + 1):
        phi = i / segs * TAU
        for r, y in points:
            g.vert(r * math.sin(phi), y, r * math.cos(phi))
    grid(g, segs, n - 1, 0, lambda i, j: (i / segs, j / max(1, n - 1)))
    return g.weld()


def sphere(r, w=24, h=16, phi_len=TAU, theta_len=PI):
    g = Geo()
    for iy in range(h + 1):
        v = iy / h
        for ix in range(w + 1):
            u = ix / w
            g.vert(-r * math.cos(u * phi_len) * math.sin(v * theta_len), r * math.cos(v * theta_len),
                   r * math.sin(u * phi_len) * math.sin(v * theta_len))
    grid(g, h, w, 0, lambda a, b: (b / w, 1 - a / h))
    return g.weld()


def torus(R, tube, radial=10, tubular=32, arc=TAU):
    g = Geo()
    for j in range(radial + 1):
        v = j / radial * TAU
        for i in range(tubular + 1):
            u = i / tubular * arc
            g.vert((R + tube * math.cos(v)) * math.cos(u), (R + tube * math.cos(v)) * math.sin(u), tube * math.sin(v))
    grid(g, radial, tubular, 0, lambda a, b: (b / tubular, a / radial))
    return g.weld()


def cylinder(rt, rb, h, radial=16, open_ended=False, rings=1):
    g = Geo()
    for k in range(rings + 1):
        t = k / rings
        r = rt + (rb - rt) * t
        y = h / 2 - h * t
        for i in range(radial + 1):
            a = i / radial * TAU
            g.vert(r * math.sin(a), y, r * math.cos(a))
    grid(g, rings, radial, 0, lambda a, b: (b / radial, 1 - a / rings))
    if not open_ended:
        for y, r, top in ((h / 2, rt, True), (-h / 2, rb, False)):
            if r <= 1e-6:
                continue
            c = g.vert(0, y, 0)
            ring = [g.vert(r * math.sin(i / radial * TAU), y, r * math.cos(i / radial * TAU)) for i in range(radial)]
            for i in range(radial):
                a, b = ring[i], ring[(i + 1) % radial]
                ua = (.5 + .5 * math.sin(i / radial * TAU), .5 + .5 * math.cos(i / radial * TAU))
                ub = (.5 + .5 * math.sin((i + 1) / radial * TAU), .5 + .5 * math.cos((i + 1) / radial * TAU))
                g.face((c, a, b) if top else (c, b, a), ((.5, .5), ua, ub) if top else ((.5, .5), ub, ua))
    return g.weld()


def cone(r, h, radial=16):
    return cylinder(0, r, h, radial)


def capsule(r, length, cap=4, radial=12):
    pts = [(r * math.cos(a), -length / 2 + r * math.sin(a)) for a in [-PI / 2 + k / cap * PI / 2 for k in range(cap + 1)]]
    pts += [(r * math.cos(a), length / 2 + r * math.sin(a)) for a in [k / cap * PI / 2 for k in range(cap + 1)]]
    return lathe(pts, radial)


def rbox(w, h, d, r=.02, seg=3):
    """Rounded box (three's RoundedBoxGeometry): a subdivided cube projected onto the rounded hull."""
    r = max(1e-4, min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4))
    half = (w / 2 - r, h / 2 - r, d / 2 - r)

    def axis(c):
        pos = [c + r * math.sin(k / seg * PI / 2) for k in range(seg + 1)]
        return [-x for x in reversed(pos)] + pos
    A = [axis(c) for c in half]
    g = Geo()
    for ax in range(3):
        u_ax, v_ax = [(1, 2), (2, 0), (0, 1)][ax]
        for sgn in (-1, 1):
            us, vs, base = A[u_ax], A[v_ax], len(g.v)
            for vv in vs:
                for uu in us:
                    p = [0.0, 0.0, 0.0]
                    p[ax], p[u_ax], p[v_ax] = sgn * (half[ax] + r), uu, vv
                    q = Vector([max(-half[k], min(half[k], p[k])) for k in range(3)])
                    dv = Vector(p) - q
                    pt = q + (dv.normalized() * r if dv.length > 1e-12 else dv)
                    g.vert(*pt)
            n = len(us)
            for j in range(len(vs) - 1):
                for i in range(n - 1):
                    a = base + j * n + i
                    f = (a, a + 1, a + n + 1, a + n)
                    g.face(f if sgn > 0 else tuple(reversed(f)))
    g.weld(1e-7)
    return g.planar_uv(1 / max(w, h, d))


def box(w, h, d):
    g = Geo(flat=True)
    for x in (-w / 2, w / 2):
        for y in (-h / 2, h / 2):
            for z in (-d / 2, d / 2):
                g.vert(x, y, z)
    for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        g.face(f)
    return g.planar_uv(1 / max(w, h, d))


def octa(r, flat=True):
    g = Geo(flat=flat)
    pts = [(r, 0, 0), (-r, 0, 0), (0, r, 0), (0, -r, 0), (0, 0, r), (0, 0, -r)]
    for p in pts:
        g.vert(*p)
    for f in [(0, 2, 4), (0, 4, 3), (0, 3, 5), (0, 5, 2), (1, 2, 5), (1, 5, 3), (1, 3, 4), (1, 4, 2)]:
        g.face(f)
    return g.planar_uv(1 / r)


def ico(r, detail=1):
    t = (1 + 5 ** .5) / 2
    pts = [Vector(p).normalized() for p in [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]]
    tris = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    for _ in range(detail):
        cache, nt = {}, []

        def mid(a, b):
            k = (min(a, b), max(a, b))
            if k not in cache:
                pts.append((pts[a] + pts[b]).normalized())
                cache[k] = len(pts) - 1
            return cache[k]
        for a, b, c in tris:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nt += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        tris = nt
    g = Geo()
    for p in pts:
        g.vert(*(p * r))
    for f in tris:
        g.face(f)
    return g.planar_uv(1 / r)


def circle(r, segs=32):
    g = Geo()
    c = g.vert(0, 0, 0)
    ring = [g.vert(r * math.cos(i / segs * TAU), r * math.sin(i / segs * TAU), 0) for i in range(segs)]
    for i in range(segs):
        a, b = ring[i], ring[(i + 1) % segs]
        g.face((c, a, b), ((.5, .5), (.5 + .5 * math.cos(i / segs * TAU), .5 + .5 * math.sin(i / segs * TAU)),
                           (.5 + .5 * math.cos((i + 1) / segs * TAU), .5 + .5 * math.sin((i + 1) / segs * TAU))))
    return g


def annulus(r0, r1, segs=64, arc=TAU, a0=0.0):
    """Flat ring in the XY plane (normal +Z)."""
    g = Geo()
    for i in range(segs + 1):
        a = a0 + i / segs * arc
        g.vert(r0 * math.cos(a), r0 * math.sin(a), 0)
        g.vert(r1 * math.cos(a), r1 * math.sin(a), 0)
    for i in range(segs):
        a = i * 2
        g.face((a, a + 2, a + 3, a + 1), ((i / segs, 0), ((i + 1) / segs, 0), ((i + 1) / segs, 1), (i / segs, 1)))
    return g.weld()


def plane(w, h, cols=1, rows=1):
    g = Geo()
    for r in range(rows + 1):
        for c in range(cols + 1):
            g.vert(-w / 2 + w * c / cols, h / 2 - h * r / rows, 0)
    grid(g, rows, cols, 0, lambda r, c: (c / cols, 1 - r / rows))
    return g


# ---------------------------------------------------------------- curves & tubes

def catmull(points, per=24):
    """Centripetal Catmull-Rom (three.js CatmullRomCurve3 default) sampled densely."""
    P = [Vector(p) for p in points]
    n = len(P)
    out = []
    for i in range(n - 1):
        p0 = P[i - 1] if i > 0 else P[0] * 2 - P[1]
        p1, p2 = P[i], P[i + 1]
        p3 = P[i + 2] if i + 2 < n else P[-1] * 2 - P[-2]

        def dt(a, b):
            return max((b - a).length ** .5, 1e-4)
        d0, d1, d2 = dt(p0, p1), dt(p1, p2), dt(p2, p3)
        t1 = ((p1 - p0) / d0 - (p2 - p0) / (d0 + d1) + (p2 - p1) / d1) * d1
        t2 = ((p2 - p1) / d1 - (p3 - p1) / (d1 + d2) + (p3 - p2) / d2) * d1
        for k in range(per + (1 if i == n - 2 else 0)):
            t = k / per
            t2_, t3_ = t * t, t * t * t
            out.append((2 * t3_ - 3 * t2_ + 1) * p1 + (t3_ - 2 * t2_ + t) * t1 + (-2 * t3_ + 3 * t2_) * p2 + (t3_ - t2_) * t2)
    return out


def resample(pts, count):
    """Arc-length resampling to count+1 points (like curve.getPointAt)."""
    L = [0.0]
    for a, b in zip(pts, pts[1:]):
        L.append(L[-1] + (b - a).length)
    total = L[-1] or 1
    out, j = [], 0
    for i in range(count + 1):
        s = total * i / count
        while j < len(L) - 2 and L[j + 1] < s:
            j += 1
        seg = (L[j + 1] - L[j]) or 1
        out.append(pts[j].lerp(pts[j + 1], min(1, max(0, (s - L[j]) / seg))))
    return out


def frames(pts):
    """Rotation-minimising frames (parallel transport)."""
    T = []
    for i in range(len(pts)):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        T.append((b - a).normalized())
    t0 = T[0]
    axis = min((Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))), key=lambda a: abs(a.dot(t0)))
    N = [t0.cross(axis).cross(t0).normalized()]
    for i in range(1, len(pts)):
        q = T[i - 1].rotation_difference(T[i])
        N.append((q @ N[-1]).normalized())
    B = [t.cross(n) for t, n in zip(T, N)]
    return T, N, B


def taper_tube(points, radius, tubular=24, radial=10, caps=True, flat_x=1.0):
    pts = resample(catmull(points), tubular)
    T, N, B = frames(pts)
    g = Geo()
    for i, p in enumerate(pts):
        u = i / tubular
        r = radius(u)
        for j in range(radial + 1):
            v = j / radial * TAU
            s, c = math.sin(v), -math.cos(v)
            nrm = (N[i] * c + B[i] * s)
            g.vert(*(p + nrm * r))
    grid(g, tubular, radial, 0, lambda a, b: (a / tubular, b / radial))
    if caps:
        for i, rev in ((0, True), (tubular, False)):
            if radius(i / tubular) < .002:
                continue
            c = g.vert(*pts[i])
            ring = [i * (radial + 1) + j for j in range(radial)]
            for j in range(radial):
                a, b = ring[j], ring[(j + 1) % radial]
                g.face((c, b, a) if rev else (c, a, b))
    return g.weld()


# ---------------------------------------------------------------- 2D shapes & extrusion

class Shape:
    def __init__(self):
        self.pts = []

    def move(self, x, y):
        self.pts.append((x, y))
        return self

    def line(self, x, y):
        self.pts.append((x, y))
        return self

    def quad(self, cx, cy, x, y, n=12):
        x0, y0 = self.pts[-1]
        for k in range(1, n + 1):
            t = k / n
            a, b, c = (1 - t) ** 2, 2 * (1 - t) * t, t * t
            self.pts.append((a * x0 + b * cx + c * x, a * y0 + b * cy + c * y))
        return self

    def arc(self, x, y, r, a0, a1, cw=False, n=16):
        if cw and a1 > a0:
            a1 -= TAU
        for k in range(n + 1):
            a = a0 + (a1 - a0) * k / n
            self.pts.append((x + r * math.cos(a), y + r * math.sin(a)))
        return self

    def closed(self):
        p = self.pts[:]
        if len(p) > 1 and abs(p[0][0] - p[-1][0]) < 1e-7 and abs(p[0][1] - p[-1][1]) < 1e-7:
            p.pop()
        out = []
        for q in p:  # drop consecutive duplicates
            if not out or abs(out[-1][0] - q[0]) > 1e-7 or abs(out[-1][1] - q[1]) > 1e-7:
                out.append(q)
        return out


def _area(p):
    return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2


def _offset_dirs(p):
    n, out = len(p), []
    for i in range(n):
        a, b, c = p[i - 1], p[i], p[(i + 1) % n]
        e1 = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        e2 = Vector((c[0] - b[0], c[1] - b[1])).normalized()
        n1, n2 = Vector((e1.y, -e1.x)), Vector((e2.y, -e2.x))
        m = (n1 + n2)
        m = m.normalized() if m.length > 1e-6 else n1
        out.append(m / max(.35, m.dot(n1)))
    return out


def extrude(shape_pts, depth, bevel_t=0.0, bevel_s=0.0, segs=2, holes=()):
    """three.js-style ExtrudeGeometry: caps keep the shape, walls grow by bevel_s.
    Extrudes along +Z from 0..depth (like three), call .transform to recenter."""
    contours = []
    outer = shape_pts[:]
    if _area(outer) < 0:
        outer.reverse()
    contours.append(outer)
    for h in holes:
        h = h[:]
        if _area(h) > 0:
            h.reverse()
        contours.append(h)
    if bevel_t > 0 and segs > 0:
        front = [(-bevel_t * math.cos(b / segs * PI / 2), bevel_s * math.sin(b / segs * PI / 2)) for b in range(segs + 1)]
        layers = front + [(depth - z, s) for z, s in reversed(front)]
    else:
        layers = [(0, 0), (depth, 0)]
    g = Geo()
    loops = []
    for cont in contours:
        dirs = _offset_dirs(cont)
        n = len(cont)
        base = len(g.v)
        for z, s in layers:
            for (x, y), d in zip(cont, dirs):
                g.vert(x + d.x * s, y + d.y * s, z)
        L = len(layers)
        for li in range(L - 1):
            for i in range(n):
                a = base + li * n + i
                b = base + li * n + (i + 1) % n
                c = base + (li + 1) * n + (i + 1) % n
                d = base + (li + 1) * n + i
                g.face((a, b, c, d), ((i / n, li / L), ((i + 1) / n, li / L), ((i + 1) / n, (li + 1) / L), (i / n, (li + 1) / L)))
        loops.append((base, base + (L - 1) * n, n))
    b0, b1, n = loops[0]
    g.face(tuple(reversed(range(b0, b0 + n))))
    g.face(tuple(range(b1, b1 + n)))
    return g.weld(1e-7).planar_uv(1)


def bridge_cap(g, outer, inner, z_index_outer, z_index_inner, n_out, n_in, flip=False):
    """Triangulate a ring cap between two loops by marching along both (for shield rims)."""
    i = j = 0
    while i < n_out or j < n_in:
        a = z_index_outer + i % n_out
        b = z_index_inner + j % n_in
        if j >= n_in or (i < n_out and (i + 1) / n_out <= (j + 1) / n_in):
            c = z_index_outer + (i + 1) % n_out
            g.face((a, c, b) if not flip else (a, b, c))
            i += 1
        else:
            c = z_index_inner + (j + 1) % n_in
            g.face((a, c, b) if flip else (a, b, c))
            j += 1


def solidify(g, t):
    """Give a sheet thickness `t` (offset opposite to its normals) with stitched borders."""
    n = len(g.v)
    vn = [Vector((0, 0, 0)) for _ in range(n)]
    for f in g.f:
        fn = face_normal([g.v[i] for i in f])
        for i in f:
            vn[i] += fn
    vn = [v.normalized() if v.length > 1e-9 else Vector((0, 0, 1)) for v in vn]
    for i in range(n):
        g.v.append(g.v[i] - vn[i] * t)
    edges = {}
    for f in g.f:
        for k in range(len(f)):
            e = (f[k], f[(k + 1) % len(f)])
            edges[e] = edges.get(e, 0) + 1
    old_f, old_uv = list(g.f), list(g.uv)
    for f, uv in zip(old_f, old_uv):
        g.face(tuple(i + n for i in reversed(f)), tuple(reversed(uv)))
    for (a, b), cnt in edges.items():
        if (b, a) not in edges:
            g.face((b, a, a + n, b + n))
    return g


def _roll_resample(p, n):
    if _area(p) < 0:
        p = p[::-1]
    top = max(range(len(p)), key=lambda i: p[i][1] - abs(p[i][0]) * .5)
    p = p[top:] + p[:top]
    pts = [Vector((x, y, 0)) for x, y in p] + [Vector((p[0][0], p[0][1], 0))]
    out = resample(pts, n)[:-1]
    return [(v.x, v.y) for v in out]


def ring_extrude(outer, inner, depth, bevel_t, bevel_s, segs=2, n=96):
    """Extrude the region between two closed loops (a frame / rim), three-style bevels."""
    o, i_ = _roll_resample(outer, n), _roll_resample(inner, n)
    do = _offset_dirs(o)
    di = [-d for d in _offset_dirs(i_)]
    front = [(-bevel_t * math.cos(b / segs * PI / 2), bevel_s * math.sin(b / segs * PI / 2)) for b in range(segs + 1)]
    layers = front + [(depth - z, s) for z, s in reversed(front)]
    g, L = Geo(), len(layers)
    for cont, dirs in ((o, do), (i_, di)):
        for z, s in layers:
            for (x, y), dd in zip(cont, dirs):
                g.vert(x + dd.x * s, y + dd.y * s, z)
    ob, ib = 0, L * n
    for base, flip in ((ob, False), (ib, True)):
        for li in range(L - 1):
            for k in range(n):
                a, b = base + li * n + k, base + li * n + (k + 1) % n
                c, d = base + (li + 1) * n + (k + 1) % n, base + (li + 1) * n + k
                g.face((a, b, c, d) if not flip else (d, c, b, a))
    for li, flip in ((0, True), (L - 1, False)):
        for k in range(n):
            a, b = ob + li * n + k, ob + li * n + (k + 1) % n
            c, d = ib + li * n + (k + 1) % n, ib + li * n + k
            g.face((a, b, c, d) if not flip else (d, c, b, a))
    return g.weld(1e-7).planar_uv(1)
