# Duel 3D assets (Blender)

Source for the extreme-quality duel's fighters (Knight, Mage, Ronin) and moon-gate arena.
The runtime is `src/app/features/widgets/duel/quality-extreme/`; the outputs are in
`public/assets/duel3d/` and are committed.

## Rebuild

Requires Blender 5.x (Cycles; a GPU makes the bake about 2 min) and Node (for `npx`).

    cd dimasite/tools/duel-blender
    blender -b --factory-startup -P build_duel.py -- --no-render   # scene + cloth.json (about 2 s)
    blender -b duel.blend -P bake_web.py                           # bake textures, export GLBs (about 2 min)
    ./optimize.sh                                                  # meshopt compression, prune loose textures

`duel.blend` and `renders/` stay local (git-ignored). To render stills, drop `--no-render`
(`--shots duel,lineup,arena,knight,mage,ronin`, `--samples N`, `--scale F`, `--eevee`).

| File | What |
|---|---|
| `duel_geo.py` | three.js-style primitives (lathe, taper tube, extrude, rounded box…) authored in three space, converted to Blender Z-up |
| `duel_fighters.py` | fighters: joint tree, parts, cloth drape, stance poses + leg IK |
| `duel_arena.py` | arena: platform, flagstones, rune inlays, gate, pillars, banners, braziers, shards |
| `duel_materials.py` | procedural materials + sky world |
| `build_duel.py` | meshes, armatures, lights, compositor, shots, `cloth.json` |
| `bake_web.py` | bakes materials to PBR textures and exports the GLBs |
| `optimize.sh` | compresses the GLBs (EXT_meshopt_compression + quantization) |

## What the runtime expects

Fighters (`duel_{knight,mage,ronin}.glb`): one skinned mesh on an armature whose bones use the
duel's joint names: `root hp sp ch nk hd sR eR wR sL eL wL tR kR aR tL kL aL wp`, plus

- `bk` (mage spellbook) and `o0 o1 o2` (mage orbs, children of `wp`): moved every frame;
- `gb` / `gh` (ronin gourd on the belt / in the off hand) and `sh` (ronin sheathed hilt):
  shown or hidden by the pose (the runtime collapses a hidden bone to a point);
- `wp` itself is hidden while the ronin's katana is sheathed;
- `cl*` cloth chains, described in `cloth.json` (parent joint, chains, drape parameters and the
  rest wind the strip was draped with).

Joint bones must sit where the runtime joints are at rest (`duel-claude-3d-rig.ts`,
`skeleton()`); props carrying a rotation keep it on a child node so the bone itself is
unrotated. The runtime re-parents each bone under its joint at load, using the exported rest
pose (not the inverse bind matrices, which quantization rescales).

Materials: the body material embeds only the shared AO/roughness/metal (ORM) and normal maps.
Color and emission are loaded per palette from `textures/{char}_{L,R,E}_{base,emit}.webp`
(L violet left, R amber right, E crimson enraged). The mage also has `glass` (vials) and
`runes` (hem band, on a second UV set so the runtime can scroll it).

Arena (`duel_arena.glb`): one atlas material for the static set; `Arena_Floor` (its ORM feeds
the mirror's relief); `Arena_Runes` (lit at runtime by the rune floor's color and pulses);
`Arena_BannerCloth` with `_sway`/`_seed` attributes and `Arena_Shards` with `_cx _cy _cz _si`
(center and index), both animated in vertex shaders; `Arena_Gate` turns about (0, 3.7, -4.6).
The sky, corona, flames, mist, light shafts and motes are runtime shaders.

## Budget

About 1 MB per fighter GLB, 1.9 MB for the arena and 0.4 MB per palette texture pair. An OBS
overlay is transparent, so it never loads the arena: a duel downloads two fighters and their
palettes (about 3 MB, cached for the page's lifetime; the overlay preloads the fighters when the
channel uses the extreme tier).
