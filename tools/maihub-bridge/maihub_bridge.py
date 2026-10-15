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
import subprocess
import sys
import tempfile
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

PAIR_PREFIX = "mhp1."
PAIR_TICKET_RE = re.compile(r"^[A-Za-z0-9_-]{43}\Z")
SYSTEMD_DIR = "/etc/systemd/system"
DEFAULT_INSTALL_ROOT = "/opt/bot/maihub"
BRIDGE_NAME = "maihub_bridge.py"
BACKUP_SUFFIX = ".before-maihub"
RUN_TIMEOUT = 120

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


def write_env_file(path, values, uid=None, gid=None):
    """Ghi tệp KEY=VALUE quyền 0600 ngay từ lúc tạo (mkstemp cùng thư mục: tên khó đoán, không theo symlink; rồi os.replace)."""
    fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".env.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for key, val in values.items():
                handle.write("%s=%s\n" % (key, val))
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
    """Chỉ kiểm tra khoá có tồn tại; không giữ hay in giá trị."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.strip()
                if line.startswith("export "):
                    line = line[len("export "):]
                if line.startswith(key + "="):
                    return True
    except (IOError, OSError):
        pass
    return False


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
        raise BridgeError("CONFIG", "Lệnh đăng ký MCP thất bại (mã %s)" % result.returncode)


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
    print("Tóm tắt: thư mục %s, CLI %s, user %s, doctor OK, MCP \"maihub\" đã đăng ký." % (install_dir, cli, bot["user"]))
    print("Lệnh gỡ:")
    print("  sudo -u %s -H %s mcp remove maihub%s" % (bot["user"], cli, " -s user" if cli == "claude" else ""))
    print("  sudo rm -rf %s" % shlex.quote(install_dir))
    return 0


def cmd_pair(args, run=subprocess.run, geteuid=os.geteuid, systemd_dir=SYSTEMD_DIR, getpwnam=pwd.getpwnam):
    """Giải mã mã ghép nối, đổi vé lấy khoá (đã ghim chứng chỉ trước khi gửi vé), ghi .env rồi chạy doctor."""
    if args.install:
        return cmd_install(args, run, geteuid, systemd_dir, getpwnam)
    try:
        info = decode_pairing_code(args.code)
        paired = MaiHubClient(Config(info["url"], None, info["pin"])).pair(info["ticket"])
        api_key = paired.get("apiKey") if isinstance(paired, dict) else None
        if not isinstance(api_key, str) or not api_key:
            raise BridgeError("BAD_RESPONSE", "MaiHub không trả về khoá API")
        values = {"MAIHUB_URL": info["url"], "MAIHUB_CERT_SHA256": info["pin"], "MAIHUB_API_KEY": api_key}
        env_path = os.path.join(args.dir or ".", ".env")
        _write_paired_env(env_path, values)
    except BridgeError as err:
        return exit_code_for(err)
    print("Đã ghép nối bot \"%s\" (khoá %s). Đã ghi %s (quyền 600):" % (info["name"], paired.get("keyName", ""), env_path))
    for key, val in values.items():
        print("%s=%s" % (key, mask_key(val) if key == "MAIHUB_API_KEY" else val))
    return cmd_doctor(lambda: Config.load(env_path, {}))


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
    p_pair = sub.add_parser("pair", help="Ghép nối với MaiHub bằng mã ghép nối, ghi .env")
    p_pair.add_argument("code", help="Mã ghép nối (mhp1.…) lấy từ giao diện MaiHub")
    p_pair.add_argument("--dir", default=None, help="Thư mục ghi .env (mặc định: thư mục hiện tại; với --install: /opt/bot/maihub/<service>)")
    p_pair.add_argument("--install", action="store_true", help="Cài cho bot AHV trên máy này (cần root): thư mục, .env, đăng ký MCP")
    p_pair.add_argument("--bot", help="Tên service của bot (bắt buộc khi có nhiều bot)")
    p_pair.add_argument("--cli", choices=["claude", "codex"], help="Loại CLI (mặc định suy ra từ user hoặc tên service)")
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
