"""
OpenAI-compatible embedding server for LiquidAI LFM2.5-Embedding-350M-GGUF.

Loads the model via sentence-transformers (which handles the GGUF format
and the asymmetric query:/document: prompt prefix defined in the model's
sentence-transformers config). Exposes a /v1/embeddings endpoint that
matches the OpenAI embeddings API contract so dimabot can swap from
OpenRouter without any change in shape.

Endpoints:
  GET  /health           -> {"status": "ok"}
  GET  /v1/models        -> list of served models
  POST /v1/embeddings    -> OpenAI-compatible embedding request

Request body for /v1/embeddings:
  {
    "input": "text" | ["text1", "text2", ...],
    "model": "lfm2.5-embedding-350m" (optional, default = configured)
  }

The model is tuned for asymmetric prefixes. Callers must send a
"kind" field ("query" or "document") so we apply the correct prefix
from the model's prompts config. The default is "document" to match
the most common ingestion path.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Literal, Union

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# sentence-transformers / huggingface_hub imports happen lazily inside
# the startup event so import errors surface in the container logs.

logging.basicConfig(
    level=os.environ.get("LFM2_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("lfm2-embeddings")

MODEL_ID = os.environ.get("LFM2_MODEL_ID", "LiquidAI/LFM2.5-Embedding-350M")
EXPECTED_DIM = int(os.environ.get("LFM2_EMBED_DIM", "1024"))
SERVED_MODEL_NAME = os.environ.get("LFM2_SERVED_MODEL_NAME", "lfm2.5-embedding-350m")
TRUST_REMOTE_CODE = os.environ.get("LFM2_TRUST_REMOTE_CODE", "1") not in ("0", "false", "False")

app = FastAPI(title="LFM2.5 Embeddings", version="1.0.0")
_model = None  # type: ignore[var-annotated]
_model_lock_reason: str = "not loaded"


class EmbeddingRequest(BaseModel):
    input: Union[str, list[str]] = Field(..., description="Text or list of texts to embed")
    model: str | None = Field(default=None, description="Ignored; served model is fixed")
    encoding_format: Literal["float", "base64"] | None = Field(default=None)
    # dimabot-specific: which prompt prefix to use. The LFM2 model is
    # tuned for asymmetric query:/document: prefixes, so this matters
    # for retrieval accuracy. Default = "document" (ingestion path).
    kind: Literal["query", "document"] = Field(default="document")
    # When true, skip L2 normalization. Default false (we normalize,
    # matching the upstream dense-retrieve.py reference implementation).
    skip_normalize: bool = Field(default=False)


class EmbeddingData(BaseModel):
    object: str = "embedding"
    embedding: list[float]
    index: int


class EmbeddingUsage(BaseModel):
    prompt_tokens: int = 0
    total_tokens: int = 0


class EmbeddingResponse(BaseModel):
    object: str = "list"
    data: list[EmbeddingData]
    model: str
    usage: EmbeddingUsage


def _load_model() -> None:
    """Load the sentence-transformers model once at startup."""
    global _model, _model_lock_reason
    log.info("Loading model %s ...", MODEL_ID)
    t0 = time.perf_counter()
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:
        _model_lock_reason = f"sentence-transformers not installed: {e}"
        log.exception("sentence-transformers import failed")
        return
    try:
        m = SentenceTransformer(MODEL_ID, trust_remote_code=TRUST_REMOTE_CODE)
    except Exception as e:
        _model_lock_reason = f"failed to load {MODEL_ID}: {e}"
        log.exception("Failed to load model")
        return
    # Configure the model for fast CPU inference.
    try:
        # Use 6 threads by default; matches docker resource limit.
        m.encode = _wrap_encode(m)  # type: ignore[method-assign]
    except Exception:
        log.warning("Could not monkey-patch encode(); using default")
    _model = m
    _model_lock_reason = "loaded"
    log.info("Model loaded in %.2fs. dim=%s", time.perf_counter() - t0, EXPECTED_DIM)


def _wrap_encode(model):  # type: ignore[no-untyped-def]
    """Return a wrapped encode that always uses our thread count."""
    import torch  # noqa: F401  (kept for future torch.compile use)

    original = model.encode

    def encode(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("show_progress_bar", False)
        kwargs.setdefault("convert_to_numpy", True)
        kwargs.setdefault("normalize_embeddings", False)
        return original(*args, **kwargs)

    return encode


@app.on_event("startup")
def _startup() -> None:
    _load_model()


@app.get("/health")
def health() -> dict[str, Any]:
    if _model is None:
        raise HTTPException(status_code=503, detail=f"model not ready: {_model_lock_reason}")
    return {"status": "ok"}


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": SERVED_MODEL_NAME,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "LiquidAI",
                "dim": EXPECTED_DIM,
            }
        ],
    }


@app.post("/v1/embeddings", response_model=EmbeddingResponse)
def embed(req: EmbeddingRequest) -> EmbeddingResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail=f"model not ready: {_model_lock_reason}")

    texts: list[str]
    if isinstance(req.input, str):
        texts = [req.input]
    else:
        if len(req.input) == 0:
            raise HTTPException(status_code=400, detail="input must be non-empty")
        texts = list(req.input)

    # Apply the asymmetric prefix defined in the model's sentence-transformers
    # config. prompt_name tells sentence-transformers to use the named
    # prompt template (e.g. "query" -> "query: ", "document" -> "document: ").
    # The model card from Liquid AI requires this for best accuracy.
    prompt_name: str | None = req.kind
    try:
        # sentence-transformers >= 3.0 supports prompt_name
        vecs = _model.encode(  # type: ignore[union-attr]
            texts,
            prompt_name=prompt_name,
        )
    except TypeError:
        # Older sentence-transformers: prepend manually
        prefix = "query: " if req.kind == "query" else "document: "
        vecs = _model.encode([prefix + t for t in texts])  # type: ignore[union-attr]

    arr = np.asarray(vecs, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[1] != EXPECTED_DIM:
        raise HTTPException(
            status_code=500,
            detail=f"unexpected embedding shape {arr.shape}, expected (*, {EXPECTED_DIM})",
        )

    if not req.skip_normalize:
        # L2 normalize each row, matching the reference implementation.
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1.0, norms)
        arr = arr / norms

    data = [
        EmbeddingData(embedding=arr[i].tolist(), index=i)
        for i in range(arr.shape[0])
    ]

    return EmbeddingResponse(
        data=data,
        model=SERVED_MODEL_NAME,
        usage=EmbeddingUsage(
            prompt_tokens=sum(len(t.split()) for t in texts),
            total_tokens=sum(len(t.split()) for t in texts),
        ),
    )
