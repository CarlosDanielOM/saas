set -eu
node --experimental-vm-modules tests/fixtures/fish_catalog_reference.mjs --write /artifacts/fish-catalog
node --experimental-vm-modules tests/fixtures/fish_catalog_reference.mjs --check /artifacts/fish-catalog
node --experimental-vm-modules tests/fixtures/fish_catalog_benchmark.mjs /artifacts/fish-catalog/fish-catalog-reference.json /artifacts/fish-catalog
