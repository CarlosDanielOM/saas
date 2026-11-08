#!/usr/bin/env python3
"""Two-model adapter for the frozen tuning experiment engine."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path

ENGINE_PATH = Path(__file__).resolve().parent.parent / 'tuning' / 'experiment.py'
MODELS = ['typesafe/jev-1.13', 'openai/gpt-6-luna-decisions']
spec = importlib.util.spec_from_file_location('real_chat_tuning_engine', ENGINE_PATH)
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)
_original_prepare = e.prepare


def prepare(plan_path):
    previous_models = e.MODELS
    e.MODELS = MODELS[:]
    try:
        prepared = _original_prepare(plan_path)
    finally:
        e.MODELS = previous_models
    meta, files = prepared[5], prepared[6]
    files['real_chat_driver'] = Path(__file__).resolve()
    files['tuning_contracts'] = ENGINE_PATH.parent / 'contracts.py'
    for name in ('real_chat_driver', 'tuning_contracts'):
        meta['source_hashes'][name] = e.sha(files[name])
    return prepared


@contextmanager
def configured():
    """Temporarily scope the engine to the authorized model list and driver."""
    models, original = e.MODELS, e.prepare
    e.MODELS, e.prepare = MODELS[:], prepare
    try:
        yield
    finally:
        e.MODELS, e.prepare = models, original


def main():
    with configured():
        e.main()


if __name__ == '__main__':
    main()
