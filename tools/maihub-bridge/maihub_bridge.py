#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MaiHub bridge: CLI + MCP stdio server cho giao thức điều khiển MaiHub.

Chỉ dùng thư viện chuẩn, tương thích Python >= 3.6.
Cấu hình: MAIHUB_URL, MAIHUB_API_KEY, MAIHUB_CERT_SHA256 (biến môi trường hoặc --env-file).
"""
from __future__ import print_function

import argparse
import base64
import binascii
import hashlib
import hmac
import io
import http.client
import json
import os
import pwd
import re
import shlex
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "1.0.0"
MCP_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"]
DEFAULT_TIMEOUT = 30
UPLOAD_TOOL = "maihub_upload_media"
# Đúng các đuôi MaiHub nhận (mediaRules): kiểu nội dung cố định, không phụ thuộc mimetypes của hệ điều hành.
MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav",  # nhạc cho videos.render (musicMediaId)
}
CONFIRM_GUIDANCE = "Hãy hỏi người dùng xác nhận rồi gọi lại với confirm: true"
DESTRUCTIVE_NOTE = "Cần confirm: true (hỏi người dùng trước)"

PAIR_PREFIX = "mhp1."
PAIR_TICKET_RE = re.compile(r"^[A-Za-z0-9_-]{43}\Z")
SYSTEMD_DIR = "/etc/systemd/system"
DEFAULT_INSTALL_ROOT = "/opt/bot/maihub"
BRIDGE_NAME = "maihub_bridge.py"
BACKUP_SUFFIX = ".before-maihub"
RUN_TIMEOUT = 120
WATCH_DRY_RUN_SEC = 5
WATCH_DRY_RUN_SAFETY_SEC = 30
TELEGRAM_CHECK_SEC = 30
TELEGRAM_CHECK_SAFETY_SEC = 45
TELEGRAM_PROXY_FILE = "/opt/bot/telegram-proxy.url"
ENV_READ_LIMIT = 65536
MCP_STDERR_LINES = 5
TIMEOUT_EXIT_CODE = 124  # mã thoát của coreutils timeout khi phải kill tiến trình
WATCH_UNIT_PREFIX = "maihub-watch-"
SERVICE_NAME_RE = re.compile(r"^[A-Za-z0-9@._-]+\Z")
TELEGRAM_BASE = "https://api.telegram.org"
SEND_RETRY_DELAYS = (2, 10, 30)  # giây chờ trước lần thử lại thứ 1, 2, 3
WATCH_WAIT_SEC = 25
WATCH_RETRY_SEC = 15
WATCH_DOWN_ALERT_SEC = 300
WATCH_AUTH_RETRY_SEC = 300
MAX_RETRY_AFTER_SEC = 300
WATCH_MIN_POLL_SEC = 1
MAX_FIELD_CHARS = 200
MAX_LEAD_SAMPLES = 3
LEAD_TEXT_CHARS = 80
VIDEO_ERROR_CHARS = 120
MAX_MESSAGE_CHARS = 3500
MAX_ERROR_LINES = 3
KIND_LABELS = {"join": "Tham gia nhóm", "scan_groups": "Quét nhóm", "collect_comments": "Thu bình luận"}

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


def decode_pairing_code(code):
    """Giải mã mã ghép nối `mhp1.<base64url JSON {u,f,t,n}>` thành dict(url, pin, ticket, name)."""
    def bad(reason):
        return BridgeError("CONFIG", "Mã ghép nối không hợp lệ: %s" % reason)

    text = (code or "").strip()
    if not text.startswith(PAIR_PREFIX):
        raise bad("thiếu tiền tố %s" % PAIR_PREFIX)
    payload = text[len(PAIR_PREFIX):]
    try:
        obj = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
    except (ValueError, binascii.Error):  # UnicodeDecodeError và JSONDecodeError đều là ValueError
        raise bad("không giải mã được")
    if not isinstance(obj, dict):
        raise bad("nội dung không phải đối tượng JSON")
    fields = {}
    for key in ("u", "f", "t", "n"):
        if not isinstance(obj.get(key), str) or not obj[key]:
            raise bad("thiếu trường %s" % key)
        fields[key] = obj[key]
    if not fields["u"].startswith("https://"):
        raise bad("địa chỉ phải là https://")
    if not PAIR_TICKET_RE.match(fields["t"]):
        raise bad("vé sai định dạng")
    try:
        pin = normalize_fingerprint(fields["f"])
    except BridgeError:
        raise bad("dấu vân tay sai định dạng")
    return {"url": fields["u"], "pin": pin, "ticket": fields["t"], "name": fields["n"]}


def _read_regular_text(path, limit):
    """Đọc tối đa limit byte của tệp thường (không theo symlink, không mở FIFO/thiết bị); không phải tệp thường thì trả None."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            return None
        return handle.read(limit).decode("utf-8", errors="replace")


def _merged_env_lines(path, values):
    """Giữ nguyên mọi dòng của tệp cũ; chỉ thay (hoặc nối thêm) các khoá trong values."""
    existing = _read_regular_text(path, 4 * ENV_READ_LIMIT) or ""
    lines, written = [], set()
    for raw in existing.splitlines():
        text = raw.strip()
        if text.startswith("export "):
            text = text[len("export "):]
        key = text.partition("=")[0].strip() if "=" in text and not text.startswith("#") else None
        if key in values:
            if key not in written:
                lines.append("%s=%s" % (key, values[key]))
                written.add(key)
            continue
        lines.append(raw)
    for key, val in values.items():
        if key not in written:
            lines.append("%s=%s" % (key, val))
    return lines


def write_env_file(path, values, uid=None, gid=None):
    """Ghi tệp KEY=VALUE quyền 0600 ngay từ lúc tạo (mkstemp cùng thư mục: tên khó đoán, không theo symlink; rồi os.replace).

    Gộp với tệp cũ: giữ mọi dòng khác (TELEGRAM_PROXY, MAIHUB_NOTIFY_CHAT_ID, ...), chỉ thay các khoá trong values."""
    lines = _merged_env_lines(path, values)
    fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".env.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for line in lines:
                handle.write(line + "\n")
        if uid is not None:
            os.chown(tmp_path, uid, gid if gid is not None else -1)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


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

    def request(self, method, path, body=None, headers=None, timeout=None, auth=True):
        """Kết nối và kiểm ghim TRƯỚC, rồi mới gửi tiêu đề có khoá. Trả về (status, đối tượng JSON).

        auth=False: không gửi Authorization (dùng cho /v1/pair, lúc chưa có khoá)."""
        conn = self._connect(timeout or self.timeout)
        try:
            hdrs = {"Authorization": "Bearer " + self.config.api_key} if auth else {}
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

    def pair(self, ticket):
        payload = json.dumps({"ticket": ticket}).encode("utf-8")
        return self._unwrap(*self.request("POST", "/v1/pair", payload, {"Content-Type": "application/json"}, auth=False))

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
            raise BridgeError("INVALID_PARAMS", "Chỉ tải được ảnh/video/nhạc: %s" % ", ".join(sorted(MEDIA_TYPES)))
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
        "description": "Tải một tệp ảnh/video/nhạc (mp3, m4a, wav) trên máy bot lên MaiHub, trả về mediaId để dùng trong drafts.create/update (ảnh/video) hoặc musicMediaId của videos.render (nhạc).",
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


def exit_code_for(err):
    """In lỗi ra stderr và trả mã thoát tương ứng."""
    sys.stderr.write("%s: %s\n" % (err.code, err.message))
    if err.details:
        sys.stderr.write(json.dumps(err.details, ensure_ascii=False) + "\n")
    if err.code == "CONFIG":
        return EXIT_CONFIG
    return EXIT_NETWORK if err.code in ("UNREACHABLE", "PIN_MISMATCH", "BAD_RESPONSE") else EXIT_SERVER_ERROR


def _unit_environment(text):
    """Gom các dòng Environment= (có hoặc không có dấu nháy, nhiều cặp trên một dòng) thành dict."""
    env = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("Environment="):
            continue
        try:
            items = shlex.split(line[len("Environment="):])
        except ValueError:
            continue
        for item in items:
            key, sep, val = item.partition("=")
            if sep:
                env[key] = val
    return env


def _env_file_has_key(path, key):
    """Chỉ kiểm tra khoá có tồn tại; không giữ hay in giá trị. Chỉ đọc tệp thường, tối đa 64 KiB (tệp do user bot kiểm soát)."""
    text = _read_regular_text(path, ENV_READ_LIMIT)
    for raw in (text or "").splitlines():
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export "):]
        if line.startswith(key + "="):
            return True
    return False


def _is_root_trusted_dir(path):
    """Thư mục thật (không symlink), do root sở hữu, nhóm/người khác không ghi được."""
    info = os.lstat(path)
    return stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022


def _require_safe_dir(path, check_parent=True):
    """Từ chối (CONFIG) khi path là symlink hoặc thư mục cha có sẵn gần nhất không đáng tin; chạy trước mọi thay đổi."""
    if os.path.islink(path):
        raise BridgeError("CONFIG", "Từ chối: %s là symlink" % path)
    if not check_parent:
        return
    parent = os.path.dirname(path)
    while parent and not os.path.lexists(parent) and parent != os.path.dirname(parent):
        parent = os.path.dirname(parent)
    if not _is_root_trusted_dir(parent):
        raise BridgeError("CONFIG", "Từ chối: thư mục cha %s phải do root sở hữu và nhóm/người khác không được ghi" % parent)


def find_ahv_bots(systemd_dir=SYSTEMD_DIR):
    """Các unit bot AHV: có User=, Environment=AHV_BOT_DATA_DIR=<dir> và <dir>/.env chứa TG_TOKEN."""
    bots = []
    try:
        names = sorted(os.listdir(systemd_dir))
    except (IOError, OSError):
        return bots
    for name in names:
        if not name.endswith(".service"):
            continue
        try:
            with open(os.path.join(systemd_dir, name), "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except (IOError, OSError):
            continue
        user = None
        for raw in text.splitlines():
            if raw.strip().startswith("User="):
                user = raw.strip()[len("User="):].strip()
        data_dir = _unit_environment(text).get("AHV_BOT_DATA_DIR")
        if user and data_dir and _env_file_has_key(os.path.join(data_dir, ".env"), "TG_TOKEN"):
            bots.append({"service": name[:-len(".service")], "user": user, "data_dir": data_dir})
    return bots


def infer_cli(bot, explicit=None):
    """--cli thắng; không có thì suy từ User= rồi từ tên service."""
    if explicit:
        return explicit
    by_user = {"claudeproxy": "claude", "codexproxy": "codex"}
    if bot["user"] in by_user:
        return by_user[bot["user"]]
    for cli in ("claude", "codex"):
        if cli in bot["service"]:
            return cli
    raise BridgeError("CONFIG", "Không suy ra được loại CLI của bot %s, hãy truyền --cli claude|codex" % bot["service"])


def install_layout(install_dir, user, uid, gid):
    """Tạo thư mục cài + state/, chép bridge, đặt chủ sở hữu và quyền theo spec 2.5."""
    _require_safe_dir(install_dir)
    _require_safe_dir(os.path.join(install_dir, "state"), check_parent=False)  # cha là install_dir: ngay sau đây chuyển cho root
    os.makedirs(install_dir, exist_ok=True)
    os.chown(install_dir, 0, gid)
    os.chmod(install_dir, 0o750)
    state_dir = os.path.join(install_dir, "state")
    os.makedirs(state_dir, exist_ok=True)
    os.chown(state_dir, uid, gid)
    os.chmod(state_dir, 0o700)
    bridge_path = os.path.join(install_dir, BRIDGE_NAME)
    shutil.copyfile(os.path.abspath(__file__), bridge_path)
    os.chown(bridge_path, 0, gid)
    os.chmod(bridge_path, 0o640)
    return bridge_path


def cli_config_path(cli, home):
    return os.path.join(home, ".claude.json") if cli == "claude" else os.path.join(home, ".codex", "config.toml")


def backup_cli_config(cli, home, install_dir):
    """Sao lưu cấu hình CLI vào <dir>/<tên>.before-maihub, chỉ lần đầu. Trả True nếu vừa sao lưu."""
    src = cli_config_path(cli, home)
    dst = os.path.join(install_dir, os.path.basename(src) + BACKUP_SUFFIX)
    if os.path.lexists(dst) or not os.path.isfile(src):
        return False
    fd = os.open(dst, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as out, open(src, "rb") as source:
        shutil.copyfileobj(source, out)
    return True


def _stderr_tail(result):
    """Vài dòng cuối của stderr đã bắt được (nội dung của lệnh con, không phải của .env), để thấy nguyên nhân."""
    raw = getattr(result, "stderr", None)
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    lines = [l.strip() for l in raw.splitlines() if l.strip()] if isinstance(raw, str) else []
    return ":\n" + "\n".join(clip(l, MAX_FIELD_CHARS) for l in lines[-MCP_STDERR_LINES:]) if lines else ""


def register_mcp(cli, user, bridge_path, env_path, run, home):
    """Gỡ server maihub cũ (bỏ qua lỗi) rồi thêm lại, dưới quyền user, cwd là home."""
    prefix = ["sudo", "-u", user, "-H", cli, "mcp"]
    server = ["python3", "-I", bridge_path, "mcp", "--env-file", env_path]
    remove = prefix + ["remove", "maihub"] + (["-s", "user"] if cli == "claude" else [])
    add = prefix + (["add", "--scope", "user", "maihub", "--"] if cli == "claude" else ["add", "maihub", "--"]) + server
    kwargs = {"cwd": home, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "timeout": RUN_TIMEOUT}
    try:
        run(remove, **kwargs)
    except subprocess.TimeoutExpired:
        pass  # gỡ bản cũ chỉ là dọn dẹp; lệnh add bên dưới mới quyết định thành công
    result = run(add, **kwargs)
    if getattr(result, "returncode", 0) != 0:
        raise BridgeError("CONFIG", "Lệnh đăng ký MCP thất bại (mã %s)%s" % (result.returncode, _stderr_tail(result)))


def _write_paired_env(env_path, values, uid=None, gid=None):
    try:
        write_env_file(env_path, values, uid, gid)
    except (IOError, OSError) as err:
        raise BridgeError(
            "CONFIG",
            "Không ghi được %s: %s. Vé đã bị dùng và MaiHub đã tạo một khoá API; hãy thu hồi khoá đó trong MaiHub rồi tạo mã ghép nối mới." % (env_path, err))


def cmd_install(args, run, geteuid, systemd_dir, getpwnam):
    """pair --install: tìm bot, dựng thư mục, ghép nối, ghi .env, doctor, sao lưu cấu hình, đăng ký MCP."""
    step = "kiểm tra"
    try:
        if geteuid() != 0:
            raise BridgeError("CONFIG", "Cần chạy bằng root")
        info = decode_pairing_code(args.code)
        bots = find_ahv_bots(systemd_dir)
        if args.bot:
            bots = [b for b in bots if b["service"] == args.bot]
            if not bots:
                raise BridgeError("CONFIG", "Không thấy bot %s trong %s" % (args.bot, systemd_dir))
        elif not bots:
            raise BridgeError("CONFIG", "Không tìm thấy bot AHV nào trong %s; chạy lại không có --install để ghi .env vào thư mục tuỳ chọn" % systemd_dir)
        elif len(bots) > 1:
            raise BridgeError("CONFIG", "Có nhiều bot, hãy chọn bằng --bot: %s" % ", ".join(b["service"] for b in bots))
        bot = bots[0]
        cli = infer_cli(bot, args.cli)
        try:
            account = getpwnam(bot["user"])
        except KeyError:
            raise BridgeError("CONFIG", "Không có user %s trên máy" % bot["user"])
        install_dir = os.path.abspath(args.dir or os.path.join(DEFAULT_INSTALL_ROOT, bot["service"]))
        env_path = os.path.join(install_dir, ".env")
        home = account.pw_dir

        step = "tạo thư mục cài"
        bridge_path = install_layout(install_dir, bot["user"], account.pw_uid, account.pw_gid)
        step = "ghép nối (POST /v1/pair)"
        paired = MaiHubClient(Config(info["url"], None, info["pin"])).pair(info["ticket"])
        api_key = paired.get("apiKey") if isinstance(paired, dict) else None
        if not isinstance(api_key, str) or not api_key:
            raise BridgeError("BAD_RESPONSE", "MaiHub không trả về khoá API")
        values = {"MAIHUB_URL": info["url"], "MAIHUB_CERT_SHA256": info["pin"], "MAIHUB_API_KEY": api_key}
        step = "ghi .env"
        _write_paired_env(env_path, values, account.pw_uid, account.pw_gid)
        print("Đã ghép nối bot \"%s\" (khoá %s). Đã ghi %s:" % (info["name"], paired.get("keyName", ""), env_path))
        for key, val in values.items():
            print("%s=%s" % (key, mask_key(val) if key == "MAIHUB_API_KEY" else val))
        step = "doctor"
        doctor = run(["sudo", "-u", bot["user"], "-H", "python3", "-I", bridge_path, "doctor", "--env-file", env_path],
                     cwd=home, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=RUN_TIMEOUT)
        doctor_out = getattr(doctor, "stdout", None)
        if isinstance(doctor_out, str) and doctor_out:
            print(doctor_out.rstrip("\n"))
        if doctor.returncode != 0:
            raise BridgeError("CONFIG", "doctor dưới quyền %s thất bại (mã %s)" % (bot["user"], doctor.returncode))
        step = "sao lưu cấu hình CLI"
        backup_cli_config(cli, home, install_dir)
        step = "đăng ký MCP"
        register_mcp(cli, bot["user"], bridge_path, env_path, run, home)
        watch_unit = None
        if not args.no_watch:
            step = "cài watch"
            watch_unit = install_watch(env_path, os.path.join(bot["data_dir"], ".env"), bot["user"], bot["service"],
                                       os.path.join(install_dir, "state"), run, systemd_dir, getpwnam,
                                       skip_telegram_check=args.skip_telegram_check)
    except BridgeError as err:
        sys.stderr.write("Bước lỗi: %s\n" % step)
        return exit_code_for(err)
    except (IOError, OSError) as err:
        sys.stderr.write("Bước lỗi: %s\n%s\n" % (step, err))
        return EXIT_CONFIG
    except subprocess.TimeoutExpired:
        sys.stderr.write("Bước lỗi: %s\nLệnh chạy quá %d giây\n" % (step, RUN_TIMEOUT))
        return EXIT_NETWORK
    print("")
    print("Tóm tắt: thư mục %s, CLI %s, user %s, doctor OK, MCP \"maihub\" đã đăng ký%s." % (
        install_dir, cli, bot["user"], ", service %s" % os.path.basename(watch_unit) if watch_unit else ""))
    backup = os.path.join(install_dir, os.path.basename(cli_config_path(cli, home)) + BACKUP_SUFFIX)
    if os.path.lexists(backup):
        print("Bản sao lưu cấu hình CLI: %s (lệnh `rm -rf` bên dưới xoá luôn tệp này; chép ra nơi khác nếu muốn giữ)" % backup)
    print("Lệnh gỡ:")
    print("  sudo -u %s -H %s mcp remove maihub%s" % (bot["user"], cli, " -s user" if cli == "claude" else ""))
    if watch_unit:
        print("  sudo systemctl disable --now %s" % os.path.basename(watch_unit))
        print("  sudo rm %s" % shlex.quote(watch_unit))
    print("  sudo rm -rf %s" % shlex.quote(install_dir))
    return 0


def render_watch_unit(name, user, bridge, env_file, notify_env, state_dir):
    """Nội dung unit systemd của watch (spec 4.4). Đường dẫn có khoảng trắng không được hỗ trợ."""
    for value in (bridge, env_file, notify_env, state_dir):
        if re.search(r"\s", value):
            raise BridgeError("CONFIG", "Đường dẫn không được chứa khoảng trắng: %s" % value)
    return "\n".join([
        "[Unit]",
        "Description=MaiHub watch (thông báo Telegram) cho %s.service" % name,
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "User=%s" % user,
        "ExecStart=/usr/bin/python3 -I %s watch --env-file %s --notify-env %s --state %s" % (
            bridge, env_file, notify_env, os.path.join(state_dir, "watch-state.json")),
        "Restart=always",
        "RestartSec=10",
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ReadWritePaths=%s" % state_dir,
        "PrivateTmp=yes",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ])


def _write_unit_atomic(unit_path, text):
    fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(unit_path), prefix=".maihub-watch-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, unit_path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def _warn_missing_telegram_route(env_file):
    """Cảnh báo (không chặn) khi .env MaiHub chưa có tuyến Telegram mà máy có tệp proxy dùng chung của bot."""
    try:
        values = parse_env_file(env_file)
    except (IOError, OSError):
        return
    if not values.get("TELEGRAM_API_BASE") and not values.get("TELEGRAM_PROXY") and os.path.isfile(TELEGRAM_PROXY_FILE):
        sys.stderr.write("CẢNH BÁO: máy này có %s nhưng %s chưa đặt TELEGRAM_API_BASE hoặc TELEGRAM_PROXY; "
                         "nếu api.telegram.org bị chặn thì thông báo sẽ không tới. Thêm một trong hai khoá đó (ví dụ TELEGRAM_PROXY=<nội dung tệp proxy>).\n" % (TELEGRAM_PROXY_FILE, env_file))


def install_watch(env_file, notify_env, user, name, state_dir, run, systemd_dir, getpwnam, skip_telegram_check=False):
    """Kiểm tra, chạy thử watch --dry-run và --check-telegram dưới quyền user, ghi unit rồi bật + khởi động lại service. Trả đường dẫn unit."""
    env_file, notify_env = os.path.abspath(env_file), os.path.abspath(notify_env)
    for path in (env_file, notify_env):
        if not os.path.isfile(path):
            raise BridgeError("CONFIG", "Không thấy tệp %s" % path)
    if not SERVICE_NAME_RE.match(name):
        raise BridgeError("CONFIG", "Tên service không hợp lệ: %s" % name)
    try:
        account = getpwnam(user)
    except KeyError:
        raise BridgeError("CONFIG", "Không có user %s trên máy" % user)
    env_dir = os.path.dirname(env_file)
    local_bridge = os.path.join(env_dir, BRIDGE_NAME)
    bridge = local_bridge if os.path.isfile(local_bridge) else os.path.abspath(__file__)
    state_dir = os.path.abspath(state_dir or os.path.join(env_dir, "state"))
    unit_name = "%s%s.service" % (WATCH_UNIT_PREFIX, name)
    unit_path = os.path.join(systemd_dir, unit_name)
    text = render_watch_unit(name, user, bridge, env_file, notify_env, state_dir)  # kiểm đường dẫn trước khi đụng hệ thống
    _require_safe_dir(env_dir, check_parent=False)
    _require_safe_dir(state_dir)
    _warn_missing_telegram_route(env_file)

    os.makedirs(state_dir, exist_ok=True)
    os.chown(state_dir, account.pw_uid, account.pw_gid)
    os.chmod(state_dir, 0o700)
    # timeout nằm trong argv để chính watch bị kill (kill sudo từ ngoài sẽ bỏ mồ côi tiến trình python)
    dry = ["sudo", "-u", user, "-H", "timeout", str(WATCH_DRY_RUN_SEC), "python3", "-I", bridge, "watch",
           "--env-file", env_file, "--notify-env", notify_env, "--dry-run"]
    result = run(dry, cwd=account.pw_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=WATCH_DRY_RUN_SAFETY_SEC)
    if result.returncode not in (0, TIMEOUT_EXIT_CODE):  # 124: còn chạy đến hết 5 giây = hai tệp .env đọc được và có chat nhận tin (chưa chứng minh MaiHub/Telegram với tới được)
        detail = getattr(result, "stderr", "")
        raise BridgeError("CONFIG", "watch --dry-run dưới quyền %s thất bại (mã %s)%s" % (
            user, result.returncode, ": " + detail.strip() if isinstance(detail, str) and detail.strip() else ""))
    if not skip_telegram_check:
        check = ["sudo", "-u", user, "-H", "timeout", str(TELEGRAM_CHECK_SEC), "python3", "-I", bridge, "watch",
                 "--env-file", env_file, "--notify-env", notify_env, "--check-telegram"]
        result = run(check, cwd=account.pw_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=TELEGRAM_CHECK_SAFETY_SEC)
        if result.returncode != 0:
            detail = getattr(result, "stderr", "")
            raise BridgeError("CONFIG", "Không gọi được Telegram (getMe) dưới quyền %s (mã %s)%s. Đặt TELEGRAM_API_BASE hoặc TELEGRAM_PROXY trong %s, hoặc dùng --skip-telegram-check" % (
                user, result.returncode, ": " + detail.strip() if isinstance(detail, str) and detail.strip() else "", env_file))
    _write_unit_atomic(unit_path, text)
    # enable rồi restart (không dùng enable --now): chạy lại phải áp dụng unit/bridge/khoá mới cho service đang chạy
    for cmd in (["systemctl", "daemon-reload"], ["systemctl", "enable", unit_name], ["systemctl", "restart", unit_name]):
        result = run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=RUN_TIMEOUT)
        if result.returncode != 0:
            raise BridgeError("CONFIG", "%s thất bại (mã %s)" % (" ".join(cmd), result.returncode))
    print("Đã cài service %s (watch gửi thông báo Telegram)." % unit_name)
    return unit_path


def cmd_install_watch(args, run=subprocess.run, geteuid=os.geteuid, systemd_dir=SYSTEMD_DIR, getpwnam=pwd.getpwnam):
    try:
        if geteuid() != 0:
            raise BridgeError("CONFIG", "Cần chạy bằng root")
        install_watch(args.env_file, args.notify_env, args.user, args.name, args.state_dir, run, systemd_dir, getpwnam,
                      skip_telegram_check=args.skip_telegram_check)
    except BridgeError as err:
        sys.stderr.write("%s\n" % err.message)
        return exit_code_for(err)
    except (IOError, OSError) as err:
        sys.stderr.write("%s\n" % err)
        return EXIT_CONFIG
    except subprocess.TimeoutExpired:
        sys.stderr.write("Lệnh chạy quá %d giây\n" % RUN_TIMEOUT)
        return EXIT_NETWORK
    return 0


def _watch_units(systemd_dir):
    try:
        return sorted(n for n in os.listdir(systemd_dir) if n.startswith(WATCH_UNIT_PREFIX) and n.endswith(".service"))
    except OSError:
        return []


def cmd_pair(args, run=subprocess.run, geteuid=os.geteuid, systemd_dir=SYSTEMD_DIR, getpwnam=pwd.getpwnam):
    """Giải mã mã ghép nối, đổi vé lấy khoá (đã ghim chứng chỉ trước khi gửi vé), ghi .env rồi chạy doctor."""
    if args.install:
        return cmd_install(args, run, geteuid, systemd_dir, getpwnam)
    try:
        info = decode_pairing_code(args.code)
        env_path = os.path.join(args.dir or ".", ".env")
        if _env_file_has_key(env_path, "TG_TOKEN"):  # trước khi dùng vé: không ghi đè .env của bot (đang đứng trong thư mục dữ liệu bot)
            raise BridgeError("CONFIG", "Từ chối: %s chứa TG_TOKEN (có vẻ là .env của bot). Dùng --dir trỏ tới thư mục riêng cho MaiHub" % env_path)
        paired = MaiHubClient(Config(info["url"], None, info["pin"])).pair(info["ticket"])
        api_key = paired.get("apiKey") if isinstance(paired, dict) else None
        if not isinstance(api_key, str) or not api_key:
            raise BridgeError("BAD_RESPONSE", "MaiHub không trả về khoá API")
        values = {"MAIHUB_URL": info["url"], "MAIHUB_CERT_SHA256": info["pin"], "MAIHUB_API_KEY": api_key}
        _write_paired_env(env_path, values)
    except BridgeError as err:
        return exit_code_for(err)
    print("Đã ghép nối bot \"%s\" (khoá %s). Đã ghi %s (quyền 600):" % (info["name"], paired.get("keyName", ""), env_path))
    for key, val in values.items():
        print("%s=%s" % (key, mask_key(val) if key == "MAIHUB_API_KEY" else val))
    for unit in _watch_units(systemd_dir):
        print("Đang có service %s: chạy `sudo systemctl restart %s` để áp dụng khoá mới ngay (watch cũng tự nạp lại .env sau tối đa %d giây)." % (unit, unit, WATCH_AUTH_RETRY_SEC))
    return cmd_doctor(lambda: Config.load(env_path, {}))


# ---------------------------------------------------------------- watch

def clip(text, limit):
    text = text if isinstance(text, str) else str(text)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _one_line(value):
    """Gộp mọi khoảng trắng / xuống dòng thành một dấu cách để mỗi mẫu nằm gọn trên một dòng."""
    return " ".join(str(value or "").split())


def _first_item(value):
    for part in (value or "").split(","):
        if part.strip():
            return part.strip()
    return ""


def resolve_notify_target(maihub_env, bot_env):
    """Token từ TG_TOKEN của bot; chat theo thứ tự MAIHUB_NOTIFY_CHAT_ID, ALLOWED_CHAT_ID (+ topic), ADMIN_USER_ID."""
    token = (bot_env.get("TG_TOKEN") or "").strip()
    if not token:
        raise BridgeError("CONFIG", "Thiếu TG_TOKEN trong --notify-env")
    thread_id = None
    chat_id = _first_item(maihub_env.get("MAIHUB_NOTIFY_CHAT_ID"))
    if not chat_id:
        chat_id = _first_item(bot_env.get("ALLOWED_CHAT_ID"))
        topic = (bot_env.get("ALLOWED_TOPIC_ID") or "").strip()
        if chat_id and topic.isdigit():
            thread_id = int(topic)
    if not chat_id:
        chat_id = _first_item(bot_env.get("ADMIN_USER_ID"))
    if not chat_id:
        raise BridgeError("CONFIG", "Không có chat nhận tin: đặt MAIHUB_NOTIFY_CHAT_ID (.env MaiHub) hoặc ALLOWED_CHAT_ID / ADMIN_USER_ID (.env bot)")
    return {"token": token, "chat_id": chat_id, "thread_id": thread_id}


def resolve_telegram_route(maihub_env):
    """TELEGRAM_API_BASE thay gốc api.telegram.org; không thì TELEGRAM_PROXY (http/https); không thì đi thẳng."""
    base = (maihub_env.get("TELEGRAM_API_BASE") or "").strip().rstrip("/")
    if base:
        if not base.lower().startswith("https://"):
            raise BridgeError("CONFIG", "TELEGRAM_API_BASE phải là https:// (token bot nằm trong đường dẫn, không được gửi qua http)")
        return {"api_base": base, "proxy": None}
    proxy = (maihub_env.get("TELEGRAM_PROXY") or "").strip()
    if proxy:
        if not re.match(r"^https?://", proxy, re.I):
            raise BridgeError("CONFIG", "TELEGRAM_PROXY phải là http:// hoặc https:// (thư viện chuẩn không hỗ trợ proxy SOCKS)")
        return {"api_base": TELEGRAM_BASE, "proxy": proxy}
    return {"api_base": TELEGRAM_BASE, "proxy": None}


class PrintSender(object):
    """--dry-run: in tin ra stdout thay vì gửi Telegram."""

    def send(self, text):
        print(text)
        return True


class TelegramSender(object):
    def __init__(self, target, route, sleep=time.sleep, opener=None):
        self._token = target["token"]
        self.chat_id = target["chat_id"]
        self.thread_id = target.get("thread_id")
        self.url = "%s/bot%s/sendMessage" % (route["api_base"], self._token)
        self.check_url = "%s/bot%s/getMe" % (route["api_base"], self._token)
        self.sleep = sleep
        if opener is None:
            proxy = route.get("proxy")
            handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
            opener = urllib.request.build_opener(*handlers)
        self.opener = opener

    def __repr__(self):
        return "TelegramSender(chat_id=%r)" % (self.chat_id,)

    def _post(self, text):
        body = {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": True}
        if self.thread_id is not None:
            body["message_thread_id"] = self.thread_id
        self._call(self.url, body)

    def check(self):
        """getMe một lần qua tuyến đã chọn (không thử lại). Trả (True, "") hoặc (False, mô tả lỗi đã che token)."""
        try:
            self._call(self.check_url, {})
            return True, ""
        except Exception as err:
            return False, self._describe(err)

    def _call(self, url, body):
        request = urllib.request.Request(url, json.dumps(body).encode("utf-8"),
                                         {"Content-Type": "application/json"}, method="POST")
        resp = self.opener.open(request, timeout=DEFAULT_TIMEOUT)
        try:
            data = json.loads(resp.read().decode("utf-8"))
        finally:
            resp.close()
        if not isinstance(data, dict) or data.get("ok") is not True:
            raise BridgeError("BAD_RESPONSE", "Telegram trả về ok=false")

    def _describe(self, err):
        if isinstance(err, urllib.error.HTTPError):
            return "HTTP %d" % err.code
        text = ("%s: %s" % (type(err).__name__, err)).replace(self._token, "***")
        return re.sub(r"//[^/@\s]+@", "//***@", text)  # user:pass@ của URL proxy nếu có trong thông điệp lỗi

    @staticmethod
    def _retry_after(err):
        if isinstance(err, urllib.error.HTTPError) and err.code == 429:
            try:
                value = json.loads(err.read().decode("utf-8")).get("parameters", {}).get("retry_after")
                if isinstance(value, (int, float)) and value >= 0:
                    return min(value, MAX_RETRY_AFTER_SEC)
            except (ValueError, AttributeError, OSError):
                pass
            finally:
                err.close()
        return None

    def send(self, text):
        """Gửi văn bản thuần; thử lại sau 2, 10, 30 giây (429: chờ retry_after). Hết lượt thì ghi log, trả False."""
        for attempt in range(len(SEND_RETRY_DELAYS) + 1):
            try:
                self._post(text)
                return True
            except Exception as err:
                if attempt == len(SEND_RETRY_DELAYS):
                    print("Không gửi được tin Telegram sau %d lần thử (%s); bỏ tin này" % (attempt + 1, self._describe(err)), file=sys.stderr)
                    return False
                wait = self._retry_after(err)
                self.sleep(SEND_RETRY_DELAYS[attempt] if wait is None else wait)


def _run_label(payload):
    if payload.get("scheduleName"):
        return clip(payload["scheduleName"], MAX_FIELD_CHARS)
    kind = payload.get("kind")
    if kind and kind != "post":
        return KIND_LABELS.get(kind, clip(kind, MAX_FIELD_CHARS))
    return "Đăng ngay"


def _failure_lines(run_id, fetch_run):
    try:
        results = (fetch_run(run_id) or {}).get("results") or []
        failed = [r for r in results if isinstance(r, dict) and (r.get("outcome") == "failed" or r.get("error"))]
    except Exception:
        return []
    return ["• %s: %s" % (clip(r.get("targetName") or r.get("targetUrl") or "?", MAX_FIELD_CHARS), clip(r.get("error") or "lỗi không rõ", MAX_FIELD_CHARS))
            for r in failed[:MAX_ERROR_LINES]]


def format_event(event, fetch_run):
    """Tin tiếng Việt (văn bản thuần) cho một sự kiện, hoặc None nếu không cần báo. fetch_run(runId) có thể ném lỗi."""
    etype, payload = event.get("type"), event.get("payload") or {}
    lines = None
    if etype == "run.finished":
        label = _run_label(payload)
        posted, failed, skipped = (int(payload.get(k) or 0) for k in ("posted", "failed", "skipped"))
        total = posted + failed + skipped
        status = payload.get("status")
        if status == "cancelled":
            lines = ["⏹ %s: đã huỷ (%d/%d)" % (label, posted, total)]
        elif failed > 0:
            lines = ["⚠️ %s: xong %d/%d, lỗi %d" % (label, posted, total, failed)] + _failure_lines(payload.get("runId"), fetch_run)
        elif status == "failed":  # lỗi cấp lượt chạy, không có đích nào ghi lỗi
            lines = ["⚠️ %s: xong %d/%d, lượt chạy bị lỗi" % (label, posted, total)] + _failure_lines(payload.get("runId"), fetch_run)
        elif status == "done":
            lines = ["✅ %s: xong %d/%d" % (label, posted, total)] if total else ["✅ %s: xong" % label]
    elif etype == "schedule.missed":
        lines = ["⏰ Lỡ lịch \"%s\": %s" % (clip(payload.get("name") or "", MAX_FIELD_CHARS), clip(payload.get("reason") or "", MAX_FIELD_CHARS))]
    elif etype == "profile.loginProblem":
        what = "bị checkpoint" if payload.get("state") == "checkpoint" else "hết phiên đăng nhập"
        lines = ["🔒 Profile \"%s\": %s" % (clip(payload.get("profileName") or "", MAX_FIELD_CHARS), what), "Mở MaiHub để đăng nhập lại."]
    elif etype == "posts.trackFinished":
        linked, removed = (int(payload.get(k) or 0) for k in ("linked", "removedSuspected"))
        if linked > 0 or removed > 0:  # không có link mới và không có bài bị xoá thì không báo
            lines = ["📈 Theo dõi bài: kiểm tra %d nhóm, lấy được %d link, %d bài có thể đã bị xoá" % (int(payload.get("groups") or 0), linked, removed)]
    elif etype == "leads.found":
        count = payload.get("count")
        if isinstance(count, int) and not isinstance(count, bool) and count > 0:  # không có khách mới thì không báo
            lines = ["🎯 %d khách tiềm năng mới" % count]
            samples = payload.get("samples")
            for sample in (samples if isinstance(samples, list) else [])[:MAX_LEAD_SAMPLES]:
                if isinstance(sample, dict) and (sample.get("authorName") or sample.get("text")):
                    lines.append("%s: %s" % (clip(_one_line(sample.get("authorName")), MAX_FIELD_CHARS), clip(_one_line(sample.get("text")), LEAD_TEXT_CHARS)))
    elif etype == "videos.finished":
        name = clip(_one_line(payload.get("name")), MAX_FIELD_CHARS)
        if payload.get("cancelled") is True:
            lines = []  # người dùng tự huỷ: không báo như lỗi
        elif payload.get("ok") is True:
            seconds = payload.get("durationSec")
            ok_seconds = isinstance(seconds, (int, float)) and not isinstance(seconds, bool)
            lines = ["🎬 Video xong: %s (%ds)" % (name, int(round(seconds)))] if ok_seconds else ["🎬 Video xong: %s" % name]
        else:
            lines = ["⚠️ Video lỗi: %s — %s" % (name, clip(_one_line(payload.get("error")) or "lỗi không rõ", VIDEO_ERROR_CHARS))]
    return clip("\n".join(lines), MAX_MESSAGE_CHARS) if lines else None


class Watcher(object):
    """Long-poll events.wait và gửi tin; trạng thái {cursor, workspaceId, downSince, downAlerted, authAlerted} lưu nguyên tử."""

    def __init__(self, client, sender, state_path, clock=time.time, sleep=time.sleep, persist=True, reload_client=None):
        self.reload_client = reload_client  # gọi lại sau mỗi lần chờ UNAUTHORIZED/PIN_MISMATCH để nhận .env mới (ghép nối lại)
        self.persist = persist  # False (--dry-run): không ghi tệp trạng thái
        self.client = client
        self.sender = sender
        self.state_path = state_path
        self.clock = clock
        self.sleep = sleep
        self.flags = {"downSince": None, "downAlerted": False, "authAlerted": False}
        self.state = self._load()  # {cursor, workspaceId}; None = chưa có tệp (lần chạy đầu)

    def _load(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (IOError, OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("cursor"), int):
            return None
        self.flags = {"downSince": data.get("downSince"), "downAlerted": bool(data.get("downAlerted")),
                      "authAlerted": bool(data.get("authAlerted"))}
        return {"cursor": data["cursor"], "workspaceId": data.get("workspaceId")}

    def _save(self):
        if self.state is None or not self.persist:  # chưa xác định được con trỏ thì không ghi: lần sau vẫn là "lần đầu"
            return
        directory = os.path.dirname(self.state_path) or "."
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".watch-state.")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(dict(self.state, **self.flags), handle)
                os.replace(tmp_path, self.state_path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except OSError as err:  # đĩa đầy...: giữ con trỏ trong bộ nhớ, đừng sập (sập + khởi động lại sẽ gửi trùng tin)
            print("Không ghi được trạng thái watch (%s); tiếp tục với con trỏ trong bộ nhớ" % err, file=sys.stderr)

    def _wait(self, after, timeout_sec):
        """events.wait đã kiểm định dạng: events là danh sách dict có seq (int, không phải bool) và type (str)."""
        result = self.client.call("events.wait", {"after": after, "timeoutSec": timeout_sec})
        events = result.get("events") if isinstance(result, dict) else None
        if events is None and isinstance(result, dict):
            events = []
        if not isinstance(events, list) or any(
                not isinstance(e, dict) or not isinstance(e.get("seq"), int) or isinstance(e.get("seq"), bool)
                or not isinstance(e.get("type"), str) for e in events):
            raise BridgeError("BAD_RESPONSE", "events.wait trả về sự kiện sai định dạng")
        return result

    def _latest(self, after):
        """Duyệt hết các trang (timeoutSec=0) tới trang rỗng; trả (seq lớn nhất, workspaceId)."""
        seq, workspace = after, None
        while True:
            result = self._wait(seq, 0)
            workspace = result.get("workspaceId")
            events = result.get("events") or []
            if not events:
                return seq, workspace
            top = max(e["seq"] for e in events)
            if top <= seq:  # không tiến lên: dừng để khỏi lặp vô hạn
                return seq, workspace
            seq = top

    def _host(self):
        try:
            return self.client.config.host_port()[0]
        except Exception:
            return "MaiHub"

    def _recovered(self):
        st = self.flags
        if st["downAlerted"]:
            minutes = int(round((self.clock() - st["downSince"]) / 60.0))
            self.sender.send("✅ MaiHub đã kết nối lại sau %d phút" % minutes)
        if st["downSince"] is not None or st["downAlerted"] or st["authAlerted"]:
            st.update({"downSince": None, "downAlerted": False, "authAlerted": False})
            self._save()

    def _workspace_name(self, workspace_id):
        try:
            current = (self.client.call("system.status", {}) or {}).get("workspace")
            name = current.get("name") if isinstance(current, dict) else None
            return name if isinstance(name, str) and name else workspace_id
        except Exception:
            return workspace_id

    def _reload(self):
        if self.reload_client is None:
            return
        try:
            self.client = self.reload_client()
        except (BridgeError, IOError, OSError):
            pass  # .env đang hỏng/thiếu: giữ client cũ, vòng sau thử lại

    def _on_error(self, err):
        st = self.flags
        if err.code in ("UNAUTHORIZED", "PIN_MISMATCH"):
            if not st["authAlerted"]:
                st["authAlerted"] = True
                if err.code == "UNAUTHORIZED":
                    self.sender.send("🔑 MaiHub từ chối khoá truy cập (có thể khoá đã bị thu hồi). Hãy tạo mã ghép nối mới trong MaiHub rồi ghép nối lại bằng `maihub_bridge.py pair`.")
                else:
                    self.sender.send("🔐 Chứng chỉ MaiHub không khớp dấu vân tay đã ghim. Nếu MaiHub vừa đổi chứng chỉ, hãy tạo mã ghép nối mới rồi ghép nối lại bằng `maihub_bridge.py pair`.")
                self._save()
            self.sleep(WATCH_AUTH_RETRY_SEC)
            self._reload()
            return
        now = self.clock()
        if st["downSince"] is None:
            st["downSince"] = now
        if not st["downAlerted"] and now - st["downSince"] >= WATCH_DOWN_ALERT_SEC:
            st["downAlerted"] = True
            since = time.strftime("%H:%M", time.localtime(st["downSince"]))
            self.sender.send("⚠️ Không liên lạc được MaiHub (%s) từ %s. Lỗi: %s" % (self._host(), since, clip(err.message or err.code, MAX_FIELD_CHARS)))
        self._save()
        self.sleep(WATCH_RETRY_SEC)

    def step(self):
        """Một vòng events.wait (hoặc một lần xử lý lỗi)."""
        try:
            if self.state is None:
                seq, workspace = self._latest(0)
                self.state = {"cursor": seq, "workspaceId": workspace}
                self._recovered()
                self._save()
                return
            started = self.clock()
            result = self._wait(self.state["cursor"], WATCH_WAIT_SEC)
            self._recovered()
            workspace = result.get("workspaceId")
            known = self.state["workspaceId"]
            if workspace is not None and known is not None and workspace != known:  # workspaceId null = chưa mở workspace, không phải đổi
                self.state["cursor"], _ = self._latest(0)
                self.state["workspaceId"] = workspace
                self.sender.send("Đã chuyển workspace: %s" % clip(self._workspace_name(workspace), MAX_FIELD_CHARS))
                self._save()
                return
            if known is None and workspace is not None:
                self.state["workspaceId"] = workspace
            if not result.get("events") and self.clock() - started < WATCH_MIN_POLL_SEC:
                self.sleep(WATCH_MIN_POLL_SEC)  # trả rỗng ngay: tránh vòng lặp nóng
            for event in result.get("events") or []:
                text = format_event(event, lambda run_id: self.client.call("runs.get", {"runId": run_id}))
                if text:
                    self.sender.send(text)
                self.state["cursor"] = event["seq"]
                self._save()
        except BridgeError as err:
            self._on_error(err)

    def run_forever(self):
        try:
            while True:
                self.step()
        except KeyboardInterrupt:
            return


def cmd_watch(args):
    try:
        if not args.env_file and not args.state:
            raise BridgeError("CONFIG", "Cần --env-file (hoặc --state) để biết nơi lưu trạng thái")
        maihub_env = parse_env_file(args.env_file) if args.env_file else {}
        try:
            bot_env = parse_env_file(args.notify_env)
        except (IOError, OSError) as err:
            raise BridgeError("CONFIG", "Không đọc được --notify-env: %s" % err)
        config = Config.load(args.env_file)
        target = resolve_notify_target(maihub_env, bot_env)
        route = resolve_telegram_route(maihub_env)
        if args.check_telegram:
            ok, detail = TelegramSender(target, route).check()
            if not ok:
                print("Telegram getMe thất bại: %s" % detail, file=sys.stderr)
                return EXIT_NETWORK
            print("Telegram OK (getMe)")
            return 0
        sender = PrintSender() if args.dry_run else TelegramSender(target, route)
        state_path = args.state or os.path.join(os.path.dirname(os.path.abspath(args.env_file)), "state", "watch-state.json")
        if not args.dry_run:
            os.makedirs(os.path.dirname(state_path), mode=0o700, exist_ok=True)
        Watcher(MaiHubClient(config), sender, state_path, persist=not args.dry_run,
                reload_client=lambda: MaiHubClient(Config.load(args.env_file))).run_forever()
    except BridgeError as err:
        return exit_code_for(err)
    except (IOError, OSError) as err:
        print("CONFIG: %s" % err, file=sys.stderr)
        return EXIT_CONFIG
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
    p_up = sub.add_parser("upload", parents=[shared], help="Tải ảnh/video/nhạc lên MaiHub")
    p_up.add_argument("path")
    p_wait = sub.add_parser("wait", parents=[shared], help="Chờ sự kiện (events.wait)")
    p_wait.add_argument("--after", type=int, default=0)
    p_wait.add_argument("--timeout", type=int, default=25, help="Giây, tối đa 25")
    sub.add_parser("doctor", parents=[shared], help="Kiểm tra cấu hình, kết nối, ghim chứng chỉ, khoá")
    sub.add_parser("mcp", parents=[shared], help="Chạy MCP server qua stdio")
    p_pair = sub.add_parser("pair", help="Ghép nối với MaiHub bằng mã ghép nối, ghi .env")
    p_pair.add_argument("code", help="Mã ghép nối (mhp1.…) lấy từ giao diện MaiHub")
    p_pair.add_argument("--dir", default=None, help="Thư mục ghi .env (mặc định: thư mục hiện tại; với --install: /opt/bot/maihub/<service>)")
    p_pair.add_argument("--install", action="store_true", help="Cài cho bot AHV trên máy này (cần root): thư mục, .env, đăng ký MCP")
    p_pair.add_argument("--bot", help="Tên service của bot (bắt buộc khi có nhiều bot)")
    p_pair.add_argument("--cli", choices=["claude", "codex"], help="Loại CLI (mặc định suy ra từ user hoặc tên service)")
    p_pair.add_argument("--no-watch", action="store_true", help="Không cài service watch (thông báo Telegram)")
    p_pair.add_argument("--skip-telegram-check", action="store_true", help="Với --install: bỏ qua bước kiểm tra Telegram getMe của watch")
    p_watch = sub.add_parser("watch", parents=[shared], help="Gửi sự kiện MaiHub tới Telegram bằng token của bot")
    p_watch.add_argument("--notify-env", required=True, help=".env của bot (TG_TOKEN, ALLOWED_CHAT_ID, ...)")
    p_watch.add_argument("--state", help="Tệp trạng thái (mặc định: state/watch-state.json cạnh --env-file)")
    p_watch.add_argument("--dry-run", action="store_true", help="In tin ra stdout, không gửi Telegram")
    p_watch.add_argument("--check-telegram", action="store_true", help="Gọi Telegram getMe một lần qua tuyến đã chọn rồi thoát (0 = được)")
    p_iw = sub.add_parser("install-watch", help="Cài watch thành service systemd (cần root)")
    p_iw.add_argument("--env-file", required=True, help=".env MaiHub")
    p_iw.add_argument("--notify-env", required=True, help=".env của bot (TG_TOKEN, ALLOWED_CHAT_ID, ...)")
    p_iw.add_argument("--user", required=True, help="User chạy service (thường là user của bot)")
    p_iw.add_argument("--name", required=True, help="Tên service của bot (đặt tên maihub-watch-<name>.service)")
    p_iw.add_argument("--skip-telegram-check", action="store_true", help="Bỏ qua bước kiểm tra Telegram getMe")
    p_iw.add_argument("--state-dir", default=None, help="Thư mục trạng thái (mặc định: state/ cạnh --env-file)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if argv is None:  # chạy thật (không phải trong test): ép UTF-8 cho stdin/stdout/stderr
        sys.stdin, sys.stdout, sys.stderr = utf8_stream(sys.stdin), utf8_stream(sys.stdout, True), utf8_stream(sys.stderr, True)

    def loader():
        return Config.load(args.env_file)

    if args.command == "doctor":
        return cmd_doctor(loader)
    if args.command == "pair":
        return cmd_pair(args)
    if args.command == "watch":
        return cmd_watch(args)
    if args.command == "install-watch":
        return cmd_install_watch(args)
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
        return exit_code_for(err)


if __name__ == "__main__":
    sys.exit(main())
