#!/usr/bin/env bash
# Compress the exported GLBs in place (meshopt geometry compression + quantization).
# three's GLTFLoader decodes them with MeshoptDecoder. Run after bake_web.py.
set -euo pipefail
cd "$(dirname "$0")/../../public/assets/duel3d"
for f in duel_*.glb; do
  npx -y @gltf-transform/cli@4.5.1 meshopt "$f" "$f" --level medium >/dev/null
  printf '%-18s %6s KB\n' "$f" "$(( $(stat -c%s "$f") / 1024 ))"
done
# Only the palette textures are loaded separately; the rest are embedded in the GLBs.
rm -f textures/arena_*.webp textures/floor_*.webp textures/*_normal.webp textures/*_orm.webp
du -sh textures
