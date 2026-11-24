"""JSON-stdin worker for AI-3 isolated HTTP verification. Does not print credentials."""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from ai3_delivery import DeliveryBlocked, DeliveryClient, MemoryTokens


def main():
    config = json.load(sys.stdin)
    url = urlsplit(config["base_url"])
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or not url.port:
        raise ValueError("The verification worker requires an explicit loopback HTTP port")
    queue = Path(config["queue_path"])
    if not queue.is_absolute():
        raise ValueError("Use an absolute path for the disposable verification queue")
    tokens = MemoryTokens(**config["credentials"])
    options = config.get("options", {})
    delays = []
    kwargs = {"max_retries": options.get("max_retries", 8)}
    if options.get("fast_retry", False):
        kwargs.update(sleep=delays.append, random=lambda: 0.5)
    with DeliveryClient(config["base_url"], queue, tokens, **kwargs) as client:
        def execute(operation):
            action = operation["action"]
            session = operation.get("session_id", config.get("session_id"))
            try:
                if action == "enqueue":
                    result = client.enqueue(session, operation["payload"])
                elif action == "drain":
                    result = client.drain(session)
                elif action == "finish":
                    result = client.finish_session(session)
                elif action in ("status", "records"):
                    result = client.records(session)
                elif action == "discard":
                    result = client.discard(session, operation["client_log_id"], operation["reason"])
                else:
                    raise ValueError("Unknown verification action")
                return {"ok": True, "result": result}
            except DeliveryBlocked as error:
                return {"ok": False, "error": {"code": error.code}}

        if config["action"] == "run":
            output = {"ok": True, "results": [execute(op) for op in config["operations"]]}
        else:
            output = execute(config)
    print(json.dumps({**output, "retry_delays": delays}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Library exceptions can contain network diagnostics; verification callers get a safe code.
        print(json.dumps({"ok": False, "error": {"code": "WORKER_FAILED"}}))
        sys.exit(1)
