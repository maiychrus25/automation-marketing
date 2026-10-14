#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MaiHub bridge: CLI + MCP stdio server cho giao thức điều khiển MaiHub.

Chỉ dùng thư viện chuẩn, tương thích Python >= 3.6.
Cấu hình: MAIHUB_URL, MAIHUB_API_KEY, MAIHUB_CERT_SHA256 (biến môi trường hoặc --env-file).
"""
from __future__ import print_function

import argparse
import hashlib
import hmac
import io
import http.client
import json
import os
import re
import socket
import ssl
import sys
import urllib.parse
import uuid

VERSION = "1.0.0"
MCP_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"]
DEFAULT_TIMEOUT = 30
UPLOAD_TOOL = "maihub_upload_media"
# Đúng các đuôi MaiHub nhận (mediaRules): kiểu nội dung cố định, không phụ thuộc mimetypes của hệ điều hành.
MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}
CONFIRM_GUIDANCE = "Hãy hỏi người dùng xác nhận rồi gọi lại với confirm: true"
DESTRUCTIVE_NOTE = "Cần confirm: true (hỏi người dùng trước)"

EXIT_SERVER_ERROR = 1
EXIT_CONFIG = 2
EXIT_NETWORK = 3


class BridgeError(Exception):
    """Lỗi từ MaiHub (mã của máy chủ) hoặc lỗi cục bộ (CONFIG, UNREACHABLE, PIN_MISMATCH, BAD_RESPONSE)."""

    def __init__(self, code, message, details=None, status=None):
        Exception.__init__(self, "%s: %s" % (code, message))
        self.code = code
        self.message = message
        self.details = details
        self.status = status


def normalize_fingerprint(value):
    """Chấp nhận có/không dấu hai chấm, chữ hoa/thường; trả hex thường 64 ký tự."""
    text = re.sub(r"[:\s]", "", value or "").lower()
    if not re.match(r"^[0-9a-f]{64}$", text):
        raise BridgeError("CONFIG", "MAIHUB_CERT_SHA256 phải là SHA-256 dạng hex (64 ký tự)")
    return text


def parse_env_file(path):
    values = {}
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, _, val = line.partition("=")
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            values[key.strip()] = val
    return values


def mask_key(key):
    if not key:
        return "(chưa đặt)"
    return key[:3] + "…" + "*" * 6 if len(key) > 8 else "*" * 6


class Config(object):
    def __init__(self, url, api_key, pin):
        self.url = url
        self.api_key = api_key
        self.pin = pin

    @classmethod
    def load(cls, env_file=None, environ=None):
        env = dict(os.environ if environ is None else environ)
        if env_file:
            try:
                env.update(parse_env_file(env_file))
            except (IOError, OSError) as err:
                raise BridgeError("CONFIG", "Không đọc được --env-file: %s" % err)
        missing = [k for k in ("MAIHUB_URL", "MAIHUB_API_KEY", "MAIHUB_CERT_SHA256") if not env.get(k)]
        if missing:
            raise BridgeError("CONFIG", "Thiếu cấu hình: %s" % ", ".join(missing))
        return cls(env["MAIHUB_URL"].strip(), env["MAIHUB_API_KEY"].strip(), normalize_fingerprint(env["MAIHUB_CERT_SHA256"]))

    def host_port(self):
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise BridgeError("CONFIG", "MAIHUB_URL phải có dạng https://host:port")
        return parsed.hostname, parsed.port or 443


class MaiHubClient(object):
    def __init__(self, config, timeout=DEFAULT_TIMEOUT):
        self.config = config
        self.timeout = timeout

    def _connect(self, timeout):
        host, port = self.config.host_port()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        if hasattr(ctx, "minimum_version"):  # Python >= 3.7
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        else:
            ctx.options |= ssl.OP_NO_TLSv1 | ssl.OP_NO_TLSv1_1
        conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
        try:
            conn.connect()
            der = conn.sock.getpeercert(binary_form=True)
            actual = hashlib.sha256(der or b"").hexdigest()
            if not hmac.compare_digest(actual, self.config.pin):
                raise BridgeError("PIN_MISMATCH", "Chứng chỉ của MaiHub không khớp dấu vân tay đã ghim (nhận %s)" % actual)
        except BridgeError:
            conn.close()
            raise
        except (socket.error, ssl.SSLError, OSError) as err:
            conn.close()
            raise BridgeError("UNREACHABLE", "Không kết nối được MaiHub: %s" % err)
        return conn

    def request(self, method, path, body=None, headers=None, timeout=None):
        """Kết nối và kiểm ghim TRƯỚC, rồi mới gửi tiêu đề có khoá. Trả về (status, đối tượng JSON)."""
        conn = self._connect(timeout or self.timeout)
        try:
            hdrs = {"Authorization": "Bearer " + self.config.api_key}
            hdrs.update(headers or {})
            try:
                conn.request(method, path, body=body, headers=hdrs)
                resp = conn.getresponse()
                raw = resp.read()
            except (socket.error, ssl.SSLError, http.client.HTTPException, OSError) as err:
                raise BridgeError("UNREACHABLE", "Lỗi khi trao đổi với MaiHub: %s" % err)
            try:
                data = json.loads(raw.decode("utf-8"))
            except ValueError:
                raise BridgeError("BAD_RESPONSE", "MaiHub trả về dữ liệu không phải JSON (HTTP %d)" % resp.status, status=resp.status)
            return resp.status, data
        finally:
            conn.close()

    def _unwrap(self, status, data):
        if isinstance(data, dict) and data.get("ok") is True:
            return data.get("result")
        err = data.get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            raise BridgeError(str(err.get("code", "INTERNAL")), str(err.get("message", "")), err.get("details"), status)
        raise BridgeError("BAD_RESPONSE", "Phản hồi không đúng định dạng (HTTP %d)" % status, status=status)

    def health(self):
        return self._unwrap(*self.request("GET", "/v1/health"))

    def describe(self):
        return self._unwrap(*self.request("GET", "/v1/describe"))

    def call(self, method, params=None, idempotency_key=None):
        body = {"method": method, "params": params if params is not None else {}}
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        payload = json.dumps(body).encode("utf-8")
        timeout = self.timeout
        if method == "events.wait":
            timeout = self.timeout + int((params or {}).get("timeoutSec") or 0)
        return self._unwrap(*self.request("POST", "/v1/call", payload, {"Content-Type": "application/json"}, timeout))

    def upload(self, path):
        name = os.path.basename(path)
        ctype = MEDIA_TYPES.get(os.path.splitext(name)[1].lstrip(".").lower())
        if ctype is None:
            raise BridgeError("INVALID_PARAMS", "Chỉ tải được ảnh/video: %s" % ", ".join(sorted(MEDIA_TYPES)))
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            headers = {"Content-Type": ctype, "Content-Length": str(size), "X-Filename": urllib.parse.quote(name, safe="")}
            return self._unwrap(*self.request("POST", "/v1/media", handle, headers, max(self.timeout, 300)))


# ---------------------------------------------------------------- MCP

def tool_name(method_name):
    return "maihub_" + method_name.replace(".", "_")


def build_tools(describe_result):
    tools = []
    for m in describe_result.get("methods", []):
        desc = m.get("description", "")
        if m.get("destructive") or m.get("destructiveWhen"):
            desc = "%s [%s]" % (desc, DESTRUCTIVE_NOTE)
        schema = json.loads(json.dumps(m.get("paramsSchema") or {"type": "object", "properties": {}}))
        schema.setdefault("type", "object")
        props = schema.setdefault("properties", {})
        props["idempotencyKey"] = {"type": "string", "maxLength": 64, "description": "Khoá chống gọi trùng (tuỳ chọn, tối đa 64 ký tự)"}
        tools.append({"name": tool_name(m["name"]), "description": desc, "inputSchema": schema, "_method": m["name"]})
    tools.append({
        "name": UPLOAD_TOOL,
        "description": "Tải một tệp ảnh/video trên máy bot lên MaiHub, trả về mediaId để dùng trong drafts.create/update.",
        "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "Đường dẫn tệp trên máy bot"}}, "required": ["path"]},
        "_method": None,
    })
    return tools


class McpServer(object):
    def __init__(self, client, stdin=None, stdout=None, stderr=None):
        self.client = client
        self.stdin = stdin or sys.stdin
        self.stdout = stdout or sys.stdout
        self.stderr = stderr or sys.stderr
        self._tools = None

    def log(self, text):
        self.stderr.write("[maihub-bridge] %s\n" % text)
        self.stderr.flush()

    def send(self, obj):
        self.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.stdout.flush()

    def tools(self):
        if self._tools is None:
            self._tools = build_tools(self.client.describe())
        return self._tools

    def run(self):
        for line in self.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            if not isinstance(msg, dict):
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
                continue
            try:
                self.handle(msg)
            except Exception as err:  # không để một lỗi làm sập phiên
                self.log("lỗi nội bộ: %r" % (err,))
                if "id" in msg:
                    self.send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": "Internal error"}})

    def reply(self, msg, result):
        self.send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def handle(self, msg):
        method = msg.get("method")
        is_request = "id" in msg
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if method == "initialize":
            wanted = params.get("protocolVersion")
            self.reply(msg, {
                "protocolVersion": wanted if wanted in MCP_VERSIONS else MCP_VERSIONS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "maihub", "version": VERSION},
            })
        elif method == "ping":
            self.reply(msg, {})
        elif method == "tools/list":
            try:
                tools = [dict((k, v) for k, v in t.items() if k != "_method") for t in self.tools()]
            except BridgeError as err:
                self.log("tools/list lỗi: %s" % err)
                self.send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32603, "message": "%s: %s" % (err.code, err.message)}})
                return
            self.reply(msg, {"tools": tools})
        elif method == "tools/call":
            if not is_request:
                return
            self.reply(msg, self.call_tool(params.get("name"), params.get("arguments")))
        elif is_request:
            self.send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found: %s" % method}})
        # thông báo (không có id), gồm notifications/initialized: bỏ qua

    @staticmethod
    def _text(text, is_error=False):
        result = {"content": [{"type": "text", "text": text}]}
        if is_error:
            result["isError"] = True
        return result

    def call_tool(self, name, arguments):
        args = dict(arguments) if isinstance(arguments, dict) else {}
        try:
            if name == UPLOAD_TOOL:
                path = args.get("path")
                if not isinstance(path, str) or not path:
                    raise BridgeError("INVALID_PARAMS", "Thiếu tham số path")
                if not os.path.isfile(path):
                    raise BridgeError("INVALID_PARAMS", "Không thấy tệp: %s" % path)
                result = self.client.upload(path)
            else:
                tool = next((t for t in self.tools() if t["name"] == name), None)
                if tool is None:
                    raise BridgeError("UNKNOWN_METHOD", "Không có tool %s" % name)
                idem = args.pop("idempotencyKey", None)
                if idem is not None and (not isinstance(idem, str) or not idem or len(idem) > 64):
                    raise BridgeError("INVALID_PARAMS", "idempotencyKey phải là chuỗi 1-64 ký tự")
                result = self.client.call(tool["_method"], args, idem)
            return self._text(json.dumps(result, ensure_ascii=False, indent=2))
        except BridgeError as err:
            text = "%s: %s" % (err.code, err.message)
            if err.code == "CONFIRMATION_REQUIRED":
                text += "\n" + CONFIRM_GUIDANCE
            return self._text(text, True)


# ---------------------------------------------------------------- CLI

def utf8_stream(stream, write=False):
    """Bọc luồng nhị phân thành UTF-8, tránh lỗi mã hoá khi locale là ASCII (Python 3.6)."""
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        return stream
    if write:
        return io.TextIOWrapper(buffer, encoding="utf-8", errors="replace", newline="\n", line_buffering=True)
    return io.TextIOWrapper(buffer, encoding="utf-8", errors="replace", newline="\n")


def print_json(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def cmd_doctor(config_loader):
    """Chạy tuần tự các bước; dừng ở bước hỏng đầu tiên."""
    def report(good, label, detail=""):
        print("[%s] %s%s" % ("OK" if good else "LỖI", label, (" - " + detail) if detail else ""))
        return good

    try:
        config = config_loader()
        host, port = config.host_port()
    except BridgeError as err:
        report(False, "Cấu hình", err.message)
        return EXIT_CONFIG
    report(True, "Cấu hình", "url=%s, key=%s, ghim=%s…" % (config.url, mask_key(config.api_key), config.pin[:12]))
    try:
        sock = socket.create_connection((host, port), timeout=10)
        sock.close()
        report(True, "Kết nối TCP", "%s:%d" % (host, port))
    except (socket.error, OSError) as err:
        report(False, "Kết nối TCP", str(err))
        return EXIT_NETWORK
    client = MaiHubClient(config, timeout=15)
    try:
        client._connect(15).close()
        report(True, "Ghim chứng chỉ TLS")
    except BridgeError as err:
        report(False, "Ghim chứng chỉ TLS", err.message)
        return EXIT_NETWORK
    try:
        client.health()
        report(True, "/v1/health")
    except BridgeError as err:
        report(False, "/v1/health", "%s: %s" % (err.code, err.message))
        return EXIT_SERVER_ERROR if err.status else EXIT_NETWORK
    try:
        info = client.describe()
        report(True, "Xác thực khoá (/v1/describe)", "giao thức %s, %d thao tác" % (info.get("protocol"), len(info.get("methods", []))))
    except BridgeError as err:
        report(False, "Xác thực khoá (/v1/describe)", "%s: %s" % (err.code, err.message))
        return EXIT_SERVER_ERROR if err.status else EXIT_NETWORK
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="maihub_bridge.py", description="Cầu nối CLI / MCP tới giao thức điều khiển MaiHub")
    env_help = "Tệp KEY=VALUE chứa MAIHUB_URL, MAIHUB_API_KEY, MAIHUB_CERT_SHA256"
    parser.add_argument("--env-file", help=env_help)
    # Cho phép đặt --env-file sau lệnh con (`mcp --env-file X`); SUPPRESS để giá trị đặt trước lệnh con không bị ghi đè bằng None.
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--env-file", default=argparse.SUPPRESS, help=env_help)
    sub = parser.add_subparsers(dest="command")
    sub.required = True
    sub.add_parser("describe", parents=[shared], help="In danh sách thao tác (GET /v1/describe)")
    p_call = sub.add_parser("call", parents=[shared], help="Gọi một thao tác")
    p_call.add_argument("method")
    p_call.add_argument("params", nargs="?", default="{}", help="Tham số dạng JSON (mặc định {})")
    p_call.add_argument("--idempotency-key", help="Khoá chống gọi trùng")
    p_call.add_argument("--auto-idem", action="store_true", help="Tự sinh khoá chống gọi trùng (uuid4)")
    p_up = sub.add_parser("upload", parents=[shared], help="Tải ảnh/video lên MaiHub")
    p_up.add_argument("path")
    p_wait = sub.add_parser("wait", parents=[shared], help="Chờ sự kiện (events.wait)")
    p_wait.add_argument("--after", type=int, default=0)
    p_wait.add_argument("--timeout", type=int, default=25, help="Giây, tối đa 25")
    sub.add_parser("doctor", parents=[shared], help="Kiểm tra cấu hình, kết nối, ghim chứng chỉ, khoá")
    sub.add_parser("mcp", parents=[shared], help="Chạy MCP server qua stdio")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if argv is None:  # chạy thật (không phải trong test): ép UTF-8 cho stdin/stdout/stderr
        sys.stdin, sys.stdout, sys.stderr = utf8_stream(sys.stdin), utf8_stream(sys.stdout, True), utf8_stream(sys.stderr, True)

    def loader():
        return Config.load(args.env_file)

    if args.command == "doctor":
        return cmd_doctor(loader)
    try:
        client = MaiHubClient(loader())
        if args.command == "describe":
            print_json(client.describe())
        elif args.command == "call":
            try:
                params = json.loads(args.params)
            except ValueError:
                raise BridgeError("INVALID_PARAMS", "Tham số không phải JSON hợp lệ")
            if not isinstance(params, dict):
                raise BridgeError("INVALID_PARAMS", "Tham số phải là một đối tượng JSON")
            idem = args.idempotency_key or (str(uuid.uuid4()) if args.auto_idem else None)
            print_json(client.call(args.method, params, idem))
        elif args.command == "upload":
            if not os.path.isfile(args.path):
                raise BridgeError("INVALID_PARAMS", "Không thấy tệp: %s" % args.path)
            print_json(client.upload(args.path))
        elif args.command == "wait":
            timeout = max(0, min(25, args.timeout))
            print_json(client.call("events.wait", {"after": args.after, "timeoutSec": timeout}))
        elif args.command == "mcp":
            McpServer(client).run()
        return 0
    except BridgeError as err:
        sys.stderr.write("%s: %s\n" % (err.code, err.message))
        if err.details:
            sys.stderr.write(json.dumps(err.details, ensure_ascii=False) + "\n")
        if err.code == "CONFIG":
            return EXIT_CONFIG
        return EXIT_NETWORK if err.code in ("UNREACHABLE", "PIN_MISMATCH", "BAD_RESPONSE") else EXIT_SERVER_ERROR


if __name__ == "__main__":
    sys.exit(main())
