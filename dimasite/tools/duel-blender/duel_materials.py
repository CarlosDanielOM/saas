"""Materials for the duel rebuild. Colors come straight from the web version
(materials() in duel-claude-3d-rig.ts and buildEnvironment() in the scene); the procedural
detail (weave, straw, grain, mail, hammered steel) replaces its canvas textures."""
import bpy
from duel_geo import hexcol


def lin(h, mul=1.0):
    def c(x):
        return x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4
    r, g, b = hexcol(h) if isinstance(h, str) else h
    return (c(r) * mul, c(g) * mul, c(b) * mul, 1.0)


class MB:
    """Tiny node-graph builder."""

    def __init__(self, name):
        self.m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        self.t = self.m.node_tree
        self.t.nodes.clear()
        self.n = self.t.nodes
        self.out = self.n.new('ShaderNodeOutputMaterial')
        self.x = 0

    def node(self, kind, **inputs):
        nd = self.n.new(kind)
        nd.location = (self.x, 0)
        self.x -= 200
        for k, v in inputs.items():
            if hasattr(nd, k) and not k[0].isupper():
                setattr(nd, k, v)
            else:
                self.set(nd.inputs[k], v)
        return nd

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.t.links.new(v, sock)
        else:
            sock.default_value = v

    def link(self, a, b):
        self.t.links.new(a, b)

    def math(self, op, a, b=0.0, clamp=False):
        nd = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(nd.inputs[0], a)
        self.set(nd.inputs[1], b)
        return nd.outputs[0]

    def coord(self, kind='Generated', scale=1.0):
        tc = self.node('ShaderNodeTexCoord')
        if scale == 1.0:
            return tc.outputs[kind]
        mp = self.node('ShaderNodeVectorMath', operation='SCALE')
        self.link(tc.outputs[kind], mp.inputs[0])
        mp.inputs['Scale'].default_value = scale
        return mp.outputs[0]

    def noise(self, vec, scale, detail=6, rough=.55, dist=0.0):
        nd = self.node('ShaderNodeTexNoise', Scale=scale, Detail=detail, Roughness=rough, Distortion=dist)
        self.link(vec, nd.inputs['Vector'])
        return nd.outputs['Fac']

    def wave(self, vec, scale, direction='X', kind='BANDS', dist=0.0, detail=2.0, profile='SIN'):
        nd = self.node('ShaderNodeTexWave', wave_type=kind, bands_direction=direction, rings_direction='Z' if direction == 'Z' else 'X',
                       wave_profile=profile, Scale=scale, Distortion=dist, Detail=detail)
        self.link(vec, nd.inputs['Vector'])
        return nd.outputs['Fac']

    def voronoi(self, vec, scale, feature='F1', out='Distance'):
        nd = self.node('ShaderNodeTexVoronoi', feature=feature, Scale=scale)
        self.link(vec, nd.inputs['Vector'])
        return nd.outputs[out]

    def ramp(self, fac, stops):
        nd = self.node('ShaderNodeValToRGB')
        self.link(fac, nd.inputs['Fac'])
        el = nd.color_ramp.elements
        while len(el) > len(stops):
            el.remove(el[-1])
        while len(el) < len(stops):
            el.new(0.5)
        for e, (p, col) in zip(el, stops):
            e.position = p
            e.color = col if len(col) == 4 else (*col, 1)
        return nd.outputs['Color']

    def mixcol(self, fac, a, b, blend='MIX'):
        nd = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        self.set(nd.inputs['Factor'], fac)
        self.set(nd.inputs[6], a)
        self.set(nd.inputs[7], b)
        return nd.outputs[2]

    def maprange(self, v, a, b, c=0.0, d=1.0, smooth=False):
        nd = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR', clamp=True)
        self.set(nd.inputs['Value'], v)
        nd.inputs['From Min'].default_value, nd.inputs['From Max'].default_value = a, b
        nd.inputs['To Min'].default_value, nd.inputs['To Max'].default_value = c, d
        return nd.outputs['Result']

    def bump(self, height, strength=.2, dist=.02, normal=None):
        nd = self.node('ShaderNodeBump', Strength=strength, Distance=dist)
        self.link(height, nd.inputs['Height'])
        if normal is not None:
            self.link(normal, nd.inputs['Normal'])
        return nd.outputs['Normal']

    def principled(self, **kw):
        p = self.node('ShaderNodeBsdfPrincipled')
        names = {'color': 'Base Color', 'metal': 'Metallic', 'rough': 'Roughness', 'coat': 'Coat Weight', 'coat_rough': 'Coat Roughness',
                 'sheen': 'Sheen Weight', 'sheen_tint': 'Sheen Tint', 'sheen_rough': 'Sheen Roughness', 'emit': 'Emission Color',
                 'estr': 'Emission Strength', 'trans': 'Transmission Weight', 'ior': 'IOR', 'alpha': 'Alpha', 'normal': 'Normal',
                 'sss': 'Subsurface Weight', 'sss_radius': 'Subsurface Radius', 'film': 'Thin Film Thickness', 'spec': 'Specular IOR Level',
                 'aniso': 'Anisotropic', 'coat_normal': 'Coat Normal'}
        for k, v in kw.items():
            self.set(p.inputs[names[k]], v)
        self.link(p.outputs[0], self.out.inputs['Surface'])
        return p

    def additive(self, color_socket_or_value, strength):
        """Transparent + emission = additive blending (like the web's AdditiveBlending)."""
        tr = self.node('ShaderNodeBsdfTransparent')
        em = self.node('ShaderNodeEmission')
        self.set(em.inputs['Color'], color_socket_or_value)
        self.set(em.inputs['Strength'], strength)
        add = self.node('ShaderNodeAddShader')
        self.link(tr.outputs[0], add.inputs[0])
        self.link(em.outputs[0], add.inputs[1])
        self.link(add.outputs[0], self.out.inputs['Surface'])
        self.m.surface_render_method = 'BLENDED'
        return em


# ---------------------------------------------------------------- fighter materials

TINT = {'L': '#b49cff', 'R': '#ffc06b', 'E': '#ff3a55'}
CLOTH = {'L': ('#3b2a7a', '#1b1638'), 'R': ('#8a4220', '#3b1b10'), 'E': ('#6b1424', '#2d0710')}


def metal(name, color, rough, coat, detail=1.0, engraved=False):
    b = MB(name)
    gen = b.coord('Generated')
    n = b.noise(gen, 90, 8, .6)
    rv = b.maprange(n, .3, .7, rough * .7, rough * 1.35)
    h = b.noise(gen, 260, 4, .5)
    if engraved:  # flowing filigree: distorted rings read as scrolls on steel and gold
        wv = b.wave(gen, 34, 'Z', 'RINGS', dist=9, detail=3)
        h = b.math('ADD', b.math('MULTIPLY', b.maprange(wv, .8, .97, 0, 1), .6), b.math('MULTIPLY', h, .4))
    nrm = b.bump(h, .12 * detail, .003)
    b.principled(color=lin(color), metal=1.0, rough=rv, coat=coat, coat_rough=.12, normal=nrm)
    return b.m


def fabric(name, color, sheen_hex, rough=.82, sheen=1.0, scale=160):
    b = MB(name)
    uv = b.coord('UV')
    wx = b.wave(uv, scale, 'X', profile='SIN')
    wy = b.wave(uv, scale, 'Y', profile='SIN')
    weave = b.math('MAXIMUM', wx, wy)
    big = b.noise(b.coord('Generated'), 6, 3, .5)
    col = b.mixcol(b.maprange(big, .3, .7, 0, .25), lin(color), lin(color, .55))
    nrm = b.bump(weave, .25, .002)
    b.principled(color=col, rough=rough, sheen=sheen, sheen_tint=lin(sheen_hex), sheen_rough=.45, normal=nrm)
    b.m.use_backface_culling = False
    return b.m


def glow(name, hexc, strength, base=None):
    b = MB(name)
    b.principled(color=lin(base or hexc), rough=.3, emit=lin(hexc), estr=strength)
    return b.m


def build_fighter_materials():
    metal('steel', '#a7b0c4', .3, .25, engraved=True)
    metal('gold', '#d9ad62', .26, .4, .7, engraved=True)
    metal('dark', '#262c3d', .38, .2)
    # Riveted mail: tiny voronoi rings.
    b = MB('mail')
    gen = b.coord('Generated')
    v = b.voronoi(gen, 420)
    ring = b.maprange(v, .15, .45, 1, 0, smooth=True)
    b.principled(color=b.mixcol(ring, lin('#2a3042'), lin('#7c859c')), metal=1.0, rough=b.maprange(ring, 0, 1, .5, .26), normal=b.bump(ring, .6, .002))
    b = MB('leather')
    gen = b.coord('Generated')
    n = b.noise(gen, 140, 8, .65)
    b.principled(color=b.mixcol(n, lin('#2c1c17'), lin('#4a3128')), rough=b.maprange(n, 0, 1, .62, .85), normal=b.bump(n, .2, .003))
    b = MB('trim')
    b.principled(color=lin('#d9ad5f'), metal=.6, rough=.42, sheen=.5, sheen_tint=lin('#ffe2a8'))
    b.m.use_backface_culling = False
    b = MB('skin')
    b.principled(color=lin('#d7a98a'), rough=.55, sss=.25, sss_radius=(1.0, .35, .2))
    # Wood: grain along the staff / gourd, distorted bands.
    b = MB('wood')
    uv = b.coord('UV')
    g_ = b.wave(uv, 9, 'Y', dist=7, detail=4)
    col = b.ramp(g_, [(0, lin('#2a1a10')), (.55, lin('#4a3020')), (1, lin('#6a4630'))])
    b.principled(color=col, rough=.66, coat=.15, normal=b.bump(g_, .25, .003))
    b = MB('lacquer')
    b.principled(color=lin('#120d14'), metal=.1, rough=.22, coat=1.0, coat_rough=.03)
    # Straw: radial strands (lathe U) with woven rings (lathe V).
    b = MB('straw')
    uv = b.coord('UV')
    sep = b.node('ShaderNodeSeparateXYZ')
    b.link(uv, sep.inputs[0])
    strands = b.wave(uv, 520, 'X', dist=2.5, detail=2)
    rings = b.wave(uv, 26, 'Y', profile='SAW')
    h = b.math('ADD', b.math('MULTIPLY', strands, .7), b.math('MULTIPLY', b.maprange(rings, .85, 1, 0, 1), .5))
    col = b.ramp(strands, [(0, lin('#7f6237')), (.5, lin('#b89257')), (1, lin('#d8b77a'))])
    b.principled(color=col, rough=.86, sheen=.3, sheen_tint=lin('#f1d9a0'), normal=b.bump(h, .45, .002))
    b.m.use_backface_culling = False
    b = MB('tabi')
    uv = b.coord('UV')
    b.principled(color=lin('#d9d4c8'), rough=.85, normal=b.bump(b.math('MAXIMUM', b.wave(uv, 140, 'X'), b.wave(uv, 140, 'Y')), .15, .002))
    b = MB('hair')
    uv = b.coord('UV')
    s = b.wave(uv, 70, 'Y', dist=1.5, detail=2)
    b.principled(color=b.mixcol(s, lin('#9da1ae'), lin('#e2e4ec')), rough=.5, sheen=.6, sheen_tint=lin('#ffffff'), normal=b.bump(s, .35, .002))
    b = MB('glass')
    b.principled(color=lin('#d8f6ff'), rough=.03, trans=1.0, ior=1.5, alpha=1.0)
    b = MB('shadow')
    b.principled(color=lin('#0d0b16'), rough=.9)
    b = MB('paper')
    gen = b.coord('Generated')
    b.principled(color=b.mixcol(b.noise(gen, 40, 4), lin('#e9dfc8'), lin('#cdbf9f')), rough=.9)
    b = MB('mon')
    b.principled(color=lin('#f0dcb0'), rough=.7)
    glow('vialA', '#7dffc4', 4.0)
    glow('vialB', '#ff7ad9', 4.0)
    # Enraged aura: a column of crimson heat (additive noise).
    b = MB('aura')
    gen = b.coord('Generated')
    sep = b.node('ShaderNodeSeparateXYZ')
    b.link(gen, sep.inputs[0])
    ob = b.node('ShaderNodeTexCoord').outputs['Object']
    stretch = b.node('ShaderNodeVectorMath', operation='MULTIPLY')
    b.link(ob, stretch.inputs[0])
    stretch.inputs[1].default_value = (5.0, 5.0, 1.2)
    f = b.noise(stretch.outputs[0], 1.6, 3, .45, .6)
    fade = b.math('MULTIPLY', b.maprange(sep.outputs[2], 1, .05, 0, 1, True), b.maprange(sep.outputs[2], 0, .1, 0, 1, True))
    lw = b.node('ShaderNodeLayerWeight', Blend=.5)
    soft = b.math('POWER', b.math('SUBTRACT', 1.0, lw.outputs['Facing']), 2.0)
    a = b.math('MULTIPLY', b.math('MULTIPLY', b.maprange(f, .5, .85, 0, 1), fade), soft)
    b.additive(lin('#ff2848'), b.math('MULTIPLY', a, .8))
    for P in 'LRE':
        tint = TINT[P]
        cl, cd = CLOTH[P]
        fabric(f'cloth_{P}', cl, mix_hex(tint, .55))
        fabric(f'clothDark_{P}', cd, mix_hex(tint, .3), rough=.9, sheen=.6)
        glow(f'glow_{P}', tint, 7.0)
        b = MB(f'eye_{P}')
        b.principled(color=(1, 1, 1, 1), emit=lin(mix_hex2(tint, '#ffffff', .45)), estr=16.0)
        b = MB(f'crystal_{P}')
        b.principled(color=lin(tint), rough=.04, trans=.55, ior=1.6, emit=lin(tint), estr=3.0, coat=1.0, film=420.0)
        b = MB(f'scarf_{P}')
        uv = b.coord('UV')
        wv = b.wave(uv, 160, 'X')
        b.principled(color=lin(tint, .5), rough=.6, sheen=1.0, sheen_tint=lin(tint), emit=lin(tint), estr=.9, normal=b.bump(wv, .15, .002))
        b.m.use_backface_culling = False
        # Hem runes: emissive glyph strokes on a scrolling band (runeBand texture).
        b = MB(f'runes_{P}')
        uv = b.coord('UV')
        sep = b.node('ShaderNodeSeparateXYZ')
        b.link(uv, sep.inputs[0])
        u, v = sep.outputs[0], sep.outputs[1]
        cells = b.math('FLOOR', b.math('MULTIPLY', u, 160))
        fu = b.math('FRACT', b.math('MULTIPLY', u, 160))
        rnd = b.node('ShaderNodeTexWhiteNoise', noise_dimensions='1D')
        b.link(cells, rnd.inputs['W'])
        r = rnd.outputs['Value']
        rails = b.math('MAXIMUM', b.maprange(v, .1, .03, 0, 1), b.maprange(v, .9, .97, 0, 1))
        vert = b.math('MULTIPLY', b.maprange(b.math('ABSOLUTE', b.math('SUBTRACT', fu, b.math('MULTIPLY', r, .8))), .09, .05, 0, 1), b.maprange(r, .3, .32, 0, 1))
        hor = b.math('MULTIPLY', b.maprange(b.math('ABSOLUTE', b.math('SUBTRACT', b.math('FRACT', b.math('MULTIPLY', v, 3)), .5)), .12, .06, 0, 1),
                     b.math('MULTIPLY', b.maprange(fu, .15, .2, 0, 1), b.maprange(fu, .85, .8, 0, 1)))
        hor = b.math('MULTIPLY', hor, b.maprange(r, .62, .6, 0, 1))
        glyph = b.math('MULTIPLY', b.math('MAXIMUM', vert, hor), b.maprange(v, .18, .24, 0, 1))
        glyph = b.math('MULTIPLY', glyph, b.maprange(v, .82, .76, 0, 1))
        mask = b.math('MAXIMUM', rails, glyph, True)
        b.additive(lin(mix_hex2(tint, '#ffffff', .25)), b.math('MULTIPLY', mask, 5.0))


def mix_hex(h, k):
    r, g, b = hexcol(h)
    return (r * k, g * k, b * k)


def mix_hex2(a, b, t):
    A, B = hexcol(a), hexcol(b)
    return tuple(x + (y - x) * t for x, y in zip(A, B))


# ---------------------------------------------------------------- arena materials

def build_arena_materials():
    b = MB('stone')
    gen = b.coord('Object', 1.0)
    n = b.noise(gen, 3.5, 8, .62)
    fine = b.noise(gen, 28, 6, .6)
    col = b.ramp(n, [(0, lin('#121828')), (.55, lin('#1a2135')), (1, lin('#2a3149'))])
    b.principled(color=col, metal=.25, rough=b.maprange(fine, .3, .7, .62, .82), normal=b.bump(b.math('ADD', n, b.math('MULTIPLY', fine, .5)), .35, .02))
    b = MB('arena_metal')
    gen = b.coord('Object', 1.0)
    n = b.noise(gen, 12, 6, .6)
    b.principled(color=lin('#2c3350'), metal=.9, rough=b.maprange(n, 0, 1, .25, .42), coat=.4, coat_rough=.1, normal=b.bump(n, .12, .01))
    b = MB('arena_gold')
    b.principled(color=lin('#d7ad66'), metal=1.0, rough=.28, coat=.5)
    glow('glow_violet', '#a990ff', 6.0)
    glow('glow_gold', '#e8c58b', 6.0)
    glow('rune', '#7b63e6', 4.5, base='#1a1530')
    b = MB('eclipse')
    b.principled(color=lin('#020207'), rough=.6, metal=.0, spec=.15)
    b = MB('coals')
    gen = b.coord('Object', 1.0)
    v = b.voronoi(gen, 18)
    b.principled(color=lin('#1a0c06'), rough=.9, emit=b.ramp(v, [(0, lin('#ffb060')), (.5, lin('#ff6a20')), (1, lin('#300800'))]), estr=6.0)
    # Flagstones: per-stone shade (from the 'shade' attribute) + wear, cracks and polish.
    b = MB('flagstone')
    attr = b.node('ShaderNodeAttribute', attribute_name='shade', attribute_type='GEOMETRY')
    shade = attr.outputs['Fac']
    gen = b.coord('Object', 1.0)
    n = b.noise(gen, 2.2, 8, .6)
    fine = b.noise(gen, 40, 6, .65)
    cr = b.voronoi(gen, 6, 'DISTANCE_TO_EDGE')
    crack = b.maprange(b.math('ADD', cr, b.math('MULTIPLY', b.noise(gen, 9, 4), .03)), .0, .012, 1, 0)
    crack = b.math('MULTIPLY', crack, b.maprange(b.noise(gen, 1.3, 2), .55, .62, 0, 1))
    base = b.ramp(shade, [(0, lin('#141a2a')), (.5, lin('#1c2337')), (1, lin('#283048'))])
    base = b.mixcol(b.maprange(n, .3, .7, 0, .35), base, lin('#2d2f4a'))
    base = b.mixcol(b.math('MULTIPLY', crack, .8), base, lin('#06080f'))
    sparkle = b.maprange(fine, .7, .78, 0, 1)
    rough = b.maprange(b.math('ADD', n, b.math('MULTIPLY', sparkle, .3)), .35, .75, .22, .58)
    h = b.math('SUBTRACT', b.math('MULTIPLY', fine, .4), b.math('MULTIPLY', crack, .6))
    b.principled(color=base, metal=.18, rough=rough, normal=b.bump(h, .3, .01))
    b = MB('grout')
    b.principled(color=lin('#05070d'), rough=.95)
    for nm, hexc in (('banner_L', ('#3a2a7c', '#9a85ff')), ('banner_R', ('#7d3d1d', '#ffb26b'))):
        fabric(nm, hexc[0], hexc[1], scale=90)
    # Corona: eclipse halo with fbm rays (coronaMaterial), drawn on a camera-facing plane.
    b = MB('corona')
    gen = b.coord('Generated')
    sep = b.node('ShaderNodeSeparateXYZ')
    b.link(gen, sep.inputs[0])
    px = b.math('MULTIPLY', b.math('SUBTRACT', sep.outputs[0], .5), 2)
    py = b.math('MULTIPLY', b.math('SUBTRACT', sep.outputs[2], .5), 2)
    r = b.math('SQRT', b.math('ADD', b.math('MULTIPLY', px, px), b.math('MULTIPLY', py, py)))
    ang = b.math('ARCTAN2', py, px)
    cmb = b.node('ShaderNodeCombineXYZ')
    b.link(b.math('MULTIPLY', ang, 3.0), cmb.inputs[0])
    b.link(b.math('MULTIPLY', r, 2.0), cmb.inputs[1])
    rays = b.noise(cmb.outputs[0], 1.0, 5, .55)
    halo = b.math('POWER', 2.718, b.math('MULTIPLY', b.math('MAXIMUM', b.math('SUBTRACT', r, .47), 0), b.math('SUBTRACT', b.math('MULTIPLY', rays, 3), 6)))
    halo = b.math('MULTIPLY', halo, b.maprange(r, .45, .475, 0, 1, True))
    rim = b.math('POWER', 2.718, b.math('MULTIPLY', b.math('ABSOLUTE', b.math('SUBTRACT', r, .475)), -120))
    val = b.math('ADD', b.math('MULTIPLY', halo, .55), b.math('MULTIPLY', rim, 1.6))
    val = b.math('MULTIPLY', val, b.maprange(r, .62, .98, 1, 0, True))
    b.additive(lin('#c7a6ff'), b.math('MULTIPLY', val, 2.4))
    # Flames: layered additive teardrops, hot core.
    for nm, hexc in (('flame_violet', '#b08cff'), ('flame_amber', '#ff9a3c')):
        b = MB(nm)
        lw = b.node('ShaderNodeLayerWeight', Blend=.5)
        face = b.math('POWER', b.math('SUBTRACT', 1.0, lw.outputs['Facing']), 1.6)
        gen = b.coord('Generated')
        sep = b.node('ShaderNodeSeparateXYZ')
        b.link(gen, sep.inputs[0])
        n = b.noise(b.coord('Object', 3.0), 1.0, 4, .6, .8)
        hgt = b.maprange(sep.outputs[2], .15, 1.0, 1, 0)
        a = b.math('MULTIPLY', b.math('MULTIPLY', face, hgt), b.maprange(n, .3, .7, .4, 1.4))
        col = b.mixcol(b.maprange(hgt, .4, 1, 0, 1), lin(hexc), lin('#fff2cc'))
        b.additive(col, b.math('MULTIPLY', a, 9.0))
    # Light shafts: soft additive cones fading at both ends with drifting dust.
    for nm, hexc in (('shaft_a', '#8b7ad6'), ('shaft_b', '#c2a8ff')):
        b = MB(nm)
        lw = b.node('ShaderNodeLayerWeight', Blend=.5)
        face = b.math('POWER', b.math('SUBTRACT', 1.0, lw.outputs['Facing']), 2.5)
        gen = b.coord('Generated')
        sep = b.node('ShaderNodeSeparateXYZ')
        b.link(gen, sep.inputs[0])
        z = sep.outputs[2]
        ends = b.math('MULTIPLY', b.maprange(z, 0, .3, 0, 1, True), b.maprange(z, 1, .5, 0, 1, True))
        dust = b.maprange(b.noise(b.coord('Object', 1.0), 2.5, 4), .3, .7, .55, 1)
        b.additive(lin(hexc), b.math('MULTIPLY', b.math('MULTIPLY', b.math('MULTIPLY', face, ends), dust), .045))
    b = MB('mist')
    gen = b.coord('Object', 1.0)
    n = b.math('MULTIPLY', b.noise(gen, .45, 4, .55), b.noise(gen, .8, 3, .5))
    uvg = b.coord('Generated')
    sep = b.node('ShaderNodeSeparateXYZ')
    b.link(uvg, sep.inputs[0])
    edge = b.math('MULTIPLY', b.math('MULTIPLY', b.maprange(sep.outputs[0], 0, .3, 0, 1, True), b.maprange(sep.outputs[0], 1, .7, 0, 1, True)),
                  b.math('MULTIPLY', b.maprange(sep.outputs[2], 0, .35, 0, 1, True), b.maprange(sep.outputs[2], 1, .6, 0, 1, True)))
    a = b.math('MULTIPLY', b.math('MULTIPLY', b.maprange(n, .1, .45, 0, 1), edge), .5)
    tr = b.node('ShaderNodeBsdfTransparent')
    em = b.node('ShaderNodeEmission', Color=lin('#2b2650'), Strength=.6)
    mx = b.node('ShaderNodeMixShader')
    b.link(a, mx.inputs[0])
    b.link(tr.outputs[0], mx.inputs[1])
    b.link(em.outputs[0], mx.inputs[2])
    b.link(mx.outputs[0], b.out.inputs['Surface'])
    b.m.surface_render_method = 'BLENDED'
    for nm, hexc in (('mote_violet', '#c9b8ff'), ('mote_gold', '#ffd9a0')):
        b = MB(nm)
        b.additive(lin(hexc), 1.6)


def build_world(name='DuelSky'):
    """The skyMaterial shader: violet horizon, nebula band, twinkling stars. Lighting rays see
    the HemisphereLight colors instead, so the dark sky still lifts the shadows."""
    w = bpy.data.worlds.get(name) or bpy.data.worlds.new(name)
    t = w.node_tree
    t.nodes.clear()
    b = MB.__new__(MB)
    b.t, b.n, b.x, b.m = t, t.nodes, 0, None
    out = t.nodes.new('ShaderNodeOutputWorld')
    tc = b.node('ShaderNodeTexCoord')
    d = tc.outputs['Generated']
    sep = b.node('ShaderNodeSeparateXYZ')
    b.link(d, sep.inputs[0])
    hgt = sep.outputs[2]
    base = b.mixcol(b.maprange(hgt, -.05, .6, 0, 1, True), lin((.05, .045, .11)), lin((.012, .016, .04)))
    horizon = b.math('POWER', 2.718, b.math('MULTIPLY', b.math('ABSOLUTE', b.math('SUBTRACT', hgt, .06)), -9))
    base = b.mixcol(1.0, base, b.mixcol(b.math('MULTIPLY', horizon, .3), (0, 0, 0, 1), lin((.22, .12, .38)), 'MIX'), 'ADD')
    neb = b.noise(d, 2.2, 7, .6, .4)
    band = b.math('POWER', 2.718, b.math('MULTIPLY', b.math('POWER', b.math('MULTIPLY', b.math('SUBTRACT', hgt, .3), 3.2), 2), -1))
    nebcol = b.mixcol(b.noise(d, 3.6, 4), lin((.18, .08, .32)), lin((.05, .12, .3)))
    k = b.math('MULTIPLY', b.math('MULTIPLY', b.maprange(neb, .45, .75, 0, 1, True), band), .55)
    base = b.mixcol(k, base, nebcol, 'ADD')
    dust = b.math('MULTIPLY', b.maprange(b.noise(d, 5, 6), .55, .8, 0, 1), b.math('MULTIPLY', band, .18))
    base = b.mixcol(dust, base, lin((.5, .28, .2)), 'ADD')
    vor = b.node('ShaderNodeTexVoronoi', Scale=260, Randomness=1.0)
    b.link(d, vor.inputs['Vector'])
    rnd = b.node('ShaderNodeSeparateColor')
    b.link(vor.outputs['Color'], rnd.inputs[0])
    starmask = b.math('MULTIPLY', b.maprange(vor.outputs['Distance'], .09, .0, 0, 1), b.maprange(rnd.outputs[0], .975, .98, 0, 1))
    starmask = b.math('MULTIPLY', starmask, b.maprange(hgt, -.05, .15, 0, 1))
    starmask = b.math('MULTIPLY', starmask, b.maprange(rnd.outputs[1], 0, 1, .4, 2.5))
    sky = b.mixcol(starmask, base, lin((.85, .85, 1.0)), 'ADD')
    bg = b.node('ShaderNodeBackground', Strength=1.0)
    b.link(sky, bg.inputs['Color'])
    hemi_col = b.mixcol(b.maprange(hgt, -.3, .5, 0, 1, True), lin('#1a1730'), lin('#94a3d6'))
    bg2 = b.node('ShaderNodeBackground', Strength=.22)
    b.link(hemi_col, bg2.inputs['Color'])
    lp = b.node('ShaderNodeLightPath')
    mx = b.node('ShaderNodeMixShader')
    b.link(lp.outputs['Is Camera Ray'], mx.inputs[0])
    b.link(bg2.outputs[0], mx.inputs[1])
    b.link(bg.outputs[0], mx.inputs[2])
    b.link(mx.outputs[0], out.inputs['Surface'])
    return w
