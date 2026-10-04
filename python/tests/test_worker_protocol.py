"""Protocol-level tests for the stdio worker skeleton (no ML weights)."""

import json
import subprocess
import sys
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / "worker.py"


def run_worker(requests: list[dict]) -> list[dict]:
    payload = "\n".join(json.dumps(r) for r in requests) + "\n"
    proc = subprocess.run(
        [sys.executable, str(WORKER)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.strip().splitlines()]


def test_handshake_reports_capabilities():
    (resp,) = run_worker(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "handshake",
                "params": {
                    "protocol_version": 1,
                    "laya_checkpoint": "convaiinnovations/laya-multilingual",
                    "embedding_model": "intfloat/multilingual-e5-small",
                },
            }
        ]
    )
    assert resp["id"] == 1
    assert resp["result"]["protocol_version"] == 1
    assert "classify" in resp["result"]["capabilities"]


def test_unknown_method_returns_jsonrpc_error():
    (resp,) = run_worker([{"jsonrpc": "2.0", "id": 2, "method": "nope"}])
    assert resp["error"]["code"] == -32601


def test_ml_methods_fail_closed_without_weights():
    (resp,) = run_worker(
        [{"jsonrpc": "2.0", "id": 3, "method": "embed", "params": {"texts": ["hi"]}}]
    )
    assert resp["error"]["code"] == -32001
