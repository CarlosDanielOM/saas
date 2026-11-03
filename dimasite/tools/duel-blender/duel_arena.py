"""The arena (buildEnvironment in duel-claude-3d-scene.ts): rune platform, beveled tiers,
broken moon gate with eclipse corona, pillars with banners, braziers, shards, mist and
light shafts. The painted flagstone texture becomes real stones; the rune shader becomes
inlaid emissive geometry."""
import math
import random
from mathutils import Matrix, Vector
from duel_geo import (PI, TAU, Geo, Shape, trs, box, lathe, sphere, torus, cylinder, cone, rbox, octa, ico, circle, annulus, plane,
                      extrude, _offset_dirs, _area)
from duel_fighters import drape

FLAT = trs((0, 0, 0), (-PI / 2, 0, 0))  # XY-plane geometry -> lying on the floor (normal +Y)


def h21(n):
    s = math.sin(n * 127.1 + 311.7) * 43758.5453
    return s - math.floor(s)


def inset(pts, d):
    dirs = _offset_dirs(pts)
    return [(x - v.x * d, y - v.y * d) for (x, y), v in zip(pts, dirs)]


def strip(a, b, w, y=0.0):
    """Flat quad from a to b (x, z floor coords) of width w, normal +Y."""
    g = Geo()
    ax, az = a
    bx, bz = b
    dx, dz = bx - ax, bz - az
    ln = math.hypot(dx, dz) or 1
    nx, nz = -dz / ln * w / 2, dx / ln * w / 2
    i = [g.vert(ax + nx, y, az + nz), g.vert(bx + nx, y, bz + nz), g.vert(bx - nx, y, bz - nz), g.vert(ax - nx, y, az - nz)]
    g.face((i[0], i[3], i[2], i[1]))
    return g


def build():
    rnd = random.Random(41)
    objs = {}

    def put(obj, geo, mat, M=Matrix()):
        objs.setdefault(obj, []).append((geo, mat, M, None))

    R = 4.66
    # ---- platform: grout bed, flagstones, tiers, rings and ticks
    put('Arena_Floor', circle(R, 160), 'grout', trs((0, -.03, 0), (-PI / 2, 0, 0)))
    rings = [0, 70, 150, 225, 300, 372, 440, 512]
    k = R / 512
    gap = .011
    for r in range(len(rings) - 1):
        inner, outer = rings[r] * k, rings[r + 1] * k
        count = 1 if r == 0 else 8 + r * 6
        for i in range(count):
            shade = h21(r * 31 + i * 7.7)
            if r == 0:
                pts = [(math.cos(a / 32 * TAU) * (outer - gap), math.sin(a / 32 * TAU) * (outer - gap)) for a in range(32)]
            else:
                a0 = i / count * TAU + r * .37
                a1 = (i + 1) / count * TAU + r * .37
                go, gi = gap / outer, gap / inner
                n = max(3, int((a1 - a0) * outer / .16))
                pts = [(math.cos(a0 + go + (a1 - a0 - 2 * go) * s / n) * (outer - gap), math.sin(a0 + go + (a1 - a0 - 2 * go) * s / n) * (outer - gap)) for s in range(n + 1)]
                pts += [(math.cos(a1 - gi - (a1 - a0 - 2 * gi) * s / n) * (inner + gap), math.sin(a1 - gi - (a1 - a0 - 2 * gi) * s / n) * (inner + gap)) for s in range(n + 1)]
            bev = .012
            g = extrude(inset(pts, bev), .05, bev, bev, 2)
            g.shade = shade
            top = .05 + bev
            drop = -rnd.uniform(0, .004)
            tilt = (rnd.uniform(-.004, .004), rnd.uniform(-.004, .004))
            put('Arena_Floor', g, 'flagstone', trs((0, drop - top * 0 - 0, 0), (-PI / 2 + tilt[0], 0, tilt[1])) @ Matrix.Translation((0, 0, -top)))
    tiers = lathe([(4.66, -.06), (4.66, 0), (4.74, -.03), (4.8, -.1), (4.82, -.42), (5.08, -.46), (5.16, -.52), (5.18, -.72), (4.4, -.86)], 128)
    put('Arena_Platform', tiers, 'stone')
    for rr, y, mat, w in ((4.7, .005, 'glow_gold', .012), (4.81, -.25, 'arena_gold', .03), (5.17, -.6, 'glow_violet', .012)):
        put('Arena_Platform', torus(rr, w, 6, 160), mat, trs((0, y, 0), (-PI / 2, 0, 0)))
    for i in range(120):
        t = i / 120 * TAU
        put('Arena_Platform', box(.03, .02, .16 * (1 if i % 5 else 2)), 'glow_gold', trs((math.cos(t) * 4.95, -.455, math.sin(t) * 4.95), (0, -t, 0)))
    # ---- rune inlays (runeFloorMaterial as geometry): rings, ticks, glyph band, spokes, center sigil
    S = 4.65
    y = .0025
    for rr, w in ((.9, .022), (.84, .012), (.6, .014), (.3, .012)):
        put('Arena_Runes', annulus(rr * S - w / 2, rr * S + w / 2, 160), 'rune', trs((0, y, 0), (-PI / 2, 0, 0)))
    for i in range(72):
        a = i / 72 * TAU
        c, s = math.cos(a), math.sin(a)
        put('Arena_Runes', strip((c * .853 * S, s * .853 * S), (c * .884 * S, s * .884 * S), .016, y), 'rune')
    cols = 132
    for i in range(cols):
        if h21(math.floor(i / cols * 36) + 3.1) < .3:
            continue  # gaps between words, like the shader's sector mask
        a0 = i / cols * TAU
        da = TAU / cols * .62
        for kk in range(3):
            v = h21(i * 5 + kk)
            r0 = (.64 + kk * .055) * S
            r1 = r0 + .045 * S
            pa, pb = (math.cos(a0), math.sin(a0)), (math.cos(a0 + da), math.sin(a0 + da))
            if v < .33:   # tangential bar
                rm = (r0 + r1) / 2
                put('Arena_Runes', strip((pa[0] * rm, pa[1] * rm), (pb[0] * rm, pb[1] * rm), .012, y), 'rune')
            elif v < .66:  # radial bar
                am = a0 + da * (kk / 2)
                put('Arena_Runes', strip((math.cos(am) * r0, math.sin(am) * r0), (math.cos(am) * r1, math.sin(am) * r1), .012, y), 'rune')
            else:          # chevron
                am = a0 + da / 2
                tip = (math.cos(am) * r1, math.sin(am) * r1)
                put('Arena_Runes', strip((pa[0] * r0, pa[1] * r0), tip, .011, y), 'rune')
                put('Arena_Runes', strip(tip, (pb[0] * r0, pb[1] * r0), .011, y), 'rune')
    for q in range(4):
        a = q * PI / 2
        put('Arena_Runes', strip((math.cos(a) * .31 * S, math.sin(a) * .31 * S), (math.cos(a) * .59 * S, math.sin(a) * .59 * S), .018, y), 'rune')
        for side in (-1, 1):  # flanking diamonds along each spoke
            m = .45 * S
            put('Arena_Runes', strip((math.cos(a) * m, math.sin(a) * m), (math.cos(a + side * .06) * (m + .25), math.sin(a + side * .06) * (m + .25)), .01, y), 'rune')
    star = [(math.cos(i / 6 * TAU + PI / 2) * .5, math.sin(i / 6 * TAU + PI / 2) * .5) for i in range(6)]
    for i in range(6):  # hexagram in the center stone
        a, b = star[i], star[(i + 2) % 6]
        put('Arena_Runes', strip(a, b, .014, y), 'rune')
    put('Arena_Runes', annulus(.56, .575, 96), 'rune', trs((0, y, 0), (-PI / 2, 0, 0)))
    # ---- broken moon gate
    gate = trs((0, 3.7, -4.6))
    for i in range(12):
        t0 = i / 12 * TAU + .04
        t1 = (i + 1) / 12 * TAU - .04
        sh = Shape().arc(0, 0, 2.62, t0, t1, n=20).arc(0, 0, 2.2, t1, t0, n=20).closed()
        broken = 1 if i in (4, 9) else 0
        mid = (t0 + t1) / 2
        pos = (math.cos(mid) * broken * .35, math.sin(mid) * broken * .35, -.13 + broken * .2)
        seg = extrude(sh, .26, .04, .04, 3)
        put('Arena_Gate', seg, 'arena_metal', gate @ trs(pos, (0, 0, broken * .08)))
        put('Arena_Gate', torus(2.41, .012, 6, 24, t1 - t0 - .06), 'glow_gold', gate @ trs((pos[0], pos[1], .17 + broken * .2), (0, 0, t0 + .03 + broken * .08)))
        for rr in (2.25, 2.57):  # gilded edge beads
            put('Arena_Gate', torus(rr, .01, 5, 20, t1 - t0 - .02), 'arena_gold', gate @ trs((pos[0], pos[1], .175 + broken * .2), (0, 0, t0 + .01 + broken * .08)))
        gm = (i + 1) / 12 * TAU  # gem between segments
        put('Arena_Gate', octa(.06), 'glow_violet', gate @ trs((math.cos(gm) * 2.41, math.sin(gm) * 2.41, 0), (0, 0, gm), (1.6, .8, .8)))
    put('Arena_Gate', circle(2.1, 128), 'eclipse', gate @ trs((0, 0, -.2)))
    put('Arena_Corona', plane(9, 9), 'corona', gate @ trs((0, 0, -.35)))
    # ---- pillars with capitals, veins and side-colored banners
    for side in (-1, 1):
        for i in range(3):
            h = 3.6 + i * .7
            P = trs((side * (5.3 + i * 1.05), -.5, -3.2 - i * 1.1), (0, 0, side * -.05 * i))
            put('Arena_Pillars', cylinder(.26, .34, h, 6, rings=4), 'stone', P @ trs((0, h / 2, 0)))
            put('Arena_Pillars', lathe([(.3, 0), (.46, .12), (.5, .2), (.38, .28)], 6), 'arena_metal', P @ trs((0, h, 0)))
            put('Arena_Pillars', lathe([(.5, 0), (.5, .14), (.38, .24)], 6), 'arena_metal', P)
            for yb in (.28, .62):
                rr = .34 + (.26 - .34) * yb + .02
                put('Arena_Pillars', cylinder(rr, rr, .06, 6), 'arena_metal', P @ trs((0, h * yb, 0)))
            put('Arena_Pillars', box(.035, h * .7, .035), 'glow_violet' if side < 0 else 'glow_gold', P @ trs((0, h * .5, .3)))
            if i < 2:
                cloth = drape(.62, 2.0, 4, 12, rest=.02, flutter=.6, seed=i * 2 + side, folds=2, fold_amp=.03, thick=.008)
                n = cloth.cloth['n']
                rows, cols = cloth.cloth['rows'], cloth.cloth['cols']
                sway = [((j % n) // (cols + 1)) / rows for j in range(len(cloth.v))]  # 0 at the rod -> 1 at the hem
                cloth.attrs = {'_sway': sway, '_seed': [float(i * 2 + side)] * len(cloth.v)}
                put('Arena_BannerCloth', cloth, 'banner_L' if side < 0 else 'banner_R', P @ trs((0, h - .1, .4)))
                put('Arena_Banners', cylinder(.025, .025, .8, 12), 'arena_gold', P @ trs((0, h - .08, .4), (0, 0, PI / 2)))
                for x in (-.4, .4):
                    put('Arena_Banners', sphere(.04, 12, 8), 'arena_gold', P @ trs((x, h - .08, .4)))
                put('Arena_Banners', circle(.15, 6), 'glow_violet' if side < 0 else 'glow_gold', P @ trs((0, h - .75, .44)))
                put('Arena_Banners', annulus(.17, .19, 6, a0=0), 'arena_gold', P @ trs((0, h - .75, .441), (0, 0, 0)))
    # ---- braziers
    for side in (-1, 1):
        B = trs((side * 4.15, 0, -1.6))
        put('Arena_Braziers', lathe([(.06, 0), (.08, .55), (.1, .62), (.34, .78), (.38, .88), (.33, .9)], 40), 'arena_metal', B)
        put('Arena_Braziers', lathe([(.0, .0), (.26, 0), (.25, .03), (.12, .08), (.07, .14)], 40), 'arena_metal', B)
        put('Arena_Braziers', torus(.36, .014, 8, 48), 'arena_gold', B @ trs((0, .86, 0), (PI / 2, 0, 0)))
        put('Arena_Braziers', sphere(.32, 24, 8, TAU, PI / 2), 'coals', B @ trs((0, .8, 0), (0, 0, 0), (1, .28, 1)))
        fl = 'flame_violet' if side < 0 else 'flame_amber'
        for kk, (sx, sy, rot, off) in enumerate(((1, 1, 0, (0, 0)), (.65, .8, 1.3, (.1, .05)), (.6, .7, 2.6, (-.09, -.06)), (.45, 1.15, .5, (0, .02)))):
            prof = [(0, 0), (.15, .06), (.21, .22), (.19, .42), (.12, .68), (.05, .92), (0, 1.12)]
            g = lathe(prof, 24)
            for v in g.v:  # licking, twisted tongues
                tw = v.y * 2.2 + kk
                ca, sa = math.cos(tw * .5), math.sin(tw * .5)
                v.x, v.z = v.x * ca - v.z * sa, v.x * sa + v.z * ca
                v.x += math.sin(v.y * 5 + kk * 1.7) * .05 * v.y
                v.z += math.cos(v.y * 4 + kk) * .04 * v.y
            put('Arena_Flames', g, fl, B @ trs((off[0], .84, off[1]), (0, rot, 0), (sx * .9, sy * .95, sx * .9)))
    # ---- floating shards behind the stage
    for i in range(18):
        t = PI * (1.04 + (i / 17) * .92) + math.sin(i * 7.1) * .05
        r = 5.8 + (i % 4) * .8
        c = (math.cos(t) * r, .3 + (i % 5) * .35, math.sin(t) * r - 1)
        g = octa(.16 + (i % 3) * .09)
        # Per-vertex shard center and index: the runtime spins and bobs each shard in a vertex shader.
        g.attrs = {'_cx': [c[0]] * len(g.v), '_cy': [c[1]] * len(g.v), '_cz': [c[2]] * len(g.v), '_si': [float(i)] * len(g.v)}
        put('Arena_Shards', g, 'stone', trs(c, (t, t * .3, t * .2), (1, 1.6, 1)))
    # ---- mist sheets and light shafts
    for z, w in ((-2.6, 14), (3.6, 16)):
        put('Arena_Mist' if z < 0 else 'Arena_MistFront', plane(w, 2.4), 'mist', trs((0, .5, z)))
    for i in range(3):
        put('Arena_Shafts', cylinder(0, 1.4 + i * .3, 8, 32, open_ended=True), 'shaft_b' if i == 1 else 'shaft_a',
            trs(((i - 1) * 2.2, 3.4, -2.6), (0, 0, (i - 1) * -.28)))
    # ---- ambient motes
    for i in range(130):
        p = (rnd.uniform(-7.5, 7.5), rnd.uniform(.1, 5.5), rnd.uniform(-7, 2.5))
        put('Arena_Motes', ico(rnd.uniform(.005, .012), 1), 'mote_violet' if i % 3 else 'mote_gold', trs(p))
    return objs
