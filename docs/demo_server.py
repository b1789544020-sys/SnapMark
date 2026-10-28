"""Local, deterministic OpenAI-compatible server for the SnapMark demo.

Run with: python docs/demo_server.py
The extension UI, screenshot pipeline, SSE parser, annotations and PNG export
remain real. Only the vision-model responses are deterministic demo fixtures.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OCR = """姓名 | 角色 | 状态
[已遮挡] | 工程师 | 在线
李四 | 设计师 | 离线
王五 | 产品经理 | 在线"""
TRANSLATION = """Name | Role | Status
[Masked] | Engineer | Online
Li Si | Designer | Offline
Wang Wu | Product Manager | Online"""


class DemoHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[SnapMark demo] {fmt % args}")

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/__demo_state":
            self.send_json({"mode": "deterministic local mock", "requests": self.server.demo_requests})
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_json({"error": {"message": "Unknown demo endpoint"}}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 25_000_000:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if self.headers.get("Authorization") != "Bearer demo-local-key":
                self.send_json({"error": {"message": "Use the documented local demo key"}}, 401)
                return
            content = body["messages"][-1]["content"]
            image_url = next(part["image_url"]["url"] for part in content if part.get("type") == "image_url")
            encoded = image_url.split(",", 1)[1]
            image_bytes = base64.b64decode(encoded, validate=True)
            expected_magic = b"\xff\xd8" if body.get("stream") else b"\x89PNG"
            if not image_bytes.startswith(expected_magic):
                raise ValueError("Unexpected image payload from the extension")
            system_prompt = body["messages"][0]["content"]
            if "精准的 OCR 引擎" in system_prompt:
                preset, answer = "ocr", OCR
            elif "专业翻译" in system_prompt:
                preset, answer = "translate", TRANSLATION
            else:
                preset, answer = "connection" if not body.get("stream") else "question", "ok"
            record = {
                "model": body.get("model"),
                "stream": bool(body.get("stream")),
                "preset": preset,
                "image_mime": image_url.split(";", 1)[0].removeprefix("data:"),
                "image_bytes": len(image_bytes),
                "image_sha256": hashlib.sha256(image_bytes).hexdigest(),
                "response": answer,
            }
            self.server.demo_requests.append(record)
            if not body.get("stream"):
                self.send_json({
                    "id": "snapmark-demo-connection", "model": body.get("model"),
                    "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                })
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.end_headers()
            chunks = []
            for line in answer.splitlines(keepends=True):
                chunks.extend(line[i:i + 12] for i in range(0, len(line), 12))
            for chunk in chunks:
                event = {"choices": [{"delta": {"content": chunk}}]}
                self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.07)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
        except (ValueError, KeyError, IndexError, json.JSONDecodeError) as exc:
            self.send_json({"error": {"message": f"Invalid demo request: {exc}"}}, 400)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(DemoHandler, directory=str(ROOT)))
    server.demo_requests = []
    print(f"SnapMark demo: http://127.0.0.1:{args.port}/test-page.html")
    print(f"Mock endpoint: http://127.0.0.1:{args.port}/v1 (key: demo-local-key)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
