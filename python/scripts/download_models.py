"""Download the ML checkpoints the worker needs (HF Hub allowlist).

Defaults mirror src/config.ts DEFAULT_CONFIG. The FlashRank reranker is
excluded: flashrank downloads its own ONNX weights lazily on first
Ranker() use, so there is nothing to pre-fetch here.

Approximate sizes (weights only, Sept 2026):
  laya-multilingual (322M params) ~ 1.3 GB
  multilingual-e5-small           ~ 450 MB

Usage:
  python python/scripts/download_models.py [--cache-dir DIR]
                                           [--laya REPO] [--embedding REPO]
"""

from __future__ import annotations

import argparse

from huggingface_hub import snapshot_download

DEFAULT_LAYA_REPO = "convaiinnovations/laya-multilingual"
DEFAULT_EMBEDDING_REPO = "intfloat/multilingual-e5-small"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--laya", default=DEFAULT_LAYA_REPO)
    parser.add_argument("--embedding", default=DEFAULT_EMBEDDING_REPO)
    parser.add_argument("--cache-dir", default=None)
    args = parser.parse_args()

    for repo in (args.laya, args.embedding):
        path = snapshot_download(
            repo_id=repo,
            cache_dir=args.cache_dir,
            allow_patterns=["*.json", "*.safetensors", "*.bin", "*.model", "*.txt"],
        )
        print(f"downloaded {repo} -> {path}")


if __name__ == "__main__":
    main()
