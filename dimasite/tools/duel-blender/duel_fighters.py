"""Knight, Mage and Ronin: a port of quality-extreme/duel-claude-3d-rig.ts.

Each fighter is a joint tree (hips -> spine -> chest -> neck -> head, two-bone arms,
three-joint legs, weapon) carrying parts. Coordinates, proportions and colors follow
the web version; blades are lofted (real ridge + fuller), cloth gets thickness and
folds, the crest and the plume are real geometry.
"""
import math
from mathutils import Matrix, Vector
from duel_geo import (PI, TAU, Geo, Shape, trs, euler, lathe, sphere, torus, cylinder, cone, capsule, rbox, octa, ico,
                      circle, plane, taper_tube, extrude, ring_extrude, solidify, grid)

HIP, THIGH, SHIN = 1.02, .46, .44
JOINT_AXIS = {'root': 'up', 'hp': 'up', 'sp': 'up', 'ch': 'up', 'nk': 'up', 'hd': 'up', 'bk': 'up',
              'sR': 'down', 'eR': 'down', 'wR': 'down', 'sL': 'down', 'eL': 'down', 'wL': 'down',
              'tR': 'down', 'kR': 'down', 'aR': 'down', 'tL': 'down', 'kL': 'down', 'aL': 'down', 'wp': 'fwd',
              # Parts the runtime moves or hides on their own (scaled to zero when hidden).
              'gb': 'up', 'gh': 'up', 'sh': 'up', 'o0': 'up', 'o1': 'up', 'o2': 'up'}
JOINT_LEN = {'root': .2, 'hp': .08, 'sp': .3, 'ch': .36, 'nk': .1, 'hd': .26, 'bk': .12, 'sR': .34, 'eR': .3, 'wR': .1,
             'sL': .34, 'eL': .3, 'wL': .1, 'tR': THIGH, 'kR': SHIN, 'aR': .08, 'tL': THIGH, 'kL': SHIN, 'aL': .08, 'wp': .5,
             'gb': .12, 'gh': .12, 'sh': .2, 'o0': .04, 'o1': .04, 'o2': .04}

PALETTE = {  # tint, cloth, clothDark  (left = violet, right = amber, enraged = crimson)
    'L': ('#b49cff', '#3b2a7a', '#1b1638'),
    'R': ('#ffc06b', '#8a4220', '#3b1b10'),
    'E': ('#ff3a55', '#6b1424', '#2d0710'),
}


class Node:
    def __init__(self, joint=None, p=(0, 0, 0), r=(0, 0, 0), s=(1, 1, 1), order='XYZ'):
        self.joint, self.p, self.r, self.s, self.order = joint, p, r, s, order
        self.children, self.parts, self.parent = [], [], None

    def child(self, p=(0, 0, 0), r=(0, 0, 0), s=(1, 1, 1), joint=None, order='XYZ'):
        n = Node(joint, p, r, s, order)
        n.parent = self
        self.children.append(n)
        return n

    def local(self):
        return trs(self.p, self.r, self.s, self.order)


def add(node, geo, mat, p=(0, 0, 0), r=(0, 0, 0), s=(1, 1, 1), weights=None):
    node.parts.append((geo, mat, trs(p, r, s), weights))
    return geo


def ext(shape_pts, depth, bevel):
    return extrude(shape_pts, depth, bevel, bevel, 2).transform(Matrix.Translation((0, 0, -depth / 2)))


# ---------------------------------------------------------------- cloth

def drape(width, length, cols, rows, rest=.12, taper=0., facing=1, flutter=1., stiff=1., seed=0., t=0., wind=.1,
          folds=0, fold_amp=0., thick=.006):
    """Static frame of the web version's chain cloth, at higher resolution with folds."""
    cols, rows = max(2, cols * 2), rows * 2
    seg = length / rows
    lift = max(-.5, min(1.45, wind))
    g = Geo()
    for r in range(rows + 1):
        g.v += [None] * (cols + 1)
    for c in range(cols + 1):
        u = c / cols - .5
        x, y, z = u * width, 0., 0.
        for r in range(rows + 1):
            v = r / rows
            if r > 0:
                wave = math.sin(t * (2.3 + wind * 3) - v * 5.5 + u * 2.4 + seed) * (.05 + wind * .16 + abs(lift) * .05) * flutter
                theta = (rest + lift * v ** (.7 * stiff) + wave * v) * facing
                phi = math.sin(t * 1.7 - v * 3.8 + u * 3 + seed) * .06 * v * flutter
                x += math.sin(phi) * seg - u * width * taper / rows
                y -= math.cos(theta) * math.cos(phi) * seg
                z -= math.sin(theta) * seg
            fz = math.sin(u * folds * TAU + seed * 3) * fold_amp * (.25 + v) if folds else 0
            g.v[r * (cols + 1) + c] = Vector((x, y, z + fz))
    grid(g, rows, cols, 0, lambda r, c: (c / cols, 1 - r / rows))
    # Everything a runtime needs to re-drape this strip with bone chains (cloth.json).
    g.cloth = dict(rows=rows, cols=cols, n=len(g.v), width=width, length=length, rest=rest, taper=taper, facing=facing,
                   flutter=flutter, stiff=stiff, seed=seed, wind=wind)
    return solidify(g, thick) if thick else g


def skirt_weights(geo, top, bottom, thigh_r='tR', thigh_l='tL', amount=.5):
    """Skin a lathe robe to the hips, letting the hem follow the thighs (front-biased)."""
    out = []
    for v in geo.v:
        h = max(0., min(1., (top - v.y) / (top - bottom)))
        a = math.atan2(v.x, v.z)
        wr = max(0., math.cos(a + .55)) * amount * h ** 1.4   # character's right is -X
        wl = max(0., math.cos(a - .55)) * amount * h ** 1.4
        wr, wl = wr * .6 + amount * .25 * h ** 1.6 * (v.x < 0), wl * .6 + amount * .25 * h ** 1.6 * (v.x >= 0)
        out.append({'hp': max(0., 1 - wr - wl), thigh_r: wr, thigh_l: wl})
    return out


# ---------------------------------------------------------------- blades

def blade_loft(length, width, tip, thick=.016, stations=34, fuller=.72):
    """Double-edged longsword: diamond section with a fuller, length +Z, edges ±Y, faces ±X."""
    g = Geo()
    ring = None
    for k in range(stations + 1):
        z = length * k / stations
        if z <= length - tip:
            w = width / 2 + (width * .42 - width / 2) * (z / (length - tip))
        else:
            q = (z - (length - tip)) / tip
            w = width * .42 * max(0., 1 - min(1., q) ** 1.6) ** .75
        t = thick * (1 - .55 * z / length) * (1 if z < length - tip else max(.08, 1 - min(1., (z - (length - tip)) / tip) ** 1.2))
        groove = fuller > 0 and z / length < fuller
        depth = t * (.5 if groove else 1.0) if z / length < fuller - .04 else t
        sec = [(0, w), (t * .62, w * .55), (t, w * .24), (depth, 0), (t, -w * .24), (t * .62, -w * .55), (0, -w),
               (-t * .62, -w * .55), (-t, -w * .24), (-depth, 0), (-t, w * .24), (-t * .62, w * .55)]
        ring = [g.vert(x, y, z) for x, y in sec]
    n = 12
    for k in range(stations):
        for i in range(n):
            a = k * n + i
            b = k * n + (i + 1) % n
            g.face((a, b, b + n, a + n), ((i / n, k / stations), ((i + 1) / n, k / stations), ((i + 1) / n, (k + 1) / stations), (i / n, (k + 1) / stations)))
    g.face(tuple(reversed(range(n))))
    return g.weld(1e-7)


def katana_loft(length, width, sori, thick=.0115, stations=36):
    """Curved single-edged blade: shinogi ridge, mune spine and a swept kissaki."""
    g = Geo()
    n = 8
    body = int(stations * .9)
    rows = []
    for k in range(stations + 1):
        if k <= body:
            q = k / body
            z = length * q
            c = sori * q * q
            w = width * (1 - .22 * q)
            edge, spine, t = c - w * .5, c + w * .5, thick * (1 - .3 * q)
        else:
            q = (k - body) / (stations - body)
            z = length + width * .55 * q
            c = sori
            w = width * .78 * (1 - q)
            spine = sori + width * .39 + (w * .5 - width * .39 * (1 - q)) * 0
            spine = sori + width * .39
            edge = spine - max(.0005, (width * .78) * (1 - q) ** 1.5)
            t = thick * .7 * (1 - q) + .0006
        span = spine - edge
        sec = [(0, edge), (t * .55, edge + span * .3), (t, edge + span * .7), (t * .7, spine - span * .04), (0, spine),
               (-t * .7, spine - span * .04), (-t, edge + span * .7), (-t * .55, edge + span * .3)]
        rows.append([g.vert(x, y, z) for x, y in sec])
    for k in range(stations):
        for i in range(n):
            a, b = rows[k][i], rows[k][(i + 1) % n]
            c, d = rows[k + 1][(i + 1) % n], rows[k + 1][i]
            g.face((a, b, c, d))
    g.face(tuple(reversed(rows[0])))
    tip = g.vert(0, sori + width * .39, length + width * .58)
    last = rows[-1]
    for i in range(n):
        g.face((last[i], last[(i + 1) % n], tip))
    return g.weld(1e-7).planar_uv(4)


# ---------------------------------------------------------------- rig

class Rig:
    def __init__(self, character, palette):
        self.character, self.palette = character, palette
        self.root = Node('root')
        self.j = {'root': self.root}

    def joint(self, parent, name, p, order='XYZ'):
        n = self.j[parent].child(p, joint=name, order=order)
        self.j[name] = n
        return n


def mats(palette):
    P = palette
    return {k: k for k in ('steel', 'dark', 'gold', 'leather', 'trim', 'skin', 'wood', 'lacquer', 'straw', 'tabi', 'hair',
                           'glass', 'shadow', 'paper', 'vialA', 'vialB', 'mon', 'mail')} | {
        'cloth': f'cloth_{P}', 'clothDark': f'clothDark_{P}', 'glow': f'glow_{P}', 'eye': f'eye_{P}',
        'crystal': f'crystal_{P}', 'scarf': f'scarf_{P}', 'runes': f'runes_{P}', 'aura': 'aura', 'plume': f'cloth_{P}'}


def build(character, palette='L', enraged=False):
    pal = 'E' if enraged else palette
    m = mats(pal)
    rig = Rig(character, pal)
    J = rig.joint
    J('root', 'hp', (0, HIP, 0))
    J('hp', 'sp', (0, .08, 0))
    J('sp', 'ch', (0, .3, 0))
    J('ch', 'nk', (0, .36, 0))
    J('nk', 'hd', (0, .1, 0))
    sh = {'knight': .33, 'ronin': .29, 'mage': .27}[character]
    for side, x in (('R', -sh), ('L', sh)):
        J('ch', 's' + side, (x, .27, 0))
        J('s' + side, 'e' + side, (0, -.34, 0))
        J('e' + side, 'w' + side, (0, -.3, 0))
    for side, x in (('R', -.13), ('L', .13)):
        J('hp', 't' + side, (x, -.04, 0), order='ZYX')
        J('t' + side, 'k' + side, (0, -THIGH, 0))
        J('k' + side, 'a' + side, (0, -SHIN, 0))
    J('wR', 'wp', (0, -.07, .02))
    j = rig.j
    for w, e in ((j['wR'], j['eR']), (j['wL'], j['eL'])):
        fist(w, m['steel'] if character == 'knight' else m['skin'] if character == 'mage' else m['leather'],
             m['skin'] if character == 'ronin' else None)
        add(e, sphere(.06, 20, 14), m['gold'] if character == 'knight' else m['dark'])
    {'knight': knight, 'mage': mage, 'ronin': ronin}[character](rig, m)
    if enraged:
        add(j['root'], cylinder(.62, .8, 2.5, 48, open_ended=True), m['aura'], (0, 1.15, 0))
    return rig


def fist(wrist, glove, skin):
    add(wrist, rbox(.085, .085, .095, .028), glove, (0, -.03, .005))
    for i in range(4):
        x = -.03 + i * .02
        add(wrist, capsule(.0125, .04, 3, 10), skin or glove, (x, -.085, .035), (1.15, 0, 0), (1, 1 - abs(i - 1.5) * .08, 1))
    add(wrist, capsule(.014, .04, 3, 10), skin or glove, (.048, -.05, .045), (.6, 0, -.6))
    add(wrist, lathe([(.05, .03), (.058, -.02)], 20), glove)


def boot(rig, m, armored, ronin=False):
    for s in 'RL':
        knee, ankle = rig.j['k' + s], rig.j['a' + s]
        if ronin:
            add(ankle, rbox(.12, .1, .26, .045), m['tabi'], (0, -.02, .05))
            add(ankle, rbox(.14, .025, .31, .01), m['straw'], (0, -.075, .055))
            for z in (0., .1):
                add(ankle, torus(.068, .008, 8, 24), m['leather'], (0, -.035, z + .04), (0, PI / 2, 0), (1, .55, 1))
        else:
            add(ankle, rbox(.15, .1, .3, .045), m['steel'] if armored else m['leather'], (0, -.03, .06))
        if armored:
            add(ankle, sphere(.08, 20, 10, TAU, PI / 2), m['steel'], (0, -.02, .18), (PI / 2, 0, 0), (1, 1.4, .6))
            add(knee, sphere(.085, 22, 14), m['steel'], (0, 0, .03))
            add(knee, cone(.04, .1, 12), m['gold'], (0, 0, .12), (PI / 2, 0, 0))


def star(points=16, r0=.075, r1=.035):
    return [((r1 if i % 2 else r0) * math.cos(i / points * TAU), (r1 if i % 2 else r0) * math.sin(i / points * TAU)) for i in range(points)]


def knight(rig, m):
    j = rig.j
    hp, sp, ch, hd, nk = j['hp'], j['sp'], j['ch'], j['hd'], j['nk']
    # Fauld and belt.
    add(hp, lathe([(.2, .1), (.24, .02), (.27, -.08), (.3, -.2), (.29, -.22)], 48), m['steel'], s=(1, 1, .8))
    add(hp, torus(.235, .025, 10, 48), m['leather'], (0, .07, 0), (PI / 2, 0, 0), (1, .8, 1))
    add(hp, rbox(.12, .09, .04, .015), m['gold'], (0, .07, .2))
    for i in range(3):
        add(hp, lathe([(.25 + i * .02, 0), (.285 + i * .02, -.06)], 48), m['steel'], (0, -.02 - i * .065, 0), s=(1, 1, .8))
        add(hp, torus(.285 + i * .02, .006, 8, 48), m['gold'], (0, -.08 - i * .065, 0), (PI / 2, 0, 0), (1, .8, 1))
    # Abdomen mail and breastplate.
    add(sp, lathe([(.16, -.06), (.2, .05), (.21, .2), (.2, .32)], 40), m['mail'], s=(1, 1, .82))
    add(ch, lathe([(.18, -.04), (.25, .05), (.31, .18), (.32, .28), (.27, .37), (.15, .43), (.1, .45)], 64), m['steel'], s=(1, 1, .74))
    add(ch, rbox(.025, .4, .03, .01), m['steel'], (0, .2, .24), (-.08, 0, 0))
    add(ch, torus(.2, .018, 10, 48), m['gold'], (0, -.02, 0), (PI / 2, 0, 0), (1.05, .78, 1))
    add(ch, lathe([(.11, 0), (.15, .04), (.14, .1)], 32), m['gold'], (0, .4, 0))
    sun = star()
    add(ch, ext(sun, .01, .006), m['glow'], (0, .24, .232), (-.15, 0, 0))
    add(ch, torus(.085, .008, 8, 40), m['gold'], (0, .24, .228), (-.15, 0, 0))
    # Pauldrons: three lames with gilded edges and rivets.
    for s, d in (('R', -1), ('L', 1)):
        shoulder, elbow = j['s' + s], j['e' + s]
        for i in range(3):
            pos = (d * (.02 + i * .012), .05 - i * .07, 0)
            add(shoulder, sphere(.17 - i * .015, 32, 12, TAU, PI / 2), m['steel'], pos, (0, 0, d * -(.5 + i * .18)), (1, .75, 1.05))
            add(shoulder, torus(.165 - i * .015, .01, 8, 40), m['gold'], pos, (PI / 2, d * -(.5 + i * .18), 0), (1, 1.05, 1))
        for k in range(5):  # rivets along the top lame, sitting on its surface
            z = (k - 2) * .05
            local = Vector((0, .75 * math.sqrt(max(0, .17 ** 2 - (z / 1.05) ** 2)) + .004, z))
            p = (euler((0, 0, d * -.5)) @ local.to_4d()).to_3d() + Vector((d * .02, .05, 0))
            add(shoulder, sphere(.011, 10, 8), m['gold'], tuple(p))
        add(shoulder, capsule(.07, .16, 6, 16), m['dark'], (0, -.18, 0))
        add(shoulder, lathe([(.08, -.04), (.09, .08), (.075, .12)], 28), m['steel'], (0, -.26, 0))
        add(elbow, lathe([(.07, -.02), (.075, -.12), (.085, -.24), (.065, -.27)], 28), m['steel'])
        add(elbow, torus(.083, .009, 8, 28), m['gold'], (0, -.23, 0), (PI / 2, 0, 0))
    # Great helm: rounded crown, visor slit, gilded cross and crest plume.
    add(hd, lathe([(.0, -.14), (.15, -.14), (.17, -.04), (.175, .08), (.16, .18), (.11, .25), (.0, .27)], 48), m['steel'], (0, .1, 0), s=(1, 1, 1.05))
    add(hd, rbox(.24, .028, .04, .01), m['eye'], (0, .12, .165))
    add(hd, rbox(.022, .1, .04, .008), m['eye'], (0, .06, .17))
    add(hd, rbox(.03, .3, .03, .01), m['gold'], (0, .2, .17), (-.25, 0, 0))
    add(hd, torus(.17, .012, 10, 40), m['gold'], (0, -.02, .02), (PI / 2, 0, 0))
    for k in range(5):  # breaths on the right cheek of the faceplate
        for row in range(2):
            x = .045 + k * .017
            z = math.sqrt(max(0, .163 ** 2 - x ** 2)) * 1.05
            add(hd, cylinder(.0055, .0055, .012, 8), m['shadow'], (x, .03 - row * .026, z - .003), (PI / 2, 0, -math.atan2(x, z)), (1, 1, 1))
    for k, (dx, sc) in enumerate(((0, 1.0), (-.022, .82), (.022, .82), (-.04, .62), (.04, .62))):
        pts = [Vector((dx * .3, .36, .1)), Vector((dx * .6, .47 - k * .006, -.04)), Vector((dx, .43, -.22)),
               Vector((dx * 1.3, .25 - k * .01, -.36)), Vector((dx * 1.5, .02 - k * .03, -.41))]
        plume = taper_tube(pts, lambda u, sc=sc: (.075 * math.sin(PI * min(1, u * 1.15 + .08)) + .006) * sc * .62, 36, 12)
        add(hd, plume, m['plume'], s=(.62, 1, 1))
    add(nk, lathe([(.09, -.06), (.1, .06)], 24), m['mail'])
    # Legs: cuisses, greaves and sabatons.
    for s in 'RL':
        add(j['t' + s], lathe([(.1, -.02), (.125, -.12), (.11, -.34), (.09, -.42)], 32), m['steel'], s=(1, 1, .9))
        add(j['k' + s], lathe([(.075, -.04), (.09, -.14), (.085, -.3), (.07, -.4)], 32), m['steel'], s=(1, 1, .95))
        add(j['k' + s], torus(.088, .006, 8, 32), m['gold'], (0, -.14, 0), (PI / 2, 0, 0), (1, .95, 1))
    # Cape clasps, empty scabbard, belt pouch and a mail skirt under the fauld.
    for x in (-.17, .17):
        add(ch, cylinder(.045, .045, .02, 24), m['gold'], (x, .38, .17), (PI / 2, 0, 0))
        add(ch, octa(.022), m['glow'], (x, .38, .185))
    scab = hp.child((.28, -.02, -.04), (-.38, 0, .14))
    add(scab, cylinder(.04, .03, .98, 18), m['lacquer'], (0, -.5, 0), s=(1, 1, .42))
    add(scab, cone(.032, .09, 16), m['gold'], (0, -1.03, 0), (PI, 0, 0), (1, 1, .45))
    for y in (-.04, -.36):
        add(scab, torus(.04, .008, 8, 22), m['gold'], (0, y, 0), (PI / 2, 0, 0), (1, .45, 1))
    add(hp, rbox(.1, .1, .055, .018), m['leather'], (-.2, -.01, .14), (0, -.6, 0))
    add(hp, cylinder(.012, .012, .02, 12), m['gold'], (-.2, .02, .175), (PI / 2, 0, -.6))
    add(hp, lathe([(.25, -.18), (.29, -.3), (.31, -.38)], 48), m['mail'], s=(1, 1, .82))
    add(hd, octa(.035), m['gold'], (0, .27, .16), s=(.7, 1.3, .5))
    boot(rig, m, True)
    # Longsword: lofted steel with a luminous fuller, curved quillons, wrapped grip.
    w = j['wp']
    add(w, blade_loft(1.12, .09, .16), m['steel'], (0, 0, .12))
    for x in (.0072, -.0072):
        add(w, rbox(.003, .008, .74, .0015), m['glow'], (x, 0, .48))
    add(w, taper_tube([Vector((0, -.2, .02)), Vector((0, -.1, .1)), Vector((0, 0, .11)), Vector((0, .1, .1)), Vector((0, .2, .02))],
                      lambda u: .018 + abs(u - .5) * .02, 24, 12), m['gold'])
    add(w, cylinder(.026, .03, .22, 16, rings=6), m['leather'], (0, 0, -.01), (PI / 2, 0, 0))
    for k in range(6):
        add(w, torus(.029, .004, 6, 16), m['leather'], (0, 0, -.1 + k * .035), (0, 0, 0), (1, 1, 1))
    add(w, sphere(.04, 20, 14), m['gold'], (0, 0, -.14))
    add(w, octa(.022), m['glow'], (0, 0, -.17))
    # Kite shield on the off hand: dark field, gilded rim, sun boss and glowing cross.
    kite = Shape().move(-.25, .3).quad(0, .38, .25, .3).line(.23, -.04).quad(.16, -.32, 0, -.48).quad(-.16, -.32, -.23, -.04).closed()
    hole = Shape().move(-.215, .27).line(-.198, -.03).quad(-.135, -.27, 0, -.415).quad(.135, -.27, .198, -.03).line(.215, .27).quad(0, .335, -.215, .27).closed()
    shield = j['wL'].child((.03, .02, .1))
    add(shield, ext(kite, .03, .022), m['dark'])
    add(shield, ring_extrude(kite, hole, .012, .01, .01).transform(Matrix.Translation((0, 0, -.006))), m['gold'], (0, 0, .035))
    add(shield, ext(sun, .01, .008), m['gold'], (0, .06, .05), s=(1.6, 1.6, 1))
    add(shield, rbox(.03, .5, .012, .006), m['glow'], (0, -.04, .044))
    add(shield, rbox(.32, .03, .012, .006), m['glow'], (0, .1, .044))
    for x, y in ((-.2, .28), (.2, .28), (-.19, -.02), (.19, -.02), (0, -.4)):
        add(shield, sphere(.013, 10, 8), m['gold'], (x, y, .046))
    # Cape and tabards.
    add(ch, drape(.62, 1.22, 8, 14, rest=.16, taper=-.35, flutter=1, folds=3, fold_amp=.025, thick=.008), m['cloth'], (0, .4, -.2))
    for z, facing in ((.22, -1), (-.2, 1)):
        add(hp, drape(.26, .5, 3, 8, rest=.04, facing=facing, flutter=.5, seed=z * 9, thick=.006), m['cloth'], (0, .02, z))


def mage(rig, m):
    j = rig.j
    hp, sp, ch, hd = j['hp'], j['sp'], j['ch'], j['hd']
    # Robe skirt: a flared lathe skinned to the hips and thighs.
    skirt = lathe([(.2, .08), (.24, -.1), (.3, -.35), (.38, -.62), (.46, -.88), (.47, -.92)], 64)
    for v in skirt.v:  # soft vertical folds
        a = math.atan2(v.x, v.z)
        h = max(0, min(1, (.08 - v.y) / 1.0))
        k = 1 + h * .045 * math.cos(a * 11)
        v.x *= k
        v.z *= k
    sk = skirt.transform(Matrix.Diagonal((1, 1, .85, 1)))
    hp.parts.append((sk, m['cloth'], Matrix(), skirt_weights(sk, .08, -.92)))
    hem = lathe([(.465, -.86), (.475, -.9), (.47, -.93)], 64).transform(Matrix.Diagonal((1.045, 1, .85 * 1.045, 1)))
    hp.parts.append((hem, m['trim'], Matrix(), skirt_weights(hem, .08, -.92)))
    band = lathe([(.418, -.72), (.449, -.82)], 96)
    for v in band.v:
        a = math.atan2(v.x, v.z)
        k = 1 + .045 * .8 * math.cos(a * 11) + .004
        v.x *= k
        v.z *= k
    band.transform(Matrix.Diagonal((1, 1, .85, 1)))
    hp.parts.append((band, m['runes'], Matrix(), skirt_weights(band, .08, -.92)))
    add(hp, torus(.215, .03, 10, 40), m['trim'], (0, .06, 0), (PI / 2, 0, 0), (1, .85, 1))
    add(hp, rbox(.07, .07, .03, .015), m['glow'], (0, .06, .19))
    # Upper robe, cowl and brooch.
    add(sp, lathe([(.19, -.04), (.2, .1), (.2, .32)], 40), m['cloth'], s=(1, 1, .82))
    add(ch, lathe([(.19, -.02), (.24, .12), (.27, .26), (.24, .36), (.14, .44)], 48), m['cloth'], s=(1, 1, .8))
    add(ch, lathe([(.13, .34), (.25, .36), (.27, .4), (.18, .48), (.1, .46)], 48), m['clothDark'], s=(1, 1, .9))
    add(ch, octa(.05), m['crystal'], (0, .3, .2), s=(1, 1.4, .6))
    add(ch, torus(.055, .01, 8, 28), m['trim'], (0, .3, .195))
    for x in (-.08, .08):
        add(ch, rbox(.03, .36, .01, .005), m['trim'], (x, .14, .21), (-.1, 0, 0))
    # Bell sleeves.
    for s in 'RL':
        shoulder, elbow = j['s' + s], j['e' + s]
        add(shoulder, sphere(.1, 22, 14), m['cloth'], (0, -.02, 0))
        add(shoulder, lathe([(.08, 0), (.09, -.18), (.085, -.34)], 28), m['cloth'])
        add(elbow, lathe([(.08, .02), (.11, -.12), (.17, -.28), (.19, -.32)], 36), m['cloth'], (0, 0, .015))
        add(elbow, lathe([(.183, -.318), (.16, -.27), (.1, -.13), (.07, -.02)], 36), m['clothDark'], (0, 0, .015))
        add(elbow, torus(.185, .012, 8, 40), m['trim'], (0, -.315, .015), (PI / 2, 0, 0))
    # Shadowed face, glowing eyes and a wizard hat with a bent tip.
    add(hd, sphere(.15, 28, 18), m['shadow'], (0, .1, .01), s=(1, 1.1, .95))
    for x in (-.055, .055):
        add(hd, capsule(.014, .03, 4, 10), m['eye'], (x, .11, .135), (0, 0, PI / 2))
    add(hd, lathe([(.08, 0), (.36, .0), (.42, -.03), (.42, -.045), (.34, -.02), (.08, -.02)], 64), m['cloth'], (0, .2, 0))
    hat = taper_tube([Vector((0, .18, 0)), Vector((0, .38, -.02)), Vector((.02, .58, -.06)), Vector((.1, .72, -.14)), Vector((.26, .74, -.2))],
                     lambda u: .19 * (1 - u) ** 1.15 + .006, 48, 28)
    add(hd, hat, m['cloth'])
    add(hd, torus(.172, .022, 10, 44), m['trim'], (0, .23, 0), (PI / 2, 0, 0))
    add(hd, octa(.035), m['crystal'], (0, .235, .17))
    for k in range(5):  # stitched patches on the hat
        a = -.9 + k * .45
        add(hd, rbox(.012, .05, .004, .002), m['trim'], (math.sin(a) * .168, .33, math.cos(a) * .168 - .015), (-.15, a, .35))
    # Gnarled staff with a crescent claw holding a floating crystal.
    w = j['wp']
    shaft = taper_tube([Vector((0, 0, -.95)), Vector((.02, .01, -.4)), Vector((-.01, -.01, .2)), Vector((.015, .02, .8)), Vector((0, 0, 1.18))],
                       lambda u: .03 + .008 * math.sin(u * 40) + (.25 * (u - .9) if u > .9 else 0), 96, 14)
    add(w, shaft, m['wood'])
    for z in (-.2, .55, .95):
        add(w, torus(.04, .01, 8, 24), m['trim'], (0, 0, z))
    for d in (-1, 1):
        add(w, taper_tube([Vector((0, 0, 1.16)), Vector((d * .1, 0, 1.24)), Vector((d * .14, 0, 1.42)), Vector((d * .06, 0, 1.56))],
                          lambda u: .022 * (1 - u) + .005, 28, 10), m['trim'])
    add(w, octa(.075), m['crystal'], (0, 0, 1.4), s=(1, 1, 1.7))
    for k in range(3):  # orbs circling the crystal: one joint each, the runtime orbits them
        a = k / 3 * TAU + .4
        orb = rig.joint('wp', f'o{k}', (math.cos(a) * .22, math.sin(a) * .22, 1.4 + math.sin(a * 2) * .05))
        add(orb, ico(.022, 1), m['glow'])
    # Stole: two ribbons falling over the chest, and a dark back panel.
    for x in (-.11, .11):
        add(ch, drape(.075, .75, 1, 10, rest=-.08, facing=-1, flutter=.7, seed=x * 30, thick=.004), m['trim'], (x, .38, .19))
    add(ch, drape(.5, .8, 6, 10, rest=.12, taper=.2, flutter=.8, folds=3, fold_amp=.015), m['clothDark'], (0, .42, -.17))
    # Long silver beard spilling from the shadowed face.
    for x, ln in ((0, .42), (-.05, .34), (.05, .34), (-.025, .38), (.025, .38), (-.07, .26), (.07, .26)):
        add(hd, taper_tube([Vector((x, .04, .1)), Vector((x * 1.3, -.08, .15)), Vector((x * 1.1, -.22, .16)), Vector((x * .6, -ln + .1, .14))],
                           lambda u: .045 * (1 - u) ** .8 + .004, 24, 10), m['hair'])
    add(hd, sphere(.075, 20, 12), m['hair'], (0, .07, .11), s=(1.4, .45, .6))
    # Shoulder mantle with a gold hem.
    add(ch, lathe([(.13, .47), (.27, .41), (.36, .3), (.37, .22), (.35, .2)], 56), m['clothDark'], s=(1, 1, .88))
    add(ch, torus(.36, .012, 8, 64), m['trim'], (0, .21, 0), (PI / 2, 0, 0), (1, .88, 1))
    # Potion vials on the belt.
    for x, liquid in ((-.17, m['vialA']), (.15, m['vialB'])):
        vial = hp.child((x, -.04, .17), (0, 0, x * .6))
        add(vial, sphere(.045, 18, 12), m['glass'])
        add(vial, cylinder(.014, .02, .05, 14), m['glass'], (0, .055, 0))
        add(vial, sphere(.036, 16, 10), liquid, (0, -.006, 0))
        add(vial, cylinder(.013, .013, .02, 10), m['wood'], (0, .088, 0))
    # A spellbook drifting beside the off hand (its own bone).
    rig.joint('root', 'bk', (.62, 1.45, .2))
    book = rig.j['bk'].child((0, 0, 0), (-.5, 0, .25))
    add(book, rbox(.3, .05, .38, .012), m['leather'])
    add(book, rbox(.28, .042, .36, .006), m['paper'], (.012, 0, 0))
    for x, z in ((-.13, -.17), (-.13, .17), (.13, -.17), (.13, .17)):
        add(book, rbox(.05, .056, .05, .008), m['trim'], (x, 0, z))
    add(book, circle(.08, 6), m['glow'], (0, .027, 0), (-PI / 2, 0, 0))
    boot(rig, m, False)


def tomoe_crest():
    """The ronin's mon (crescent ring over three commas) as flat geometry, radius ~.1."""
    k = .11 / 128
    g = Geo()
    g.extend(ring_extrude([(math.cos(a / 64 * TAU) * 117 * k, math.sin(a / 64 * TAU) * 117 * k) for a in range(64)],
                          [(math.cos(a / 64 * TAU) * 107 * k, math.sin(a / 64 * TAU) * 107 * k) for a in range(64)], .003, 0.0005, .0005, 1, 64))
    for i in range(3):
        rot = Matrix.Rotation(-i * TAU / 3, 4, 'Z')
        head = [(math.cos(a / 24 * TAU) * 26 * k, (40 + math.sin(a / 24 * TAU) * 26) * k) for a in range(24)]
        tail = Shape().move(26 * k, 40 * k).quad(40 * k, -10 * k, -10 * k, -30 * k).quad(14 * k, 6 * k, -26 * k, 40 * k).closed()
        for pts in (head, tail):
            g.extend(extrude(pts, .003, 0, 0).transform(rot))
    return g


def ronin(rig, m):
    j = rig.j
    hp, sp, ch, hd, nk = j['hp'], j['sp'], j['ch'], j['hd'], j['nk']

    def pleat(points):
        g = lathe(points, 72)
        for v in g.v:
            a = math.atan2(v.x, v.z)
            k = 1 + .07 * math.cos(a * 9)
            v.x *= k
            v.z *= k
        return g
    # Hakama: pleated, flared per leg so lunges read clearly.
    for s in 'RL':
        add(j['t' + s], pleat([(.13, .06), (.17, -.15), (.2, -.46)]), m['clothDark'])
        add(j['k' + s], pleat([(.19, .04), (.23, -.2), (.27, -.38), (.26, -.4)]), m['clothDark'])
    add(hp, pleat([(.22, .1), (.26, -.06), (.3, -.16)]), m['clothDark'])
    # Obi with a knot at the back, saya on the left hip.
    add(hp, torus(.21, .055, 14, 48), m['cloth'], (0, .08, 0), (PI / 2, 0, 0), (1, .82, 1.2))
    add(hp, torus(.214, .008, 8, 48), m['trim'], (0, .08, 0), (PI / 2, 0, 0), (1, .82, 1))
    add(hp, sphere(.06, 20, 14), m['cloth'], (0, .08, -.19), s=(1.6, .9, .7))
    saya = hp.child((.25, .06, .05), (-1.95, .12, .1))
    add(saya, cylinder(.024, .03, .95, 16), m['lacquer'], (0, .5, 0), s=(1, 1, .55))
    add(saya, torus(.032, .006, 8, 20), m['gold'], (0, .05, 0), (PI / 2, 0, 0))
    add(saya, cone(.026, .05, 16), m['gold'], (0, .995, 0), (PI, 0, 0), (1, 1, .55))
    # The sake gourd hangs on the belt (gb) or sits in the off hand (gh); the runtime shows one.
    def gourd(node):
        add(node, sphere(.07, 20, 14), m['wood'], (0, -.07, 0))
        add(node, sphere(.05, 20, 14), m['wood'], (0, .02, 0))
        add(node, cylinder(.015, .02, .05, 10), m['cloth'], (0, .08, 0))
        add(node, torus(.04, .006, 6, 18), m['trim'], (0, -.025, 0), (PI / 2, 0, 0))
    gourd(rig.joint('hp', 'gb', (-.24, .02, .06)))
    gourd(rig.joint('wL', 'gh', (0, -.08, .07)).child((0, 0, 0), (1.5, 0, 0)))
    # Sheathed katana hilt at the saya mouth (sh): shown while the blade is put away.
    hilt = rig.joint('hp', 'sh', (.25, .06, .05)).child((0, 0, 0), (-1.95, .12, .1))
    add(hilt, cylinder(.045, .045, .012, 32), m['gold'], (0, -.02, 0))
    add(hilt, torus(.036, .004, 6, 28), m['dark'], (0, -.027, 0), (PI / 2, 0, 0))
    add(hilt, cylinder(.022, .026, .28, 14, rings=4), m['leather'], (0, -.17, 0))
    for i in range(5):
        add(hilt, octa(.02), m['trim'], (0, -.06 - i * .055, 0), (0, PI / 2, 0), (1.2, 1, .5))
    add(hilt, cylinder(.028, .025, .02, 14), m['gold'], (0, -.315, 0))
    # Kimono top with crossed collar and wide sleeves.
    add(sp, lathe([(.18, -.06), (.2, .1), (.21, .32)], 40), m['clothDark'], s=(1, 1, .85))
    add(ch, lathe([(.2, -.04), (.25, .1), (.29, .24), (.27, .34), (.15, .42)], 48), m['cloth'], s=(1, 1, .8))
    for d in (-1, 1):
        add(ch, rbox(.06, .5, .02, .008), m['trim'], (d * .06, .2, .2), (-.12, 0, d * .42))
    add(ch, torus(.12, .025, 10, 32), m['clothDark'], (0, .41, 0), (PI / 2, 0, 0))
    for s in 'RL':
        shoulder, elbow = j['s' + s], j['e' + s]
        add(shoulder, sphere(.11, 22, 14), m['cloth'], (0, -.02, 0))
        add(shoulder, lathe([(.1, 0), (.14, -.2), (.16, -.36)], 32), m['cloth'])
        add(elbow, lathe([(.07, 0), (.075, -.24)], 24), m['skin'])
        add(elbow, lathe([(.08, -.1), (.088, -.26)], 24), m['dark'])
        add(shoulder, drape(.22, .34, 2, 6, rest=.5, facing=1, flutter=.6, thick=.005), m['cloth'], (0, -.3, -.05))
        for i in range(4):
            add(elbow, torus(.086, .01, 8, 24), m['leather'], (0, -.11 - i * .045, 0), (PI / 2 + (.12 if i % 2 else -.12), 0, 0))
    # Masked face, glowing eyes, kasa hat with straw and a chin cord.
    add(hd, sphere(.13, 28, 18), m['skin'], (0, .1, .01), s=(1, 1.12, 1))
    add(hd, sphere(.135, 28, 12, TAU, PI / 2), m['clothDark'], (0, .07, .012), (PI, 0, 0), (1, .9, 1.02))
    for x in (-.048, .048):
        add(hd, capsule(.011, .03, 4, 10), m['eye'], (x, .12, .118), (0, 0, PI / 2 + (-.2 if x > 0 else .2)))
    add(hd, lathe([(.0, .44), (.08, .41), (.3, .3), (.52, .17), (.56, .145), (.55, .135), (.3, .27), (.08, .38), (0, .4)], 96), m['straw'], (0, -.05, 0))
    add(hd, torus(.545, .008, 8, 96), m['trim'], (0, .093, 0), (PI / 2, 0, 0))
    add(hd, octa(.03), m['wood'], (0, .395, 0), s=(1, .6, 1))
    add(hd, torus(.15, .006, 8, 32, PI), m['cloth'], (0, .12, 0), (0, PI / 2, PI))
    # Katana: curved lofted blade, luminous hamon, tsuba and wrapped tsuka.
    w = j['wp']
    add(w, katana_loft(1.0, .062, .07), m['steel'], (0, 0, .12))
    pts = [Vector((0, .07 * (i / 14) ** 2 - .2 * .062 * (1 - .22 * i / 14) + .0018 * math.sin(i * 2.3), .12 + .95 * i / 14)) for i in range(15)]
    hamon = taper_tube(pts, lambda u: .0038, 64, 8)
    for v in hamon.v:  # flatten onto both faces of the blade, following its taper
        v.x *= 1.75 * (1 - .3 * max(0, min(1, (v.z - .12))))
    add(w, hamon, m['glow'])
    add(w, cylinder(.065, .065, .014, 32), m['gold'], (0, 0, .1), (PI / 2, 0, 0), (1, 1, .8))
    add(w, torus(.05, .004, 6, 32), m['dark'], (0, 0, .108), (0, 0, 0), (1, .8, 1))
    add(w, cylinder(.023, .027, .3, 14), m['leather'], (0, 0, -.04), (PI / 2, 0, 0))
    for i in range(5):
        add(w, octa(.02), m['trim'], (0, 0, -.16 + i * .055), s=(1.2, .5, 1))
    add(w, cylinder(.028, .025, .02, 14), m['gold'], (0, 0, -.195), (PI / 2, 0, 0))
    # Long trailing scarf (glowing silk).
    add(nk, drape(.13, 1.45, 1, 18, rest=.7, taper=.25, flutter=1.4, stiff=.7, wind=.25, thick=.004), m['scarf'], (.04, .02, -.12))
    # Wakizashi beside the katana's saya.
    short = hp.child((.23, .0, .1), (-1.75, .25, .18))
    add(short, cylinder(.022, .026, .55, 16), m['lacquer'], (0, .3, 0), s=(1, 1, .55))
    add(short, cylinder(.036, .036, .01, 22), m['gold'], (0, -.01, 0))
    add(short, cylinder(.02, .023, .18, 12), m['leather'], (0, -.1, 0))
    # Prayer beads, crest on the back, tassels.
    for i in range(18):
        a = i / 18 * TAU
        add(ch, sphere(.018, 12, 8), m['wood'] if i % 6 else m['trim'], (math.sin(a) * .16, .4 - (math.cos(a) * .5 + .5) * .06, math.cos(a) * .14))
    add(ch, tomoe_crest(), m['mon'], (0, .24, -.228), (-.08, PI, 0))
    for x in (.1, .15):
        add(hp, drape(.05, .32, 1, 6, rest=-.05, facing=-1, flutter=.9, seed=x * 40, thick=.004), m['cloth'], (x, .04, .2))
    boot(rig, m, False, ronin=True)


# ---------------------------------------------------------------- poses

STANCE = {
    'knight': dict(h=(0, -.05, 0), hp=(0, .15, 0), sp=(.04, 0, 0), ch=(.06, -.15, 0), nk=(0, 0, 0), hd=(-.04, 0, 0), sR=(-.45, 0, -.25), eR=(-1.0, 0, 0), wR=(.55, 0, 0),
                   sL=(-.7, 0, .2), eL=(-1.1, 0, 0), wL=(1.75, 0, 0), fR=(-.18, .08, -.26), fL=(.16, .08, .28)),
    'ronin': dict(h=(0, -.14, -.02), hp=(0, .35, 0), sp=(.1, 0, 0), ch=(.08, -.25, 0), nk=(0, 0, 0), hd=(-.08, .15, 0), sR=(-.5, 0, -.18), eR=(-.45, 0, 0), wR=(1.25, 0, 0),
                  sL=(-.35, 0, .15), eL=(-1.3, 0, 0), wL=(0, 0, 0), fR=(-.2, .08, -.36), fL=(.18, .08, .36)),
    'mage': dict(h=(0, 0, 0), hp=(0, .1, 0), sp=(0, 0, 0), ch=(0, -.1, 0), nk=(0, 0, 0), hd=(0, .05, 0), sR=(-.3, 0, -.3), eR=(-1.25, 0, 0), wR=(0, 0, 0),
                 sL=(-.2, 0, .25), eL=(-.7, 0, 0), wL=(0, 0, 0), fR=(-.14, .08, -.08), fL=(.14, .08, .12)),
}
ARM = ('hp', 'sp', 'ch', 'nk', 'hd', 'sR', 'eR', 'wR', 'sL', 'eL', 'wL')


def pose(character, t=0.0, seed=0.0):
    """Stance + idle breathing (motion.ts fighterPose before the battle starts).
    Returns {joint: (translation, rotation, order)} in each joint's parent frame."""
    st = STANCE[character]
    w = TAU / 3  # loopable 3 s breath cycle (web: 2.1 rad/s)
    b = math.sin(t * w + seed)
    h = Vector(st['h'])
    h.y += b * .012
    J = {k: list(st[k]) for k in ARM}
    J['ch'][0] += b * .025
    J['hd'][0] -= b * .02
    J['sR'][0] += math.sin(t * w + seed + .6) * .03
    J['sL'][0] += math.sin(t * w + seed + 1.6) * .03
    root_y = .06 + math.sin(t * w + seed) * .04 if character == 'mage' else 0.0
    out = {'root': (Vector((0, root_y, 0)), Matrix.Identity(4))}
    for k in ARM:
        out[k] = (h.copy() if k == 'hp' else Vector((0, 0, 0)), euler(J[k]))
    # Leg IK (scene.ts apply): feet are planted in root space.
    hpM = Matrix.Translation(Vector((0, HIP, 0)) + h) @ euler(J['hp'])
    inv = hpM.inverted()
    for s, x in (('R', -.13), ('L', .13)):
        d = inv @ Vector(st['f' + s]) - Vector((x, -.04, 0))
        phi = math.atan2(d.x, -d.y)
        dy, dz = -math.hypot(d.x, d.y), d.z
        ln = max(.15, min(THIGH + SHIN - .002, math.hypot(dy, dz)))
        knee = PI - math.acos(max(-1, min(1, (THIGH ** 2 + SHIN ** 2 - ln ** 2) / (2 * THIGH * SHIN))))
        alpha = math.atan2(dz, -dy)
        beta = math.acos(max(-1, min(1, (THIGH ** 2 + ln ** 2 - SHIN ** 2) / (2 * THIGH * ln))))
        out['t' + s] = (Vector((0, 0, 0)), euler((-(alpha + beta), 0, phi), 'ZYX'))
        out['k' + s] = (Vector((0, 0, 0)), euler((knee, 0, 0)))
        out['a' + s] = (Vector((0, 0, 0)), euler((alpha + beta - knee - J['hp'][0], -J['hp'][1] * .6, -phi)))
    if character == 'mage':  # the book bobs and turns
        out['bk'] = (Vector((math.sin(t * w) * .05, math.sin(t * w * 2) * .07, 0)), euler((math.sin(t * w) * .08, t * w * .0, 0)))
    return out
