"""
OpenCode Memory worker (skeleton, stdio JSONL RPC).

Revised architecture (docs/08 §14): the first option to test is a
child process managed by the plugin speaking JSONL/RPC over
stdin/stdout — no fixed port, no exposed TCP service, lifecycle
bound to the plugin. FastAPI stays only as a dev/diag alternative.

Protocol (v1):
  plugin -> worker: {"jsonrpc":"2.0","id":N,"method":...,"params":{...}}
  worker -> plugin: {"jsonrpc":"2.0","id":N,"result":{...}}
                    {"jsonrpc":"2.0","id":N,"error":{...,"code":...}}
  worker may also emit notifications: {"jsonrpc":"2.0","method":"log",...}

Handshake (first request must be `handshake`):
  -> {"method":"handshake","params":{"protocol_version":1,...}}
  <- {"result":{"protocol_version":1,"capabilities":[...],...}}

Heavy ML deps (laya / sentence-transformers / flashrank) load lazily
inside method handlers so `--help` / handshake shape tests never
require 900MB of weights.
"""

from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = 1
SCHEMA_VERSION = 1

METHODS = ("handshake", "health", "classify", "embed", "rerank")


def _handshake(params: dict) -> dict:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "laya_checkpoint": params.get("laya_checkpoint", ""),
        "embedding_model": params.get("embedding_model", ""),
        "reranker_model": params.get("reranker_model", ""),
        "capabilities": ["classify", "embed", "rerank"],
    }


def _health(_params: dict) -> dict:
    return {"status": "ok", "models_loaded": False}


def _not_loaded(method: str) -> dict:
    return {
        "code": -32001,
        "message": (
            f"method '{method}' requires ML weights; "
            "worker skeleton does not load models yet (slice 2+)"
        ),
    }


def handle_request(req: dict):
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}
    if method not in METHODS:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"unknown method: {method}"},
        }
    if method == "handshake":
        return {"jsonrpc": "2.0", "id": req_id, "result": _handshake(params)}
    if method == "health":
        return {"jsonrpc": "2.0", "id": req_id, "result": _health(params)}
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": _not_loaded(str(method)),
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "message": f"parse error: {exc}"},
                    }
                )
                + "\n"
            )
            sys.stdout.flush()
            continue
        sys.stdout.write(json.dumps(handle_request(req)) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
