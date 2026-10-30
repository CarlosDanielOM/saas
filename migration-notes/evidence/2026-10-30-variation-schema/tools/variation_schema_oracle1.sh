#!/bin/sh
set -eu
if [ "$#" -ne 4 ]; then
  echo "usage: variation_schema_oracle1.sh SOURCE_ROOT NODE_EXECUTABLE OUTPUT_DIR --write|--check" >&2
  exit 64
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/freeze_variation_schema.py" --source-root "$1" --node "$2" --output-dir "$3" "$4"
