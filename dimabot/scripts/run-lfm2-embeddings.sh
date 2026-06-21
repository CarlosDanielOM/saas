#!/bin/sh
# Startup script for the lfm2.5-embeddings FastAPI server.
# Pre-downloads the GGUF model into a persistent volume (HuggingFace
# hub cache) so subsequent restarts are fast. Then launches the
# server in OpenAI-compatible mode.

set -eu

MODEL_ID="${LFM2_MODEL_ID:-LiquidAI/LFM2.5-Embedding-350M-GGUF}"
HF_CACHE="${HF_HOME:-/data/hf-cache}"
HOST="${LFM2_HTTP_HOST:-0.0.0.0}"
PORT="${LFM2_HTTP_PORT:-8080}"

mkdir -p "$HF_CACHE"

# Pre-download the model so the first HTTP request doesn't pay the
# download cost. The model is ~380MB on disk.
echo "[lfm2-embeddings] Ensuring model $MODEL_ID is cached in $HF_CACHE ..."
python3 -c "
import os
from huggingface_hub import snapshot_download
path = snapshot_download(
    repo_id='$MODEL_ID',
    cache_dir='$HF_CACHE',
    allow_patterns=['*.safetensors', '*.json', '*.txt', 'tokenizer*', '*.py', '*.md', '*.jinja'],
)
print('Model cached at:', path)
"

echo "[lfm2-embeddings] Starting FastAPI server on $HOST:$PORT"
cd /app
exec python3 -m uvicorn lfm2_embeddings_server:app \
    --host "$HOST" \
    --port "$PORT" \
    --workers 1 \
    --log-level info \
    --no-access-log
