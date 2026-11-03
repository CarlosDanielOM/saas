"""Bake the procedural Blender materials into PBR textures and export browser-ready GLBs.

    blender -b duel.blend -P bake_web.py -- [--size 2048]

Run build_duel.py first (it writes duel.blend and the cloth manifest). This script never
saves duel.blend; it only writes dimasite/public/assets/duel3d:

    duel_{knight,mage,ronin}.glb    one skinned mesh + armature (body bones + cloth chains), one baked
                                    material with AO/roughness/metal + normal maps (+ glass for the
                                    mage's vials, + the mage's rune band on its own UV set). Color and
                                    emission are per palette, so they are not embedded.
    duel_arena.glb                  floor (top-down bake), static set (atlas), banner cloth, runes, shards
    textures/{char}_{L,R,E}_base.webp / _emit.webp   palette variants (violet / amber / crimson)

Then run ./optimize.sh to compress the GLBs (meshopt).
"""
import math
import os
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SIZE = int(argv[argv.index('--size') + 1]) if '--size' in argv else 2048
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'public', 'assets', 'duel3d'))
TEX = os.path.join(OUT, 'textures')
os.makedirs(TEX, exist_ok=True)
EMAX = 8.0  # emission is stored as color * strength / EMAX; the GLB sets emissive strength EMAX
t0 = time.time()


def log(*a):
    print(f'[bake {time.time() - t0:6.1f}s]', *a, flush=True)


scene = bpy.context.scene
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
for backend in ('OPTIX', 'CUDA'):
    try:
        prefs.compute_device_type = backend
        prefs.get_devices()
        if any(d.type == backend for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = 'GPU'
            break
    except TypeError:
        continue
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.render.bake.margin = 16
scene.render.bake.margin_type = 'EXTEND'
scene.frame_set(0)

CLOTH = {'L': '#3b2a7a', 'R': '#8a4220', 'E': '#6b1424'}


def lin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in c] + [1.0]


# ---------------------------------------------------------------- material channel plumbing

def src(inp):
    return ('link', inp.links[0].from_socket) if inp.is_linked else ('val', inp.default_value)


def channels(mat):
    """Where each PBR channel comes from in one of our procedural materials."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    surf = out.inputs['Surface'].links[0].from_node if out.inputs['Surface'].is_linked else None
    if surf is not None and surf.type == 'BSDF_PRINCIPLED':
        p = surf
        return dict(base=src(p.inputs['Base Color']), rough=src(p.inputs['Roughness']), metal=src(p.inputs['Metallic']),
                    ecol=src(p.inputs['Emission Color']), estr=src(p.inputs['Emission Strength']))
    em = next((n for n in nt.nodes if n.type == 'EMISSION'), None)
    pal = mat.name.rsplit('_', 1)[-1]
    base = lin(CLOTH[pal]) if pal in CLOTH else [0, 0, 0, 1]  # hem runes sit on the robe
    return dict(base=('val', base), rough=('val', .82), metal=('val', 0.0),
                ecol=src(em.inputs['Color']) if em else ('val', (0, 0, 0, 1)), estr=src(em.inputs['Strength']) if em else ('val', 0.0))


def prepare(mat):
    """Explicit UVMap for procedural coords; an Emission probe and a bake image node."""
    nt = mat.node_tree
    if mat.get('_prepared'):
        return
    for tc in [n for n in nt.nodes if n.type == 'TEX_COORD']:
        uvo = tc.outputs['UV']
        if uvo.is_linked:
            uvn = nt.nodes.new('ShaderNodeUVMap')
            uvn.uv_map = 'UVMap'
            for lk in list(uvo.links):
                nt.links.new(uvn.outputs['UV'], lk.to_socket)
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    probe = nt.nodes.new('ShaderNodeEmission')
    probe.name = '_probe'
    mul = nt.nodes.new('ShaderNodeMath')
    mul.name = '_estr'
    mul.operation = 'MULTIPLY'
    img = nt.nodes.new('ShaderNodeTexImage')
    img.name = '_bake'
    uvb = nt.nodes.new('ShaderNodeUVMap')
    uvb.uv_map = 'BakeUV'
    nt.links.new(uvb.outputs['UV'], img.inputs['Vector'])
    orig = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
    PREP[mat.name] = dict(out=out, orig=orig, probe=probe, mul=mul, img=img, ch=channels(mat))
    mat['_prepared'] = 1


PREP = {}


def feed(sock, s):
    nt = sock.node.id_data
    for lk in list(sock.links):
        nt.links.remove(lk)
    if s[0] == 'link':
        nt.links.new(s[1], sock)
    else:
        v = s[1]
        if sock.type == 'RGBA':
            sock.default_value = tuple(v)[:4] if hasattr(v, '__len__') else (v, v, v, 1)
        else:
            sock.default_value = v if not hasattr(v, '__len__') else v[0]


def route(mat, channel):
    """Point the material output at one channel (None = original shader)."""
    P = PREP[mat.name]
    nt = mat.node_tree
    surf = P['out'].inputs['Surface']
    for lk in list(surf.links):
        nt.links.remove(lk)
    if channel is None:
        if P['orig'] is not None:
            nt.links.new(P['orig'], surf)
        return
    probe, mul, ch = P['probe'], P['mul'], P['ch']
    if channel == 'emit':
        feed(probe.inputs['Color'], ch['ecol'])
        feed(mul.inputs[0], ch['estr'])
        mul.inputs[1].default_value = 1 / EMAX
        nt.links.new(mul.outputs[0], probe.inputs['Strength'])
    else:
        feed(probe.inputs['Color'], ch[channel])
        for lk in list(probe.inputs['Strength'].links):
            nt.links.remove(lk)
        probe.inputs['Strength'].default_value = 1.0
    nt.links.new(probe.outputs[0], surf)


def bake(objs, kind, channel, size, samples=8):
    img = bpy.data.images.new(f'_bake_{kind}_{channel}', size, size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    mats = {m for o in objs for m in o.data.materials}
    for m in mats:
        route(m, channel if kind == 'EMIT' else None)
        n = PREP[m.name]['img']
        n.image = img
        m.node_tree.nodes.active = n
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    scene.cycles.samples = samples
    kw = {'normal_space': 'TANGENT'} if kind == 'NORMAL' else {}
    bpy.ops.object.bake(type=kind, use_clear=True, margin=16, margin_type='EXTEND', **kw)
    px = np.empty(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(size, size, 4)


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= .0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - .055)


def save(arr, path, quality=90):
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(arr[..., :3], 0, 1)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP' if path.endswith('.webp') else 'PNG'
    scene.render.image_settings.quality = quality
    try:
        img.save(quality=quality)
    except TypeError:
        img.save()
    return img


def down(a, f):
    return a.reshape(a.shape[0] // f, f, a.shape[1] // f, f, -1).mean(axis=(1, 3))


# ---------------------------------------------------------------- shared helpers

def isolate(keep):
    for o in scene.objects:
        o.hide_render = o not in keep


def smart_uv(objs, margin=.003):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_viewport = False
        o.hide_set(False)
        o.data.uv_layers.new(name='BakeUV')
        o.data.uv_layers['BakeUV'].active = True
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=.6, correct_aspect=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def web_material(name, base_img, orm_img, normal_img, emit_img=None):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    p = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(p.outputs[0], out.inputs['Surface'])

    def tex(img, noncolor):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        img.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
        return n
    if base_img is not None:
        nt.links.new(tex(base_img, False).outputs['Color'], p.inputs['Base Color'])
    orm = tex(orm_img, True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
    grp = bpy.data.node_groups.get('glTF Material Output')
    if grp is None:
        grp = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        grp.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    g = nt.nodes.new('ShaderNodeGroup')
    g.node_tree = grp
    nt.links.new(sep.outputs['Red'], g.inputs['Occlusion'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex(normal_img, True).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    if emit_img is not None:
        nt.links.new(tex(emit_img, False).outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = EMAX
    return m


def finalize_uv(o):
    uvs = o.data.uv_layers
    if 'UVMap' in uvs:
        uvs.remove(uvs['UVMap'])
    uvs['BakeUV'].name = 'UVMap'
    uvs['UVMap'].active = uvs['UVMap'].active_render = True


def export(path, objs, attributes=False):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.hide_viewport = False
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_apply=True, export_yup=True, export_skins=True,
                              export_animations=False, export_rest_position_armature=True, export_image_format='WEBP',
                              export_attributes=attributes, export_extras=False)
    log('exported', os.path.relpath(path, HERE), f'{os.path.getsize(path) / 1e6:.2f} MB')


def rune_material():
    """Placeholder for the scrolling rune band: an emissive texture read through RuneUV, so the
    exporter writes that UV set (TEXCOORD_1). The runtime replaces the material."""
    m = bpy.data.materials.new('runes')
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    p = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(p.outputs[0], out.inputs['Surface'])
    img = bpy.data.images.get('_runes') or bpy.data.images.new('_runes', 4, 4)
    img.pixels.foreach_set([1.0] * 64)
    img.filepath_raw = os.path.join(TEX, '_runes.png')
    img.file_format = 'PNG'
    img.save()
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = img
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = 'RuneUV'
    nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
    nt.links.new(t.outputs['Color'], p.inputs['Emission Color'])
    p.inputs['Emission Strength'].default_value = 1.0
    return m


# ---------------------------------------------------------------- fighters

PALS = 'LRE'
for key in ('knight_L', 'mage_R', 'ronin_R'):
    char = key.split('_')[0]
    ao, me = bpy.data.objects[f'{key}_rig'], bpy.data.objects[key]
    ao.matrix_world = ao.matrix_world.Identity(4)
    ao.data.pose_position = 'REST'
    isolate({ao, me})
    for m in me.data.materials:
        prepare(m)
    smart_uv([me])
    me.data.uv_layers['BakeUV'].active_render = True
    log(f'{char}: uv done ({len(me.data.vertices)} verts)')
    slots = [m.name for m in me.data.materials]
    nrm = bake([me], 'NORMAL', None, SIZE)
    ao_px = bake([me], 'AO', None, SIZE // 2, samples=48)
    rough = bake([me], 'EMIT', 'rough', SIZE // 2, 4)
    metal = bake([me], 'EMIT', 'metal', SIZE // 2, 4)
    orm = np.stack([ao_px[..., 0], rough[..., 0], metal[..., 0]], -1)
    files = {}
    files['normal'] = save(nrm, os.path.join(TEX, f'{char}_normal.webp'))
    files['orm'] = save(orm, os.path.join(TEX, f'{char}_orm.webp'))
    for P in PALS:  # palette variants: swap the palette materials, rebake color + emission
        for i, nm in enumerate(slots):
            stem, _, suf = nm.rpartition('_')
            if suf in PALS and stem and bpy.data.materials.get(f'{stem}_{P}'):
                alt = bpy.data.materials[f'{stem}_{P}']
                prepare(alt)
                me.data.materials[i] = alt
        base = bake([me], 'EMIT', 'base', SIZE, 4)
        emit = bake([me], 'EMIT', 'emit', SIZE, 4)
        files[f'base_{P}'] = save(srgb(base), os.path.join(TEX, f'{char}_{P}_base.webp'))
        files[f'emit_{P}'] = save(srgb(emit), os.path.join(TEX, f'{char}_{P}_emit.webp'))
        log(f'{char}: palette {P} baked')
    # Color and emission are swapped per palette at runtime, so only the shared maps are embedded.
    body = web_material(f'{char}_body', None, files['orm'], files['normal'])
    glass = bpy.data.materials.get('glass')
    names = [m.name for m in me.data.materials]
    idx = [0] * len(me.data.polygons)
    me.data.polygons.foreach_get('material_index', idx)
    slots = [body] + ([glass] if 'glass' in names else [])
    if any(n.startswith('runes_') for n in names):
        # The mage's glyph band scrolls at runtime: its own material on the original lathe UVs.
        uvs = me.data.uv_layers
        uvs.active = uvs['UVMap']
        uvs.new(name='RuneUV')
        slots.append(rune_material())
    remap = [slots.index(glass) if n == 'glass' else len(slots) - 1 if n.startswith('runes_') else 0 for n in names]
    me.data.materials.clear()
    for m in slots:
        me.data.materials.append(m)
    me.data.polygons.foreach_set('material_index', [remap[i] for i in idx])
    finalize_uv(me)
    ao.data.pose_position = 'POSE'
    export(os.path.join(OUT, f'duel_{char}.glb'), [ao, me])

# ---------------------------------------------------------------- arena

for o in scene.objects:
    o.hide_render = True
floor = bpy.data.objects['Arena_Floor']
static = [bpy.data.objects[n] for n in ('Arena_Platform', 'Arena_Gate', 'Arena_Pillars', 'Arena_Braziers', 'Arena_Banners', 'Arena_Shards', 'Arena_BannerCloth')]
runes = bpy.data.objects['Arena_Runes']
isolate(set(static) | {floor})
for o in static + [floor]:
    for m in o.data.materials:
        prepare(m)
# Floor: top-down planar UVs (the platform is a 9.32 m disc).
uv = floor.data.uv_layers.new(name='BakeUV')
uv.active = uv.active_render = True
co = np.empty(len(floor.data.vertices) * 3, dtype=np.float32)
floor.data.vertices.foreach_get('co', co)
co = co.reshape(-1, 3)
li = np.empty(len(floor.data.loops), dtype=np.int32)
floor.data.loops.foreach_get('vertex_index', li)
uvs = np.stack([co[li, 0] / 9.5 + .5, co[li, 1] / 9.5 + .5], -1)
uv.data.foreach_set('uv', uvs.ravel())
fn = bake([floor], 'NORMAL', None, SIZE)
fa = bake([floor], 'AO', None, SIZE // 2, samples=48)
fr = bake([floor], 'EMIT', 'rough', SIZE // 2, 4)
fm = bake([floor], 'EMIT', 'metal', SIZE // 2, 4)
fb = bake([floor], 'EMIT', 'base', SIZE, 4)
floor_mat = web_material('floor', save(srgb(fb), os.path.join(TEX, 'floor_base.webp')),
                         save(np.stack([fa[..., 0], fr[..., 0], fm[..., 0]], -1), os.path.join(TEX, 'floor_orm.webp')),
                         save(fn, os.path.join(TEX, 'floor_normal.webp')))
floor.data.materials.clear()
floor.data.materials.append(floor_mat)
finalize_uv(floor)
log('arena floor baked')
# Static set: one shared atlas. Cut the platform's huge rings into 16 wedges first, or their
# islands come out as giant hollow circles that waste most of the atlas.
import bmesh  # noqa: E402
plat = bpy.data.objects['Arena_Platform']
bm = bmesh.new()
bm.from_mesh(plat.data)
cut = []
for e in bm.edges:
    a, b = e.verts
    if a.co.xy.length < .5 or b.co.xy.length < .5:
        continue
    ang = [math.atan2(v.co.y, v.co.x) for v in (a, b)]
    if all(abs(((x / (math.pi / 8)) + .5) % 1 - .5) < 1e-3 for x in ang) and abs(ang[0] - ang[1]) < 1e-3:
        cut.append(e)
bmesh.ops.split_edges(bm, edges=cut)
bm.to_mesh(plat.data)
bm.free()
log(f'platform split along {len(cut)} radial edges')
smart_uv(static, .002)
for o in static:
    o.data.uv_layers['BakeUV'].active_render = True
sn = bake(static, 'NORMAL', None, SIZE)
sa = bake(static, 'AO', None, SIZE // 2, samples=48)
sr = bake(static, 'EMIT', 'rough', SIZE // 2, 4)
sm = bake(static, 'EMIT', 'metal', SIZE // 2, 4)
sb = bake(static, 'EMIT', 'base', SIZE, 4)
se = bake(static, 'EMIT', 'emit', SIZE, 4)
arena_mat = web_material('arena', save(srgb(sb), os.path.join(TEX, 'arena_base.webp')),
                         save(np.stack([sa[..., 0], sr[..., 0], sm[..., 0]], -1), os.path.join(TEX, 'arena_orm.webp')),
                         save(sn, os.path.join(TEX, 'arena_normal.webp')), save(srgb(se), os.path.join(TEX, 'arena_emit.webp')))
for o in static:
    o.data.materials.clear()
    o.data.materials.append(arena_mat)
    o.data.polygons.foreach_set('material_index', [0] * len(o.data.polygons))
    finalize_uv(o)
log('arena atlas baked')
export(os.path.join(OUT, 'duel_arena.glb'), [floor, runes] + static, attributes=True)
for o in [floor, runes] + static:
    print('  ', o.name, sum(len(p.vertices) - 2 for p in o.data.polygons), 'tris')
for f in os.listdir(TEX):
    if f.startswith('_'):
        os.remove(os.path.join(TEX, f))
log('done')
