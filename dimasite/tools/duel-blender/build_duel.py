"""Rebuild the Claude 3D duel (quality-extreme) in Blender.

    blender -b --factory-startup -P build_duel.py -- [options]

Options:
    --shots duel,lineup,arena,knight,mage,ronin   which stills to render (default: all)
    --samples N        Cycles samples (default 160)
    --scale F          resolution scale (default 1.0 -> 1920x1080 / 1200x1500)
    --eevee            fast EEVEE preview instead of Cycles
    --no-render        build, save .blend and export GLBs only


Outputs: duel.blend and renders/*.png (next to this script, git-ignored), public/assets/duel3d/cloth.json
Then run bake_web.py for the browser assets (baked textures, GLBs).
"""
import math
import os
import sys
import time

import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
for mod in ('duel_geo', 'duel_fighters', 'duel_materials', 'duel_arena'):
    sys.modules.pop(mod, None)
import duel_geo as G  # noqa: E402
import duel_fighters as F  # noqa: E402
import duel_materials as M  # noqa: E402
import duel_arena as A  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


SHOTS = (opt('--shots') or 'duel,lineup,arena,knight,mage,ronin').split(',')
SAMPLES = int(opt('--samples', 160))
SCALE = float(opt('--scale', 1.0))
EEVEE = '--eevee' in argv
RENDER = '--no-render' not in argv

OUT_R = os.path.join(HERE, 'renders')

os.makedirs(OUT_R, exist_ok=True)

t0 = time.time()


def log(*a):
    print(f'[duel {time.time() - t0:6.1f}s]', *a, flush=True)


def bl(x, y, z):
    """three.js point -> blender point."""
    return Vector((x, -z, y))


# ---------------------------------------------------------------- scene reset

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = 'Duel'


def collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or scene.collection).children.link(c)
    return c


# ---------------------------------------------------------------- mesh baking

def make_mesh(name, parts, coll, smooth_angle=50):
    """parts: (geo, material, three-space matrix, weights) -> one multi-material mesh object.
    weights: bone name, per-vertex [{bone: w}], or None."""
    verts, faces, uvs, mi, smooth, shade, mats = [], [], [], [], [], [], []
    groups, attrs = {}, {}
    for geo, mat, Mx, wts in parts:
        W = G.C @ Mx
        base = len(verts)
        verts.extend(W @ v for v in geo.v)
        if mat not in mats:
            mats.append(mat)
        k = mats.index(mat)
        for f, uv in zip(geo.f, geo.uv):
            faces.append([i + base for i in f])
            uvs.extend(uv)
            mi.append(k)
            smooth.append(not geo.flat)
        shade.extend([getattr(geo, 'shade', .5)] * len(geo.v))
        for an, vals in getattr(geo, 'attrs', {}).items():
            attrs.setdefault(an, [0.0] * base).extend(vals)
        for an in attrs:
            attrs[an].extend([0.0] * (len(verts) - len(attrs[an])))
        if isinstance(wts, str):
            groups.setdefault(wts, {}).setdefault(1.0, []).extend(range(base, base + len(geo.v)))
        elif wts is not None:
            for i, d in enumerate(wts):
                for b, w in d.items():
                    if w > 1e-4:
                        groups.setdefault(b, {}).setdefault(round(w, 3), []).append(base + i)
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', [c for uv in uvs for c in uv])
    me.polygons.foreach_set('material_index', mi)
    for m in mats:
        me.materials.append(bpy.data.materials[m])
    if any(s != .5 for s in shade):
        me.attributes.new('shade', 'FLOAT', 'POINT').data.foreach_set('value', shade)
    for an, vals in attrs.items():
        me.attributes.new(an, 'FLOAT', 'POINT').data.foreach_set('value', vals)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', smooth)
    me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    me.update()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    for b, by_w in groups.items():
        vg = ob.vertex_groups.get(b) or ob.vertex_groups.new(name=b)
        for w, idx in by_w.items():
            vg.add(idx, w, 'REPLACE')
    return ob


AXIS = {'up': Matrix.Identity(4), 'down': Matrix.Rotation(math.pi, 4, 'Z'), 'fwd': Matrix.Rotation(math.pi / 2, 4, 'X')}


def collect_parts(rig):
    parts, rest = [], {}

    def walk(node, Mw, bone):
        Mw = Mw @ node.local()
        b = node.joint or bone
        if node.joint:
            rest[node.joint] = (Mw.copy(), node.parent.joint if node.parent and node.parent.joint else _joint_parent(node))
        for geo, mat, L, w in node.parts:
            parts.append((geo, mat, Mw @ L, w if w is not None else b))
        for c in node.children:
            walk(c, Mw, b)
    walk(rig.root, Matrix(), 'root')
    return parts, rest


def _joint_parent(node):
    p = node.parent
    while p is not None and not p.joint:
        p = p.parent
    return p.joint if p else None


def cloth_rig(geo, Mw, parent, tag):
    """Bone chains along a draped strip (1 chain, or 3 side by side for wide cloth) and smooth
    skin weights: the attachment row stays on the parent, each row blends between bone centers."""
    cl = geo.cloth
    rows, cols, n = cl['rows'], cl['cols'], cl['n']
    nch = 3 if cl['width'] > .4 else 1
    K = max(3, min(7, round(cl['length'] / .2)))
    centers = [(ci + .5) / nch for ci in range(nch)]
    chains = []
    xaxis = (Mw.to_3x3() @ Vector((1, 0, 0))).normalized()
    for ci, cu in enumerate(centers):
        c = min(cols, max(0, round(cu * cols)))
        pts = [Mw @ geo.v[round(k / K * rows) * (cols + 1) + c] for k in range(K + 1)]
        chains.append(dict(names=[f'{tag}{ci}_{k}' for k in range(K)], pts=pts, xaxis=xaxis, u=c / cols - .5, parent=parent))
    weights = []
    for i in range(len(geo.v)):
        r, c = divmod(i % n, cols + 1)
        uu, s = c / cols, r / rows * K
        if nch == 1 or uu <= centers[0]:
            cw = [1.0] + [0.0] * (nch - 1)
        elif uu >= centers[-1]:
            cw = [0.0] * (nch - 1) + [1.0]
        else:
            j = int((uu - centers[0]) * nch)
            t = (uu - centers[j]) * nch
            cw = [0.0] * nch
            cw[j], cw[j + 1] = 1 - t, t
        d = {}
        for ci, w in enumerate(cw):
            if w <= 0:
                continue
            nm = chains[ci]['names']
            if s < .5:
                d[parent] = d.get(parent, 0) + w * (1 - 2 * s)
                d[nm[0]] = d.get(nm[0], 0) + w * 2 * s
            elif s >= K - .5:
                d[nm[-1]] = d.get(nm[-1], 0) + w
            else:
                k = int(s - .5)
                t = s - .5 - k
                d[nm[k]] = d.get(nm[k], 0) + w * (1 - t)
                d[nm[k + 1]] = d.get(nm[k + 1], 0) + w * t
        weights.append(d)
    spec = {k: cl[k] for k in ('rest', 'taper', 'facing', 'flutter', 'stiff', 'seed', 'width', 'length')}
    return chains, weights, spec


def build_fighter(character, palette, enraged=False):
    name = f'{character}_{"E" if enraged else palette}'
    coll = collection(f'Fighter_{name}', fighters_coll)
    rig = F.build(character, palette, enraged)
    parts, rest = collect_parts(rig)
    chains, manifest = [], []
    for pi, (geo, mat, Mw, w) in enumerate(parts):
        if getattr(geo, 'cloth', None) and isinstance(w, str):
            ch, weights, spec = cloth_rig(geo, Mw, w, f'cl{len(manifest)}_')
            parts[pi] = (geo, mat, Mw, weights)
            chains += ch
            manifest.append(dict(spec, parent=w, parent_axis=F.JOINT_AXIS[w],
                                 chains=[dict(bones=c['names'], u=c['u']) for c in ch]))
    arm = bpy.data.armatures.new(f'{name}_rig')
    ao = bpy.data.objects.new(f'{name}_rig', arm)
    coll.objects.link(ao)
    ao.show_in_front = True
    arm.display_type = 'STICK'
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.mode_set(mode='EDIT')
    for jn, (Mw, parent) in rest.items():
        eb = arm.edit_bones.new(jn)
        eb.head, eb.tail = (0, 0, 0), (0, F.JOINT_LEN[jn], 0)
        eb.matrix = G.C @ Matrix.Translation(Mw.to_translation()) @ AXIS[F.JOINT_AXIS[jn]]
        if parent:
            eb.parent = arm.edit_bones[parent]
    for c in chains:
        prev = c['parent']
        for k, nm in enumerate(c['names']):
            h, t = G.C @ c['pts'][k], G.C @ c['pts'][k + 1]
            Y = (t - h).normalized()
            X = (G.C.to_3x3() @ c['xaxis'])
            X = (X - Y * X.dot(Y)).normalized()
            Z = X.cross(Y)
            eb = arm.edit_bones.new(nm)
            eb.head, eb.tail = (0, 0, 0), (0, max(.02, (t - h).length), 0)
            mx = Matrix((X, Y, Z)).transposed().to_4x4()
            mx.translation = h
            eb.matrix = mx
            eb.parent = arm.edit_bones[prev]
            prev = nm
    bpy.ops.object.mode_set(mode='OBJECT')
    CLOTH[name] = manifest
    me = make_mesh(name, parts, coll)
    me.parent = ao
    mod = me.modifiers.new('Armature', 'ARMATURE')
    mod.object = ao
    for pb in ao.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    # Idle loop: stance + breathing (90 frames @ 30 fps), sampled with the leg IK solved per key.
    seed = 0 if palette == 'L' else 1.7
    ao.animation_data_create()
    act = bpy.data.actions.new(f'{name}_Idle')
    ao.animation_data.action = act
    for f in range(0, 91, 6):
        apply_pose(ao, F.pose(character, f / 30, seed))
        for pb in ao.pose.bones:
            pb.keyframe_insert('location', frame=f)
            pb.keyframe_insert('rotation_quaternion', frame=f)
    apply_pose(ao, F.pose(character, 0, seed))
    tris = sum(len(p.vertices) - 2 for p in me.data.polygons)
    log(f'{name}: {len(me.data.vertices)} verts, {tris} tris, {len(me.data.materials)} materials, {len(arm.bones)} bones ({len(chains)} cloth chains)')
    return ao, me


def apply_pose(ao, P):
    for jn, (t, R) in P.items():
        pb = ao.pose.bones.get(jn)
        if pb is None:
            continue
        Ax = AXIS[F.JOINT_AXIS[jn]]
        pb.matrix_basis = Ax.inverted() @ Matrix.Translation(t) @ R @ Ax


def place(ao, x=0.0, z=0.0, yaw=0.0, mirror=False, y=0.0):
    """Anchor a fighter like the web stage: three-space position + yaw, optional X mirror."""
    Mt = G.trs((x, y, z), (0, yaw, 0))
    if mirror:
        Mt = Matrix.Diagonal((-1, 1, 1, 1)) @ Mt
    ao.matrix_world = G.C @ Mt @ G.C.inverted()


# ---------------------------------------------------------------- build

log('materials')
M.build_fighter_materials()
M.build_arena_materials()
scene.world = M.build_world()

fighters_coll = collection('Fighters')
CLOTH = {}
rigs = {}
for character, palette, enraged in (('knight', 'L', False), ('ronin', 'R', False), ('mage', 'R', False), ('ronin', 'R', True)):
    ao, me = build_fighter(character, palette, enraged)
    rigs[ao.name.replace('_rig', '')] = (ao, me)

log('arena')
arena_coll = collection('Arena')
fx_coll = collection('Arena_FX', arena_coll)
arena = {}
FX = {'Arena_Corona', 'Arena_Flames', 'Arena_Mist', 'Arena_MistFront', 'Arena_Shafts', 'Arena_Motes'}
for name, parts in A.build().items():
    ob = make_mesh(name, parts, fx_coll if name in FX else arena_coll, smooth_angle=40)
    arena[name] = ob
    if name in FX:  # light-free FX: no shadows, not seen by bounce light
        ob.visible_shadow = False
        ob.visible_diffuse = name in ('Arena_Flames',)
        ob.visible_glossy = name in ('Arena_Flames', 'Arena_Corona', 'Arena_Motes')
        ob.visible_transmission = False
        ob.visible_volume_scatter = False
for nm in ('Arena_Runes',):
    arena[nm].visible_shadow = False
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in arena.values())
log(f'arena: {len(arena)} objects, {tris} tris')

# ---------------------------------------------------------------- lights (scene.ts values, re-balanced for Cycles)

light_coll = collection('Lights')


def light(name, kind, pos, color, power, target=None, **kw):
    ld = bpy.data.lights.new(name, kind)
    ld.color = M.lin(color)[:3]
    ld.energy = power
    for k, v in kw.items():
        setattr(ld, k, v)
    ob = bpy.data.objects.new(name, ld)
    light_coll.objects.link(ob)
    ob.location = bl(*pos)
    if target is not None:
        d = bl(*target) - ob.location
        ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return ob


light('Key', 'SUN', (-3.5, 8.5, 6.5), '#e3e8ff', 2.4, (0, 0, 0), angle=math.radians(3))
for x, col in ((-1, '#a58bff'), (1, '#ffb45c')):
    light(f'Rim_{"L" if x < 0 else "R"}', 'SPOT', (x * 3.2, 4.6, -3.6), col, 2600, (x * 2.3, 1.2, 0), spot_size=1.1, spot_blend=.85, shadow_soft_size=.25)
light('GateGlow', 'POINT', (0, 3.6, -3.2), '#8f6dff', 900, shadow_soft_size=1.2)
light('Fill', 'POINT', (0, 2.4, 7), '#8ca2ff', 500, shadow_soft_size=1.5)
for x, col in ((-1, '#a98aff'), (1, '#ffa04d')):
    light(f'Brazier_{"L" if x < 0 else "R"}', 'POINT', (x * 4.15, 1.5, -1.6), col, 260, shadow_soft_size=.3)

# ---------------------------------------------------------------- render setup

cam_data = bpy.data.cameras.new('Camera')
cam = bpy.data.objects.new('Camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.sensor_fit = 'VERTICAL'
cam_data.clip_end = 150

if EEVEE:
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = 64
    scene.eevee.use_shadows = True
    try:
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
else:
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for backend in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == backend]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == backend
                scene.cycles.device = 'GPU'
                log('cycles on', backend, gpus[0].name)
                break
        except TypeError:
            continue
    c = scene.cycles
    c.samples = SAMPLES
    c.use_adaptive_sampling = True
    c.adaptive_threshold = .015
    c.use_denoising = True
    try:
        c.denoiser = 'OPENIMAGEDENOISE'
        c.denoising_use_gpu = True
    except (AttributeError, TypeError):
        pass
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces = 10, 3, 4
    c.transmission_bounces, c.transparent_max_bounces = 8, 32
    c.sample_clamp_indirect = 8.0
    c.caustics_reflective = c.caustics_refractive = False
    c.use_light_tree = True
scene.render.film_transparent = False
scene.render.image_settings.color_depth = '16'
scene.render.dither_intensity = 1.0
scene.render.use_persistent_data = True
scene.view_settings.view_transform = 'AgX'
for look in ('AgX - Medium High Contrast', 'Medium High Contrast'):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        continue
scene.view_settings.exposure = -.1
scene.render.fps = 30
scene.frame_start, scene.frame_end = 0, 90
scene.frame_set(0)

# Compositor: fog from the mist pass (FogExp2 #070915), bloom, vignette.
vl = scene.view_layers[0]
vl.use_pass_mist = True
scene.world.mist_settings.start = 7
scene.world.mist_settings.depth = 45
scene.world.mist_settings.falloff = 'QUADRATIC'


def compositor():
    ng = bpy.data.node_groups.new('DuelGrade', 'CompositorNodeTree')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    n = ng.nodes
    rl = n.new('CompositorNodeRLayers')
    out = n.new('NodeGroupOutput')
    mix = n.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mul = n.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = .55
    ng.links.new(rl.outputs['Mist'], mul.inputs[0])
    ng.links.new(mul.outputs[0], mix.inputs['Factor'])
    ng.links.new(rl.outputs['Image'], mix.inputs[6])
    mix.inputs[7].default_value = M.lin('#070915')
    glare = n.new('CompositorNodeGlare')
    glare.inputs['Type'].default_value = 'Bloom'
    glare.inputs['Quality'].default_value = 'High'
    glare.inputs['Threshold'].default_value = 1.2
    glare.inputs['Strength'].default_value = .45
    glare.inputs['Size'].default_value = .65
    ng.links.new(mix.outputs[2], glare.inputs['Image'])
    last = glare.outputs[0]
    try:  # vignette: a soft ellipse multiplied in
        em = n.new('CompositorNodeEllipseMask')
        em.inputs['Size'].default_value = (1.25, 1.35)
        blur = n.new('CompositorNodeBlur')
        blur.inputs['Size'].default_value = (400, 400)
        ng.links.new(em.outputs[0], blur.inputs['Image'])
        mr = n.new('ShaderNodeMapRange')
        mr.inputs['To Min'].default_value = .62
        ng.links.new(blur.outputs[0], mr.inputs['Value'])
        vm = n.new('ShaderNodeMix')
        vm.data_type, vm.blend_type = 'RGBA', 'MULTIPLY'
        vm.inputs['Factor'].default_value = 1.0
        ng.links.new(last, vm.inputs[6])
        ng.links.new(mr.outputs[0], vm.inputs[7])
        last = vm.outputs[2]
    except Exception as e:  # noqa: BLE001
        log('vignette skipped:', e)
    ng.links.new(last, out.inputs[0])
    scene.compositing_node_group = ng


try:
    compositor()
except Exception as e:  # noqa: BLE001
    log('compositor setup failed, rendering without post:', e)

# ---------------------------------------------------------------- shots

BASE, FACING = -2.35, 1.0
ALL = list(rigs.values())


def show(names, arena_on=True):
    for key, (ao, me) in rigs.items():
        on = key in names
        ao.hide_render = me.hide_render = not on
        ao.hide_viewport = me.hide_viewport = not on
    for ob in arena.values():
        ob.hide_render = not arena_on


def camera(pos, look, fov, w, h):
    cam.location = bl(*pos)
    cam.rotation_euler = (bl(*look) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.angle_y = math.radians(fov)
    scene.render.resolution_x, scene.render.resolution_y = int(w * SCALE), int(h * SCALE)
    scene.render.resolution_percentage = 100


def shot_duel():
    show({'knight_L', 'ronin_R'})
    place(rigs['knight_L'][0], BASE, 0, FACING)
    place(rigs['ronin_R'][0], BASE, 0, FACING, mirror=True)
    camera((0, 2.15, 8.7), (0, 1.45, 0), 34, 1920, 1080)


def shot_lineup():
    show({'knight_L', 'mage_R', 'ronin_E'})
    place(rigs['knight_L'][0], -2.1, .2, .55)
    place(rigs['mage_R'][0], 0, -.25, .2, y=0)
    place(rigs['ronin_E'][0], -2.1, .2, .35, mirror=True)  # stage mirror: lands at +2.1
    camera((0, 1.85, 7.6), (0, 1.25, 0), 31, 1920, 1080)


def shot_arena():
    show(set())
    camera((0, 4.6, 13.0), (0, 1.4, -1.8), 40, 1920, 1080)


def shot_portrait(key, yaw, mirror=False):
    def run():
        show({key})
        place(rigs[key][0], 0, 0, yaw, mirror=mirror)
        camera((.55, 1.5, 4.9), (0, 1.18, 0), 33, 1200, 1500)
    return run


SHOT_FN = {'duel': shot_duel, 'lineup': shot_lineup, 'arena': shot_arena,
           'knight': shot_portrait('knight_L', .62), 'mage': shot_portrait('mage_R', .35), 'ronin': shot_portrait('ronin_R', .7, True)}

# Default the saved file to the duel framing.
shot_duel()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'duel.blend'), compress=True)
log('saved duel.blend')

# ---------------------------------------------------------------- export

import json  # noqa: E402
ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'public', 'assets', 'duel3d'))
os.makedirs(ASSETS, exist_ok=True)
with open(os.path.join(ASSETS, 'cloth.json'), 'w') as fh:
    json.dump({k.split('_')[0]: v for k, v in CLOTH.items() if k in ('knight_L', 'mage_R', 'ronin_R')}, fh, indent=1)
log('wrote', os.path.relpath(os.path.join(ASSETS, 'cloth.json'), HERE))

# ---------------------------------------------------------------- render

if RENDER:
    for name in SHOTS:
        SHOT_FN[name]()
        scene.frame_set(0)
        scene.render.filepath = os.path.join(OUT_R, f'{name}.png')
        t = time.time()
        bpy.ops.render.render(write_still=True)
        log(f'rendered {name}.png in {time.time() - t:.1f}s')
    shot_duel()
log('done')
