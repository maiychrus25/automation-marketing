# -*- coding: utf-8 -*-
import base64
import hashlib
import io
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import maihub_bridge as bridge  # noqa: E402

REAL_IS_TRUSTED_DIR = bridge._is_root_trusted_dir  # InstallFixture thay bản này trong từng test

CERT = os.path.join(HERE, "fixtures", "cert.pem")
KEY = os.path.join(HERE, "fixtures", "key.pem")
API_KEY = "mh_testkey_1234567890"
PAIR_TICKET = "A" * 43


def cert_fingerprint():
    with open(CERT, "r") as handle:
        der = ssl.PEM_cert_to_DER_cert(handle.read())
    return hashlib.sha256(der).hexdigest()


PIN = cert_fingerprint()

class QuietServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # client ghim sai đóng kết nối giữa chừng là chuyện bình thường


DESCRIBE = {
    "protocol": 1,
    "methods": [
        {"name": "system.status", "description": "Trạng thái", "destructive": False,
         "paramsSchema": {"type": "object", "properties": {}}, "resultSchema": {"type": "object"}},
        {"name": "drafts.delete", "description": "Xoá nháp", "destructive": True,
         "paramsSchema": {"type": "object", "properties": {"id": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["id", "confirm"]},
         "resultSchema": {"type": "object"}},
        {"name": "events.wait", "description": "Chờ", "destructive": False,
         "paramsSchema": {"type": "object", "properties": {"after": {"type": "integer"}, "timeoutSec": {"type": "integer"}}, "required": ["after"]},
         "resultSchema": {"type": "object"}},
    ],
}


class FakeMaiHub(object):
    def __init__(self):
        self.requests = []
        self.describe_fail = False
        self.pair_tickets = {PAIR_TICKET}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, status, body):
                payload = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _record(self, body):
                outer.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})

            def do_GET(self):
                self._record(b"")
                if self.headers.get("Authorization") != "Bearer " + API_KEY:
                    return self._reply(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "Khoá sai"}})
                if self.path == "/v1/health":
                    return self._reply(200, {"ok": True, "result": {"status": "ok"}})
                if self.path == "/v1/describe":
                    if outer.describe_fail:
                        return self._reply(500, {"ok": False, "error": {"code": "INTERNAL", "message": "hỏng"}})
                    return self._reply(200, {"ok": True, "result": DESCRIBE})
                self._reply(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "không có"}})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self._record(body)
                if self.path == "/v1/pair":
                    ticket = json.loads(body.decode("utf-8")).get("ticket")
                    if ticket in outer.pair_tickets:
                        outer.pair_tickets.discard(ticket)  # dùng một lần
                        return self._reply(200, {"ok": True, "result": {"apiKey": getattr(outer, "pair_api_key", API_KEY), "keyName": "bot-test"}})
                    return self._reply(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "Vé không hợp lệ"}})
                if self.path == "/v1/media":
                    return self._reply(200, {"ok": True, "result": {"mediaId": "m1", "name": urllib.parse.unquote(self.headers["X-Filename"]), "size": len(body), "kind": "image"}})
                req = json.loads(body.decode("utf-8"))
                if req["method"] == "drafts.delete" and not req["params"].get("confirm"):
                    return self._reply(409, {"ok": False, "error": {"code": "CONFIRMATION_REQUIRED", "message": "Cần xác nhận", "details": {"field": "confirm"}}})
                if req["method"] == "drafts.delete" and req["params"].get("id") == "missing":
                    return self._reply(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Không thấy nháp"}})
                self._reply(200, {"ok": True, "result": {"echo": req}})

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        self.httpd = QuietServer(("127.0.0.1", 0), Handler)
        self.httpd.socket = ctx.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05})
        self.thread.daemon = True
        self.thread.start()

    @property
    def url(self):
        return "https://127.0.0.1:%d" % self.port

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)


class BridgeTestCase(unittest.TestCase):
    def setUp(self):
        self.hub = FakeMaiHub()
        self.addCleanup(self.hub.stop)
        self.config = bridge.Config(self.hub.url, API_KEY, PIN)
        self.client = bridge.MaiHubClient(self.config, timeout=10)

    def run_cli(self, argv, env=None):
        env = env if env is not None else {"MAIHUB_URL": self.hub.url, "MAIHUB_API_KEY": API_KEY, "MAIHUB_CERT_SHA256": PIN}
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            code = bridge.main(argv)
        return code, out.getvalue(), err.getvalue()

    def mcp(self, lines, client=None):
        out, err = io.StringIO(), io.StringIO()
        data = "".join(l + "\n" for l in lines)
        bridge.McpServer(client or self.client, io.StringIO(data), out, err).run()
        return [json.loads(l) for l in out.getvalue().splitlines()]


class PinningTests(BridgeTestCase):
    def test_match_allows_request(self):
        self.assertEqual(self.client.health(), {"status": "ok"})

    def test_colons_and_uppercase_normalised(self):
        spaced = ":".join(PIN[i:i + 2] for i in range(0, 64, 2)).upper()
        self.assertEqual(bridge.normalize_fingerprint(spaced), PIN)

    def test_mismatch_never_sends_key(self):
        client = bridge.MaiHubClient(bridge.Config(self.hub.url, API_KEY, "0" * 64), timeout=10)
        with self.assertRaises(bridge.BridgeError) as ctx:
            client.describe()
        self.assertEqual(ctx.exception.code, "PIN_MISMATCH")
        self.assertEqual(self.hub.requests, [])

    def test_bad_pin_format_is_config_error(self):
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.normalize_fingerprint("abc")
        self.assertEqual(ctx.exception.code, "CONFIG")


class McpTests(BridgeTestCase):
    def test_initialize_and_framing(self):
        replies = self.mcp([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}),
            "{not json",
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "nope/nothing"}),
        ])
        self.assertEqual(replies[0]["result"]["protocolVersion"], "2025-03-26")
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "maihub")
        self.assertEqual(replies[1]["error"]["code"], -32700)
        self.assertEqual(replies[2], {"jsonrpc": "2.0", "id": 2, "result": {}})
        self.assertEqual(replies[3]["error"]["code"], -32601)
        self.assertEqual(len(replies), 4)

    def test_unknown_protocol_version_falls_back(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})])
        self.assertEqual(replies[0]["result"]["protocolVersion"], "2024-11-05")

    def test_tools_list_mapping(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})])
        tools = dict((t["name"], t) for t in replies[0]["result"]["tools"])
        self.assertEqual(sorted(tools), ["maihub_drafts_delete", "maihub_events_wait", "maihub_system_status", "maihub_upload_media"])
        self.assertIn("Cần confirm: true (hỏi người dùng trước)", tools["maihub_drafts_delete"]["description"])
        self.assertNotIn("Cần confirm", tools["maihub_system_status"]["description"])
        self.assertEqual(tools["maihub_system_status"]["inputSchema"]["properties"]["idempotencyKey"]["type"], "string")
        self.assertEqual(tools["maihub_drafts_delete"]["inputSchema"]["required"], ["id", "confirm"])
        self.assertNotIn("_method", tools["maihub_drafts_delete"])

    def test_tools_list_cached_and_retried_after_failure(self):
        self.hub.describe_fail = True
        req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        server_out = io.StringIO()
        server = bridge.McpServer(self.client, io.StringIO(req + "\n"), server_out, io.StringIO())
        server.run()
        self.assertIn("error", json.loads(server_out.getvalue()))
        self.hub.describe_fail = False
        server.stdin, server.stdout = io.StringIO(req + "\n" + req.replace('"id": 1', '"id": 2') + "\n"), io.StringIO()
        server.run()
        replies = [json.loads(l) for l in server.stdout.getvalue().splitlines()]
        self.assertEqual(len(replies[0]["result"]["tools"]), 4)
        describes = [r for r in self.hub.requests if r["path"] == "/v1/describe"]
        self.assertEqual(len(describes), 2)  # 1 lỗi + 1 thành công; lần 3 dùng cache

    def call(self, name, arguments):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})])
        return replies[0]["result"]

    def test_call_success_strips_idempotency_key(self):
        result = self.call("maihub_system_status", {"idempotencyKey": "k1"})
        self.assertNotIn("isError", result)
        echo = json.loads(result["content"][0]["text"])["echo"]
        self.assertEqual(echo["method"], "system.status")
        self.assertEqual(echo["idempotencyKey"], "k1")
        self.assertEqual(echo["params"], {})

    def test_call_error_is_error_result(self):
        result = self.call("maihub_drafts_delete", {"id": "missing", "confirm": True})
        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["text"], "NOT_FOUND: Không thấy nháp")

    def test_call_confirmation_required_guidance(self):
        result = self.call("maihub_drafts_delete", {"id": "d1"})
        self.assertTrue(result["isError"])
        text = result["content"][0]["text"]
        self.assertTrue(text.startswith("CONFIRMATION_REQUIRED: Cần xác nhận"))
        self.assertIn("Hãy hỏi người dùng xác nhận rồi gọi lại với confirm: true", text)

    def test_unknown_tool(self):
        result = self.call("maihub_nothing", {})
        self.assertTrue(result["isError"])

    def test_upload_tool(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as handle:
            handle.write(b"PNGDATA")
            handle.flush()
            result = self.call("maihub_upload_media", {"path": handle.name})
        self.assertEqual(json.loads(result["content"][0]["text"])["mediaId"], "m1")


class UploadTests(BridgeTestCase):
    def test_headers_and_body(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(lambda: (os.remove(path), os.rmdir(directory)))
        path = os.path.join(directory, "ảnh đẹp 1.jpg")
        with open(path, "wb") as handle:
            handle.write(b"x" * 5000)
        result = self.client.upload(path)
        self.assertEqual(result["mediaId"], "m1")
        self.assertEqual(result["name"], "ảnh đẹp 1.jpg")
        req = [r for r in self.hub.requests if r["path"] == "/v1/media"][0]
        self.assertEqual(req["headers"]["Content-Type"], "image/jpeg")
        self.assertEqual(req["headers"]["X-Filename"], urllib.parse.quote("ảnh đẹp 1.jpg", safe=""))
        self.assertEqual(req["headers"]["Authorization"], "Bearer " + API_KEY)
        self.assertEqual(len(req["body"]), 5000)


class MediaTypeAndStdioTests(BridgeTestCase):
    def upload_named(self, name):
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, name)
        with open(path, "wb") as handle:
            handle.write(b"abc")
        self.addCleanup(lambda: (os.remove(path), os.rmdir(directory)))
        return self.client.upload(path)

    def test_fixed_media_types(self):
        expected = {"a.webp": "image/webp", "a.JPG": "image/jpeg", "a.mov": "video/quicktime", "a.webm": "video/webm", "a.mp4": "video/mp4", "a.MP3": "audio/mpeg", "a.m4a": "audio/mp4", "a.wav": "audio/wav"}
        for name, ctype in expected.items():
            self.hub.requests[:] = []
            self.upload_named(name)
            self.assertEqual(self.hub.requests[0]["headers"]["Content-Type"], ctype)

    def test_unknown_extension_fails_locally(self):
        with self.assertRaises(bridge.BridgeError) as ctx:
            self.upload_named("a.txt")
        self.assertEqual(ctx.exception.code, "INVALID_PARAMS")
        self.assertEqual(self.hub.requests, [])

    def test_utf8_stream_wrapper(self):
        raw = io.BytesIO()
        raw.close = lambda: None
        fake = io.TextIOWrapper(raw, encoding="ascii")
        out = bridge.utf8_stream(fake, True)
        out.write(u"Xin chào\n")
        out.flush()
        self.assertEqual(raw.getvalue(), u"Xin chào\n".encode("utf-8"))
        src = io.TextIOWrapper(io.BytesIO(u"é\n".encode("utf-8")), encoding="ascii", errors="replace")
        self.assertEqual(bridge.utf8_stream(src).readline(), u"é\n")

    def test_tools_call_notification_ignored(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "maihub_system_status"}})])
        self.assertEqual(replies, [])
        self.assertEqual(self.hub.requests, [])

    def test_non_string_idempotency_key(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "maihub_system_status", "arguments": {"idempotencyKey": 5}}})])
        self.assertTrue(replies[0]["result"]["isError"])
        self.assertIn("INVALID_PARAMS", replies[0]["result"]["content"][0]["text"])


class CliTests(BridgeTestCase):
    def test_call_success(self):
        code, out, _ = self.run_cli(["call", "system.status", "{}", "--idempotency-key", "abc"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["echo"]["idempotencyKey"], "abc")

    def test_auto_idem_generates_key(self):
        code, out, _ = self.run_cli(["call", "system.status", "--auto-idem"])
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(out)["echo"]["idempotencyKey"]), 36)

    def test_no_idem_by_default(self):
        _, out, _ = self.run_cli(["call", "system.status"])
        self.assertNotIn("idempotencyKey", json.loads(out)["echo"])

    def test_server_error_exit_code_and_stderr(self):
        code, out, err = self.run_cli(["call", "drafts.delete", '{"id":"d1"}'])
        self.assertEqual(code, bridge.EXIT_SERVER_ERROR)
        self.assertEqual(out, "")
        self.assertIn("CONFIRMATION_REQUIRED", err)

    def test_pin_mismatch_exit_code(self):
        code, _, err = self.run_cli(["describe"], {"MAIHUB_URL": self.hub.url, "MAIHUB_API_KEY": API_KEY, "MAIHUB_CERT_SHA256": "1" * 64})
        self.assertEqual(code, bridge.EXIT_NETWORK)
        self.assertIn("PIN_MISMATCH", err)
        self.assertEqual(self.hub.requests, [])

    def test_missing_config(self):
        code, _, err = self.run_cli(["describe"], {})
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("CONFIG", err)

    def test_invalid_json_params(self):
        code, _, err = self.run_cli(["call", "system.status", "{oops"])
        self.assertEqual(code, bridge.EXIT_SERVER_ERROR)
        self.assertIn("INVALID_PARAMS", err)

    def test_wait_sends_events_wait(self):
        code, out, _ = self.run_cli(["wait", "--after", "7", "--timeout", "99"])
        self.assertEqual(code, 0)
        echo = json.loads(out)["echo"]
        self.assertEqual(echo["method"], "events.wait")
        self.assertEqual(echo["params"], {"after": 7, "timeoutSec": 25})


class EnvFileAndDoctorTests(BridgeTestCase):
    def write_env(self, key=API_KEY, pin=None):
        handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False)
        self.addCleanup(os.remove, handle.name)
        pin = pin or ":".join(PIN[i:i + 2] for i in range(0, 64, 2)).upper()
        handle.write("# ghi chú\n\nMAIHUB_URL=%s\nexport MAIHUB_API_KEY=\"%s\"\nMAIHUB_CERT_SHA256 = %s\n" % (self.hub.url, key, pin))
        handle.close()
        return handle.name

    def test_parse_env_file(self):
        values = bridge.parse_env_file(self.write_env())
        self.assertEqual(values["MAIHUB_API_KEY"], API_KEY)
        self.assertEqual(values["MAIHUB_URL"], self.hub.url)

    def test_env_file_cli(self):
        code, out, _ = self.run_cli(["--env-file", self.write_env(), "describe"], {})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["protocol"], 1)

    def test_env_file_accepted_before_and_after_subcommand(self):
        path = self.write_env()
        parse = bridge.build_parser().parse_args
        self.assertEqual(parse(["mcp", "--env-file", path]).env_file, path)
        self.assertEqual(parse(["--env-file", path, "mcp"]).env_file, path)
        self.assertEqual(parse(["--env-file", path, "doctor"]).env_file, path)
        self.assertIsNone(parse(["doctor"]).env_file)
        code, out, _ = self.run_cli(["describe", "--env-file", path], {})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["protocol"], 1)

    def test_doctor_ok_masks_key(self):
        code, out, err = self.run_cli(["--env-file", self.write_env(), "doctor"], {})
        self.assertEqual(code, 0, out + err)
        self.assertNotIn(API_KEY, out + err)
        self.assertIn("3 thao tác", out)
        self.assertIn("giao thức 1", out)

    def test_doctor_bad_key_fails(self):
        code, out, _ = self.run_cli(["--env-file", self.write_env(key="mh_wrong_wrong_wrong"), "doctor"], {})
        self.assertNotEqual(code, 0)
        self.assertNotIn("mh_wrong_wrong_wrong", out)
        self.assertIn("UNAUTHORIZED", out)

    def test_doctor_pin_mismatch_fails(self):
        code, out, _ = self.run_cli(["--env-file", self.write_env(pin="2" * 64), "doctor"], {})
        self.assertNotEqual(code, 0)
        self.assertIn("Ghim chứng chỉ TLS", out)

    def test_doctor_missing_config_fails(self):
        code, out, _ = self.run_cli(["doctor"], {})
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("Cấu hình", out)


def make_pair_code(url, pin, ticket=PAIR_TICKET, name="bot-test"):
    raw = json.dumps({"u": url, "f": pin, "t": ticket, "n": name}).encode("utf-8")
    return "mhp1." + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class PairTests(BridgeTestCase):
    def pair_requests(self):
        return [r for r in self.hub.requests if r["path"] == "/v1/pair"]

    def run_pair(self, code, directory):
        return self.run_cli(["pair", code, "--dir", directory], {})

    def test_decode_pairing_code_roundtrip_and_errors(self):
        info = bridge.decode_pairing_code(make_pair_code("https://h.example:47321", PIN))
        self.assertEqual(info, {"url": "https://h.example:47321", "pin": PIN, "ticket": PAIR_TICKET, "name": "bot-test"})

        def b64(obj):
            return "mhp1." + base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")

        good = {"u": "https://h:1", "f": PIN, "t": PAIR_TICKET, "n": "x"}
        bad_codes = [
            "xyz." + make_pair_code("https://h:1", PIN)[5:],
            "mhp1.!!!not-base64!!!",
            "mhp1." + base64.urlsafe_b64encode(b"not json").decode("ascii"),
            b64([1, 2]),
            b64(dict(good, u="http://h:1")),
            b64(dict(good, f="zz")),
            b64(dict(good, t="short")),
            b64(dict(good, n=5)),
            b64(dict((k, v) for k, v in good.items() if k != "t")),
        ]
        for code in bad_codes:
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.decode_pairing_code(code)
            self.assertEqual(ctx.exception.code, "CONFIG", code)

    def test_pair_sends_no_authorization_and_pins_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, _ = self.run_pair(make_pair_code(self.hub.url, "1" * 64), tmp)
            self.assertEqual(code, bridge.EXIT_NETWORK)
            self.assertEqual(self.pair_requests(), [])
            self.assertFalse(os.path.exists(os.path.join(tmp, ".env")))
            code, _, _ = self.run_pair(make_pair_code(self.hub.url, PIN), tmp)
            self.assertEqual(code, 0)
        sent = self.pair_requests()
        self.assertEqual(len(sent), 1)
        self.assertNotIn("Authorization", sent[0]["headers"])
        self.assertEqual(json.loads(sent[0]["body"].decode("utf-8")), {"ticket": PAIR_TICKET})

    def test_pair_writes_env_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, _ = self.run_pair(make_pair_code(self.hub.url, PIN), tmp)
            self.assertEqual(code, 0)
            path = os.path.join(tmp, ".env")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(bridge.parse_env_file(path), {"MAIHUB_URL": self.hub.url, "MAIHUB_CERT_SHA256": PIN, "MAIHUB_API_KEY": API_KEY})
            self.assertEqual(os.listdir(tmp), [".env"])  # không để lại tệp tạm

    def test_pair_output_masks_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = self.run_pair(make_pair_code(self.hub.url, PIN), tmp)
        self.assertEqual(code, 0)
        self.assertNotIn(API_KEY, out + err)
        self.assertIn("MAIHUB_API_KEY=" + bridge.mask_key(API_KEY), out)
        self.assertIn("MAIHUB_URL=" + self.hub.url, out)

    def test_pair_401_exit_code(self):
        self.hub.pair_tickets.clear()
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = self.run_pair(make_pair_code(self.hub.url, PIN), tmp)
            self.assertFalse(os.path.exists(os.path.join(tmp, ".env")))
        self.assertEqual(code, bridge.EXIT_SERVER_ERROR)
        self.assertIn("UNAUTHORIZED", err)
        self.assertIn("Vé không hợp lệ", err)

    def test_pair_bad_code_is_config_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = self.run_pair("garbage", tmp)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("CONFIG", err)

    def test_write_env_file_chowns_only_with_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            with mock.patch("os.chown") as chown:
                bridge.write_env_file(path, {"A": "1"})
                chown.assert_not_called()
                bridge.write_env_file(path, {"A": "2"}, uid=1234, gid=5678)
                chown.assert_called_once()
                self.assertEqual(chown.call_args[0][1:], (1234, 5678))
            self.assertEqual(bridge.parse_env_file(path), {"A": "2"})


UNIT_TEMPLATE = """[Service]
Type=simple
User=%(user)s
Environment=HOME=/home/%(user)s
%(env_line)s
ExecStart=/usr/local/sbin/ahv-bot-run-linux.sh x
"""


class FakeRun(object):
    def __init__(self, fail_on=None, timeout_on=None, fail_code=1):
        self.fail_code = fail_code
        self.timeout_on = timeout_on
        self.calls = []
        self.fail_on = fail_on

    def __call__(self, cmd, **kwargs):
        self.calls.append((list(cmd), kwargs))
        if self.timeout_on and self.timeout_on in cmd:
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
        code = self.fail_code if self.fail_on and self.fail_on in cmd else 0
        return mock.Mock(returncode=code, stdout="[OK] doctor\n")


class InstallFixture(BridgeTestCase):
    """Fixture dùng chung, không chứa test."""

    def setUp(self):
        BridgeTestCase.setUp(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.systemd = os.path.join(self.tmp.name, "systemd")
        os.mkdir(self.systemd)
        self.home = os.path.join(self.tmp.name, "home")
        os.mkdir(self.home)
        self.install_root = os.path.join(self.tmp.name, "opt")
        # Thư mục tạm thuộc user thường: mặc định coi là "đáng tin" (root sở hữu); test từ chối ghi đè lại.
        trusted = mock.patch.object(bridge, "_is_root_trusted_dir", return_value=True)
        self.trusted = trusted.start()
        self.addCleanup(trusted.stop)
        self.proxy_file = os.path.join(self.tmp.name, "telegram-proxy.url")  # không tồn tại theo mặc định
        proxy = mock.patch.object(bridge, "TELEGRAM_PROXY_FILE", self.proxy_file)
        proxy.start()
        self.addCleanup(proxy.stop)

    def add_bot(self, service, user, quoted=False, token=True):
        data_dir = os.path.join(self.tmp.name, "data-" + service)
        os.makedirs(data_dir, exist_ok=True)
        with open(os.path.join(data_dir, ".env"), "w") as handle:
            handle.write("TG_TOKEN=secret-token\n" if token else "OTHER=1\n")
        line = 'Environment="AHV_BOT_DATA_DIR=%s"' % data_dir if quoted else "Environment=AHV_BOT_DATA_DIR=%s" % data_dir
        with open(os.path.join(self.systemd, service + ".service"), "w") as handle:
            handle.write(UNIT_TEMPLATE % {"user": user, "env_line": line})
        return data_dir

    def args(self, **over):
        ns = dict(code=make_pair_code(self.hub.url, PIN), install=True, bot=None, cli=None, no_watch=False, skip_telegram_check=False, dir=os.path.join(self.install_root, "bot1"))
        ns.update(over)
        return mock.Mock(**ns)

    def pw(self, name):
        if name != "claudeproxy" and name != "codexproxy":
            raise KeyError(name)
        return mock.Mock(pw_dir=self.home, pw_uid=1234, pw_gid=5678)

    def install(self, run, euid=0, **over):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), mock.patch("os.chown") as chown:
            code = bridge.cmd_pair(self.args(**over), run=run, geteuid=lambda: euid, systemd_dir=self.systemd, getpwnam=self.pw)
        self.chown = chown
        return code, out.getvalue(), err.getvalue()


class InstallTests(InstallFixture):
    def test_find_ahv_bots_zero_one_two(self):
        self.assertEqual(bridge.find_ahv_bots(self.systemd), [])
        data_dir = self.add_bot("tg-claude-bot-a", "claudeproxy")
        self.add_bot("no-token", "claudeproxy", token=False)
        with open(os.path.join(self.systemd, "other.service"), "w") as handle:
            handle.write("[Service]\nUser=root\n")
        self.assertEqual(bridge.find_ahv_bots(self.systemd), [{"service": "tg-claude-bot-a", "user": "claudeproxy", "data_dir": data_dir}])
        self.add_bot("tg-codex-bot-b", "codexproxy", quoted=True)
        self.assertEqual([b["service"] for b in bridge.find_ahv_bots(self.systemd)], ["tg-claude-bot-a", "tg-codex-bot-b"])

    def test_infer_cli(self):
        self.assertEqual(bridge.infer_cli({"user": "claudeproxy", "service": "x"}), "claude")
        self.assertEqual(bridge.infer_cli({"user": "codexproxy", "service": "x"}), "codex")
        self.assertEqual(bridge.infer_cli({"user": "u", "service": "tg-codex-bot"}), "codex")
        self.assertEqual(bridge.infer_cli({"user": "u", "service": "tg-claude-bot"}), "claude")
        self.assertEqual(bridge.infer_cli({"user": "claudeproxy", "service": "x"}, "codex"), "codex")
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.infer_cli({"user": "u", "service": "bot"})
        self.assertEqual(ctx.exception.code, "CONFIG")
        self.assertIn("--cli", ctx.exception.message)

    def test_register_mcp_commands(self):
        run = FakeRun()
        bridge.register_mcp("claude", "claudeproxy", "/d/maihub_bridge.py", "/d/.env", run, "/home/c")
        server = ["python3", "-I", "/d/maihub_bridge.py", "mcp", "--env-file", "/d/.env"]
        self.assertEqual(run.calls[0][0], ["sudo", "-u", "claudeproxy", "-H", "claude", "mcp", "remove", "maihub", "-s", "user"])
        self.assertEqual(run.calls[1][0], ["sudo", "-u", "claudeproxy", "-H", "claude", "mcp", "add", "--scope", "user", "maihub", "--"] + server)
        self.assertEqual(run.calls[1][1]["cwd"], "/home/c")
        run = FakeRun()
        bridge.register_mcp("codex", "codexproxy", "/d/maihub_bridge.py", "/d/.env", run, "/home/x")
        self.assertEqual(run.calls[0][0], ["sudo", "-u", "codexproxy", "-H", "codex", "mcp", "remove", "maihub"])
        self.assertEqual(run.calls[1][0], ["sudo", "-u", "codexproxy", "-H", "codex", "mcp", "add", "maihub", "--"] + server)

    def test_register_mcp_ignores_remove_failure_but_not_add_failure(self):
        bridge.register_mcp("codex", "u", "/b", "/e", FakeRun(fail_on="remove"), self.home)
        with self.assertRaises(bridge.BridgeError):
            bridge.register_mcp("codex", "u", "/b", "/e", FakeRun(fail_on="add"), self.home)

    def test_backup_does_not_overwrite(self):
        install_dir = os.path.join(self.tmp.name, "inst")
        os.mkdir(install_dir)
        config = os.path.join(self.home, ".claude.json")
        with open(config, "w") as handle:
            handle.write("v1")
        self.assertTrue(bridge.backup_cli_config("claude", self.home, install_dir))
        with open(config, "w") as handle:
            handle.write("v2")
        self.assertFalse(bridge.backup_cli_config("claude", self.home, install_dir))
        with open(os.path.join(install_dir, ".claude.json.before-maihub")) as handle:
            self.assertEqual(handle.read(), "v1")
        self.assertFalse(bridge.backup_cli_config("codex", self.home, install_dir))  # chưa có cấu hình codex

    def test_install_requires_root(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        run = FakeRun()
        code, _, err = self.install(run, euid=1000)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("Cần chạy bằng root", err)
        self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(self.install_root))

    def test_install_multiple_bots_without_bot_changes_nothing(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        self.add_bot("tg-codex-bot-b", "codexproxy")
        run = FakeRun()
        code, _, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("tg-claude-bot-a", err)
        self.assertIn("tg-codex-bot-b", err)
        self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(self.install_root))
        self.assertEqual(self.hub.requests, [])

    def test_install_no_bot_found(self):
        run = FakeRun()
        code, _, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("không có --install", err)
        self.assertFalse(os.path.exists(self.install_root))

    def test_install_full_flow(self):
        data_dir = self.add_bot("tg-claude-bot-a", "claudeproxy")
        self.add_bot("tg-codex-bot-b", "codexproxy")
        with open(os.path.join(self.home, ".claude.json"), "w") as handle:
            handle.write("{}")
        run = FakeRun()
        code, out, err = self.install(run, bot="tg-claude-bot-a")
        self.assertEqual(code, 0, out + err)
        install_dir = self.args().dir
        env_path = os.path.join(install_dir, ".env")
        self.assertEqual(bridge.parse_env_file(env_path)["MAIHUB_API_KEY"], API_KEY)
        self.assertEqual(os.stat(env_path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(install_dir).st_mode & 0o777, 0o750)
        self.assertEqual(os.stat(os.path.join(install_dir, "state")).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(install_dir, "maihub_bridge.py")).st_mode & 0o777, 0o640)
        chowned = dict((c[0][0], c[0][1:]) for c in self.chown.call_args_list)
        self.assertEqual(chowned[install_dir], (0, 5678))
        self.assertEqual(chowned[os.path.join(install_dir, "maihub_bridge.py")], (0, 5678))
        self.assertEqual(chowned[os.path.join(install_dir, "state")], (1234, 5678))
        self.assertTrue(any(c[0][1:] == (1234, 5678) and ".env." in c[0][0] for c in self.chown.call_args_list))
        self.assertTrue(os.path.exists(os.path.join(install_dir, ".claude.json.before-maihub")))
        self.assertEqual(len(run.calls), 8)  # doctor, mcp remove/add, watch dry-run, check-telegram, daemon-reload, enable, restart
        self.assertEqual(run.calls[0][0], ["sudo", "-u", "claudeproxy", "-H", "python3", "-I", os.path.join(install_dir, "maihub_bridge.py"), "doctor", "--env-file", env_path])
        self.assertEqual(run.calls[0][1]["cwd"], self.home)
        self.assertEqual(run.calls[2][1]["cwd"], self.home)
        self.assertIn(os.path.join(install_dir, "maihub_bridge.py"), run.calls[2][0])
        self.assertEqual(run.calls[4][1]["timeout"], bridge.TELEGRAM_CHECK_SAFETY_SEC)
        for call in run.calls[:3] + run.calls[5:]:
            self.assertEqual(call[1]["timeout"], bridge.RUN_TIMEOUT)
        self.assertIn("mcp remove maihub -s user", out)
        self.assertIn("sudo rm -rf " + install_dir, out)
        self.assertIn(install_dir, out)
        self.assertNotIn(API_KEY, out + err)
        self.assertNotIn("secret-token", out + err)
        self.assertTrue(os.path.isdir(data_dir))

    def test_install_codex_inferred_from_user_and_cli_override(self):
        self.add_bot("bot-one", "codexproxy")
        run = FakeRun()
        code, out, err = self.install(run)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(run.calls[2][0][4], "codex")

    def test_install_unknown_user_changes_nothing(self):
        self.add_bot("tg-codex-bot", "ghostuser")
        run = FakeRun()
        code, _, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("ghostuser", err)
        self.assertEqual(self.hub.requests, [])
        self.assertFalse(os.path.exists(self.install_root))

    def test_install_register_failure_reports_step(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        code, _, err = self.install(FakeRun(fail_on="add"))
        self.assertNotEqual(code, 0)
        self.assertIn("đăng ký MCP", err)

    def test_install_relative_dir_registers_absolute_paths(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, cwd)
        run = FakeRun()
        code, out, err = self.install(run, dir="rel/inst")
        self.assertEqual(code, 0, out + err)
        absolute = os.path.join(os.path.realpath(self.tmp.name), "rel", "inst")
        add = run.calls[2][0]
        self.assertTrue(os.path.realpath(add[add.index("-I") + 1]) == os.path.join(absolute, "maihub_bridge.py"))
        self.assertTrue(os.path.isabs(add[-1]))
        self.assertTrue(os.path.isabs(run.calls[0][0][6]))

    def test_install_rerun_replaces_env_and_keeps_backup(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        config = os.path.join(self.home, ".claude.json")
        with open(config, "w") as handle:
            handle.write("original")
        run = FakeRun()
        code, out, err = self.install(run)
        self.assertEqual(code, 0, out + err)
        install_dir = self.args().dir
        with open(config, "w") as handle:
            handle.write("modified-by-mcp-add")
        self.hub.pair_tickets.add(PAIR_TICKET)
        self.hub.pair_api_key = "mh_second_key_1234567890"
        code, out, err = self.install(run)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(sorted(os.listdir(install_dir)), [".claude.json.before-maihub", ".env", "maihub_bridge.py", "state"])
        with open(os.path.join(install_dir, ".claude.json.before-maihub")) as handle:
            self.assertEqual(handle.read(), "original")
        self.assertEqual(len(run.calls), 16)
        verbs = [c[0][6] for c in run.calls if len(c[0]) > 6 and c[0][5] == "mcp"]
        self.assertEqual(verbs, ["remove", "add", "remove", "add"])
        self.assertEqual(bridge.parse_env_file(os.path.join(install_dir, ".env"))["MAIHUB_API_KEY"], "mh_second_key_1234567890")

    def test_install_doctor_failure_and_timeout_stop_before_mcp(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        run = FakeRun(fail_on="doctor")
        code, _, err = self.install(run)
        self.assertNotEqual(code, 0)
        self.assertIn("doctor", err)
        self.assertEqual(len(run.calls), 1)
        self.hub.pair_tickets.add(PAIR_TICKET)
        run = FakeRun(timeout_on="add")
        code, _, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_NETWORK)
        self.assertIn("đăng ký MCP", err)

    def test_backup_created_0600_and_refuses_symlink(self):
        install_dir = os.path.join(self.tmp.name, "inst2")
        os.mkdir(install_dir)
        with open(os.path.join(self.home, ".codex_cfg"), "w") as handle:
            handle.write("x")
        os.mkdir(os.path.join(self.home, ".codex"))
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as handle:
            handle.write("c")
        os.symlink(os.path.join(self.tmp.name, "victim"), os.path.join(install_dir, "config.toml.before-maihub"))
        self.assertFalse(bridge.backup_cli_config("codex", self.home, install_dir))  # liên kết đã tồn tại thì bỏ qua
        os.unlink(os.path.join(install_dir, "config.toml.before-maihub"))
        self.assertTrue(bridge.backup_cli_config("codex", self.home, install_dir))
        self.assertEqual(os.stat(os.path.join(install_dir, "config.toml.before-maihub")).st_mode & 0o777, 0o600)


class PairHardeningTests(BridgeTestCase):
    def test_ticket_regex_rejects_trailing_newline(self):
        self.assertIsNone(bridge.PAIR_TICKET_RE.match(PAIR_TICKET + "\n"))
        self.assertIsNotNone(bridge.PAIR_TICKET_RE.match(PAIR_TICKET))

    def test_write_env_file_uses_mkstemp_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            with mock.patch("tempfile.mkstemp", wraps=tempfile.mkstemp) as mk:
                bridge.write_env_file(path, {"A": "1"})
            self.assertEqual(mk.call_args[1], {"dir": tmp, "prefix": ".env."})
            with mock.patch("os.chown", side_effect=OSError("denied")):
                with self.assertRaises(OSError):
                    bridge.write_env_file(path, {"A": "2"}, uid=1, gid=1)
            self.assertEqual(os.listdir(tmp), [".env"])
            self.assertEqual(bridge.parse_env_file(path), {"A": "1"})

    def test_env_write_failure_after_consume_mentions_revoke(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "nope")
            code, _, err = self.run_cli(["pair", make_pair_code(self.hub.url, PIN), "--dir", missing], {})
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("thu hồi", err)
        self.assertIn("mã ghép nối mới", err)


    def test_repair_merges_env_keeping_other_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            with open(path, "w") as handle:
                handle.write("# ghi chú\nTELEGRAM_PROXY=http://u:p@px:3128\nMAIHUB_API_KEY=old\nexport MAIHUB_URL=https://old\n"
                             "MAIHUB_NOTIFY_CHAT_ID=-100\nMAIHUB_API_KEY=dup\n")
            code, _, err = self.run_cli(["pair", make_pair_code(self.hub.url, PIN), "--dir", tmp], {})
            self.assertEqual(code, 0, err)
            with open(path) as handle:
                lines = handle.read().splitlines()
            self.assertEqual(lines, ["# ghi chú", "TELEGRAM_PROXY=http://u:p@px:3128", "MAIHUB_API_KEY=" + API_KEY,
                                     "MAIHUB_URL=" + self.hub.url, "MAIHUB_NOTIFY_CHAT_ID=-100", "MAIHUB_CERT_SHA256=" + PIN])
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_pair_refuses_env_with_tg_token_before_using_ticket(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            with open(path, "w") as handle:
                handle.write("TG_TOKEN=123:abc\nALLOWED_CHAT_ID=1\n")
            code, _, err = self.run_cli(["pair", make_pair_code(self.hub.url, PIN), "--dir", tmp], {})
            self.assertEqual(code, bridge.EXIT_CONFIG)
            self.assertIn("TG_TOKEN", err)
            self.assertNotIn("123:abc", err)
            with open(path) as handle:
                self.assertEqual(handle.read(), "TG_TOKEN=123:abc\nALLOWED_CHAT_ID=1\n")
        self.assertEqual([r for r in self.hub.requests if r["path"] == "/v1/pair"], [])

    def test_pair_tells_to_restart_existing_watch_service(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as systemd:
            open(os.path.join(systemd, "maihub-watch-tg-bot.service"), "w").close()
            open(os.path.join(systemd, "other.service"), "w").close()
            out = io.StringIO()
            with mock.patch("sys.stdout", out), mock.patch("sys.stderr", io.StringIO()):
                bridge.cmd_pair(mock.Mock(install=False, code=make_pair_code(self.hub.url, PIN), dir=tmp), systemd_dir=systemd)
        self.assertIn("systemctl restart maihub-watch-tg-bot.service", out.getvalue())
        self.assertNotIn("other.service", out.getvalue())


# ---------------------------------------------------------------- watch

TG_TOKEN = "123456:SECRET-token-ABC"


class FakeClock(object):
    def __init__(self, now=1000000.0):
        self.now = now
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


class FakeWatchClient(object):
    """events.wait theo kịch bản: phần tử là dict kết quả hoặc Exception."""

    def __init__(self, script, runs=None):
        self.script = list(script)
        self.calls = []
        self.runs = runs or {}
        self.status = {"workspace": None}  # trả lời system.status (không lấy từ script events.wait)

    def call(self, method, params=None, idempotency_key=None):
        self.calls.append((method, params))
        if method == "system.status":
            if isinstance(self.status, Exception):
                raise self.status
            return self.status
        if method == "runs.get":
            item = self.runs.get(params["runId"])
            if isinstance(item, Exception):
                raise item
            return item
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeSender(object):
    def __init__(self, fail_after=None):
        self.sent = []
        self.fail_after = fail_after

    def send(self, text):
        if self.fail_after is not None and len(self.sent) >= self.fail_after:
            raise RuntimeError("crash")
        self.sent.append(text)
        return True


def finished(seq, **over):
    payload = {"runId": "r%d" % seq, "kind": "post", "status": "done", "scheduleId": None, "scheduleName": None,
               "posted": 2, "failed": 0, "skipped": 0}
    payload.update(over)
    return {"seq": seq, "type": "run.finished", "payload": payload, "createdAt": 1}


def page(events, workspace="ws1"):
    return {"events": events, "workspaceId": workspace}


class FormatEventTests(unittest.TestCase):
    def fmt(self, event, runs=None):
        def fetch(run_id):
            item = (runs or {}).get(run_id)
            if item is None or isinstance(item, Exception):
                raise item or RuntimeError("no run")
            return item
        return bridge.format_event(event, fetch)

    def test_done_labels(self):
        self.assertEqual(self.fmt(finished(1)), "✅ Đăng ngay: xong 2/2")
        self.assertEqual(self.fmt(finished(1, scheduleName="Sáng", skipped=1)), "✅ Sáng: xong 2/3")
        self.assertEqual(self.fmt(finished(1, kind="join")), "✅ Tham gia nhóm: xong 2/2")
        self.assertEqual(self.fmt(finished(1, kind="scan_groups")), "✅ Quét nhóm: xong 2/2")
        self.assertEqual(self.fmt(finished(1, kind="collect_comments")), "✅ Thu bình luận: xong 2/2")
        self.assertEqual(self.fmt(finished(1, kind="join", scheduleName="Lịch A")), "✅ Lịch A: xong 2/2")

    def test_failed_includes_up_to_three_error_lines(self):
        results = [{"outcome": "failed", "targetName": "Nhóm %d" % i, "error": "Lỗi %d" % i} for i in range(5)]
        results.insert(0, {"outcome": "posted", "targetName": "OK", "error": ""})
        text = self.fmt(finished(1, posted=1, failed=5), {"r1": {"run": {}, "results": results}})
        lines = text.split("\n")
        self.assertEqual(lines[0], "⚠️ Đăng ngay: xong 1/6, lỗi 5")
        self.assertEqual(lines[1:], ["• Nhóm 0: Lỗi 0", "• Nhóm 1: Lỗi 1", "• Nhóm 2: Lỗi 2"])

    def test_failed_when_runs_get_raises_sends_head_only(self):
        text = self.fmt(finished(1, posted=0, failed=2), {"r1": bridge.BridgeError("UNREACHABLE", "x")})
        self.assertEqual(text, "⚠️ Đăng ngay: xong 0/2, lỗi 2")

    def test_run_level_failure_without_failed_targets(self):
        text = self.fmt(finished(1, status="failed", posted=0))
        self.assertTrue(text.startswith("⚠️ Đăng ngay: "))

    def test_cancelled(self):
        self.assertEqual(self.fmt(finished(1, status="cancelled", posted=1, failed=1)), "⏹ Đăng ngay: đã huỷ (1/2)")

    def test_missed_and_login_problem(self):
        missed = {"seq": 1, "type": "schedule.missed", "payload": {"name": "Tối", "reason": "App tắt lúc đến giờ"}}
        self.assertEqual(self.fmt(missed), "⏰ Lỡ lịch \"Tối\": App tắt lúc đến giờ")
        out = {"seq": 2, "type": "profile.loginProblem", "payload": {"profileName": "Mai", "state": "logged_out"}}
        self.assertEqual(self.fmt(out), "🔒 Profile \"Mai\": hết phiên đăng nhập\nMở MaiHub để đăng nhập lại.")
        cp = {"seq": 3, "type": "profile.loginProblem", "payload": {"profileName": "Mai", "state": "checkpoint"}}
        self.assertEqual(self.fmt(cp), "🔒 Profile \"Mai\": bị checkpoint\nMở MaiHub để đăng nhập lại.")

    def test_silent_types(self):
        for kind in ("run.started", "draft.approved", "profiles.checkFinished", "something.new"):
            self.assertIsNone(self.fmt({"seq": 1, "type": kind, "payload": {}}))

    def test_truncation(self):
        long = "x" * 500
        missed = {"seq": 1, "type": "schedule.missed", "payload": {"name": long, "reason": long}}
        text = self.fmt(missed)
        self.assertLessEqual(len(text), 3500)
        self.assertNotIn("x" * 201, text)
        results = [{"outcome": "failed", "targetName": long, "error": long}] * 3
        text = self.fmt(finished(1, posted=0, failed=3), {"r1": {"results": results}})
        self.assertNotIn("x" * 201, text)
        self.assertLessEqual(len(text), 3500)
        self.assertEqual(len(bridge.clip("y" * 5000, 3500)), 3500)


class FormatDoneWithoutCountsTests(unittest.TestCase):
    def test_done_with_zero_total_has_no_counts(self):
        text = bridge.format_event(finished(1, kind="scan_groups", posted=0, failed=0, skipped=0), lambda r: None)
        self.assertEqual(text, "✅ Quét nhóm: xong")
        self.assertEqual(bridge.format_event(finished(2), lambda r: None), "✅ Đăng ngay: xong 2/2")


class FormatTrackFinishedTests(unittest.TestCase):
    def fmt(self, **over):
        payload = {"jobId": "j1", "auto": False, "cancelled": False, "groups": 3, "checked": 8, "found": 5,
                   "linked": 2, "removedSuspected": 1, "notFound": 0, "errors": 0}
        payload.update(over)
        return bridge.format_event({"seq": 1, "type": "posts.trackFinished", "payload": payload, "createdAt": 1}, lambda r: None)

    def test_reports_links_and_suspected_removals(self):
        self.assertEqual(self.fmt(), "📈 Theo dõi bài: kiểm tra 3 nhóm, lấy được 2 link, 1 bài có thể đã bị xoá")
        self.assertEqual(self.fmt(auto=True, linked=0), "📈 Theo dõi bài: kiểm tra 3 nhóm, lấy được 0 link, 1 bài có thể đã bị xoá")
        self.assertEqual(self.fmt(auto=True, removedSuspected=0), "📈 Theo dõi bài: kiểm tra 3 nhóm, lấy được 2 link, 0 bài có thể đã bị xoá")

    def test_silent_when_nothing_new(self):
        self.assertIsNone(self.fmt(linked=0, removedSuspected=0))
        self.assertIsNone(self.fmt(auto=True, linked=0, removedSuspected=0, found=4))


class FormatLeadsFoundTests(unittest.TestCase):
    def fmt(self, **over):
        payload = {"count": 2, "auto": True, "samples": [
            {"authorName": "Lan", "text": "giá bao nhiêu vậy shop", "postUrl": "u1"},
            {"authorName": "Hoa", "text": "ib mình nhé", "postUrl": "u2"}]}
        payload.update(over)
        return bridge.format_event({"seq": 1, "type": "leads.found", "payload": payload, "createdAt": 1}, lambda r: None)

    def test_lists_samples(self):
        self.assertEqual(self.fmt(), "🎯 2 khách tiềm năng mới\nLan: giá bao nhiêu vậy shop\nHoa: ib mình nhé")

    def test_silent_without_leads(self):
        self.assertIsNone(self.fmt(count=0, samples=[]))
        self.assertIsNone(self.fmt(count=None))

    def test_long_text_clipped_to_80_and_only_three_lines(self):
        samples = [{"authorName": "N%d" % i, "text": "x" * 200, "postUrl": "u"} for i in range(5)]
        lines = self.fmt(count=5, samples=samples).split("\n")
        self.assertEqual(lines[0], "🎯 5 khách tiềm năng mới")
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[1], "N0: " + "x" * 79 + "…")

    def test_bool_count_is_not_a_count(self):
        self.assertIsNone(self.fmt(count=True))

    def test_newlines_in_sample_text_become_spaces(self):
        self.assertEqual(self.fmt(count=1, samples=[{"authorName": "Lan\n", "text": "giá\nbao nhiêu\r\n vậy"}]), "🎯 1 khách tiềm năng mới\nLan: giá bao nhiêu vậy")

    def test_tolerates_missing_fields(self):
        self.assertEqual(self.fmt(count=1, samples=[{}, "bad"]), "🎯 1 khách tiềm năng mới")
        self.assertEqual(self.fmt(count=1, samples=None), "🎯 1 khách tiềm năng mới")
        self.assertEqual(self.fmt(count=1, samples=[{"authorName": "Lan"}]), "🎯 1 khách tiềm năng mới\nLan: ")


class NotifyTargetTests(unittest.TestCase):
    def test_notify_target_priority(self):
        bot = {"TG_TOKEN": TG_TOKEN, "ALLOWED_CHAT_ID": "-100,-200", "ALLOWED_TOPIC_ID": "7", "ADMIN_USER_ID": "9"}
        self.assertEqual(bridge.resolve_notify_target({"MAIHUB_NOTIFY_CHAT_ID": "55"}, bot),
                         {"token": TG_TOKEN, "chat_id": "55", "thread_id": None})
        self.assertEqual(bridge.resolve_notify_target({}, bot), {"token": TG_TOKEN, "chat_id": "-100", "thread_id": 7})
        del bot["ALLOWED_CHAT_ID"]
        self.assertEqual(bridge.resolve_notify_target({}, bot), {"token": TG_TOKEN, "chat_id": "9", "thread_id": None})

    def test_notify_target_errors_never_contain_token(self):
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.resolve_notify_target({}, {"TG_TOKEN": TG_TOKEN})
        self.assertEqual(ctx.exception.code, "CONFIG")
        self.assertNotIn(TG_TOKEN, str(ctx.exception))
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.resolve_notify_target({}, {"ADMIN_USER_ID": "1"})
        self.assertIn("TG_TOKEN", str(ctx.exception))

    def test_route(self):
        self.assertEqual(bridge.resolve_telegram_route({}), {"api_base": "https://api.telegram.org", "proxy": None})
        self.assertEqual(bridge.resolve_telegram_route({"TELEGRAM_API_BASE": "https://tg.example/"}),
                         {"api_base": "https://tg.example", "proxy": None})
        self.assertEqual(bridge.resolve_telegram_route({"TELEGRAM_PROXY": "http://127.0.0.1:3128"})["proxy"], "http://127.0.0.1:3128")
        self.assertEqual(bridge.resolve_telegram_route({"TELEGRAM_API_BASE": "https://a", "TELEGRAM_PROXY": "http://p"})["proxy"], None)
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.resolve_telegram_route({"TELEGRAM_PROXY": "socks5://127.0.0.1:1080"})
        self.assertEqual(ctx.exception.code, "CONFIG")
        self.assertIn("SOCKS", str(ctx.exception))

    def test_api_base_must_be_https(self):
        for bad in ("http://tg.example", "tg.example", "ftp://x"):
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.resolve_telegram_route({"TELEGRAM_API_BASE": bad})
            self.assertEqual(ctx.exception.code, "CONFIG")
            self.assertIn("https://", ctx.exception.message)
        self.assertEqual(bridge.resolve_telegram_route({"TELEGRAM_API_BASE": "HTTPS://tg.example"})["api_base"], "HTTPS://tg.example")


class FakeResponse(object):
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def close(self):
        pass


class FakeOpener(object):
    def __init__(self, script):
        self.script = list(script)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def http_429(retry_after):
    import urllib.error
    body = json.dumps({"ok": False, "parameters": {"retry_after": retry_after}}).encode("utf-8")
    return urllib.error.HTTPError("https://x/bot%s/sendMessage" % TG_TOKEN, 429, "Too Many Requests", {}, io.BytesIO(body))


OK_BODY = FakeResponse(b'{"ok": true}')
ROUTE = {"api_base": "https://api.telegram.org", "proxy": None}


class TelegramSenderTests(unittest.TestCase):
    def make(self, script, thread_id=None):
        clock = FakeClock()
        opener = FakeOpener(script)
        target = {"token": TG_TOKEN, "chat_id": "42", "thread_id": thread_id}
        return bridge.TelegramSender(target, ROUTE, sleep=clock.sleep, opener=opener), opener, clock

    def test_check_calls_get_me_once_and_masks_token(self):
        sender, opener, clock = self.make([OK_BODY])
        self.assertEqual(sender.check(), (True, ""))
        self.assertEqual(opener.requests[0].full_url, "https://api.telegram.org/bot%s/getMe" % TG_TOKEN)
        sender, opener, clock = self.make([OSError("conn %s refused" % TG_TOKEN)])
        ok, detail = sender.check()
        self.assertFalse(ok)
        self.assertNotIn(TG_TOKEN, detail)
        self.assertEqual(clock.slept, [])  # không thử lại
        sender, _, _ = self.make([FakeResponse(b'{"ok": false}')])
        self.assertFalse(sender.check()[0])

    def test_request_shape(self):
        sender, opener, _ = self.make([OK_BODY], thread_id=7)
        self.assertTrue(sender.send("xin chào"))
        req = opener.requests[0]
        self.assertEqual(req.full_url, "https://api.telegram.org/bot%s/sendMessage" % TG_TOKEN)
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body, {"chat_id": "42", "text": "xin chào", "disable_web_page_preview": True, "message_thread_id": 7})

    def test_retries_then_succeeds(self):
        sender, opener, clock = self.make([OSError("boom"), OSError("boom"), OK_BODY])
        self.assertTrue(sender.send("a"))
        self.assertEqual(clock.slept, [2, 10])

    def test_drops_after_3_failures(self):
        sender, opener, clock = self.make([OSError("down %s" % TG_TOKEN)] * 4)
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            self.assertFalse(sender.send("a"))
        self.assertEqual(clock.slept, [2, 10, 30])
        self.assertEqual(len(opener.requests), 4)
        self.assertNotIn(TG_TOKEN, err.getvalue())
        self.assertNotIn(TG_TOKEN, repr(sender))

    def test_sender_429_retry_after(self):
        sender, opener, clock = self.make([http_429(17), OK_BODY])
        self.assertTrue(sender.send("a"))
        self.assertEqual(clock.slept, [17])

    def test_429_retry_after_is_capped(self):
        sender, _, clock = self.make([http_429(99999), OK_BODY])
        self.assertTrue(sender.send("a"))
        self.assertEqual(clock.slept, [300])

    def test_final_http_error_does_not_leak_token(self):
        sender, _, _ = self.make([http_429(1)] * 4)
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            self.assertFalse(sender.send("a"))
        self.assertIn("HTTP 429", err.getvalue())
        self.assertNotIn(TG_TOKEN, err.getvalue())

    def test_proxy_credentials_masked_in_log(self):
        sender, _, _ = self.make([OSError("tunnel via http://user:pw@10.0.0.1:3128 failed")] * 4)
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            sender.send("a")
        self.assertNotIn("user:pw", err.getvalue())
        self.assertIn("//***@10.0.0.1", err.getvalue())

    def test_ok_false_counts_as_failure(self):
        sender, _, clock = self.make([FakeResponse(b'{"ok": false}')] * 4)
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertFalse(sender.send("a"))


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = os.path.join(self.tmp.name, "state", "watch-state.json")
        self.clock = FakeClock()
        self.sender = FakeSender()

    def watcher(self, script, runs=None, sender=None):
        self.client = FakeWatchClient(script, runs)
        return bridge.Watcher(self.client, sender or self.sender, self.state_path, clock=self.clock, sleep=self.clock.sleep)

    def state(self):
        with open(self.state_path, "r") as handle:
            return json.load(handle)

    def test_first_run_skips_history(self):
        full = [finished(i) for i in range(1, 101)]
        w = self.watcher([page(full), page([finished(101)]), page([])])
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.state()["cursor"], 101)
        self.assertEqual(self.state()["workspaceId"], "ws1")
        self.assertEqual([c[1] for c in self.client.calls], [
            {"after": 0, "timeoutSec": 0}, {"after": 100, "timeoutSec": 0}, {"after": 101, "timeoutSec": 0}])

    def test_cursor_saved_after_each_send(self):
        w = self.watcher([page([]), page([finished(1), finished(2)])])
        w.step()
        w.step()
        self.assertEqual(len(self.sender.sent), 2)
        self.assertEqual(self.state()["cursor"], 2)
        self.assertEqual(self.client.calls[-1][1], {"after": 0, "timeoutSec": 25})
        self.assertEqual(os.listdir(os.path.dirname(self.state_path)), ["watch-state.json"])

    def test_crash_between_send_and_save_resends(self):
        w = self.watcher([page([]), page([finished(1), finished(2)])], sender=FakeSender(fail_after=1))
        w.step()
        with self.assertRaises(RuntimeError):
            w.step()  # gửi tin 1 xong, chết lúc gửi tin 2
        self.assertEqual(self.state()["cursor"], 1)
        # chết ngay sau khi gửi, trước khi lưu: con trỏ vẫn cũ nên gửi lại (ít nhất một lần)
        again = FakeSender()
        w2 = self.watcher([page([finished(2)])], sender=again)
        w2.step()
        self.assertEqual(len(again.sent), 1)
        self.assertEqual(self.state()["cursor"], 2)

    def test_silent_events_still_advance_cursor(self):
        w = self.watcher([page([]), page([{"seq": 1, "type": "run.started", "payload": {}}])])
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.state()["cursor"], 1)

    def test_workspace_change_jumps_to_latest_with_one_notice(self):
        w = self.watcher([page([finished(5)]), page([]), page([finished(1)], "ws2"), page([finished(9)], "ws2"), page([], "ws2")])
        w.step()  # lần đầu: cursor=5
        w.step()  # đổi workspace
        self.assertEqual(self.sender.sent, ["Đã chuyển workspace: ws2"])
        self.assertEqual(self.state()["cursor"], 9)
        self.assertEqual(self.state()["workspaceId"], "ws2")

    def test_unreachable_299_no_alert_300_one_alert_recovery_one_message(self):
        err = bridge.BridgeError("UNREACHABLE", "Không kết nối được MaiHub")
        w = self.watcher([page([])] + [err] * 20 + [page([])])
        w.step()
        start = self.clock.now
        w.step()  # lỗi đầu: downSince = start
        self.assertEqual(self.state()["downSince"], start)
        self.clock.now = start + 299
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.clock.now = start + 300
        w.step()
        self.assertEqual(len(self.sender.sent), 1)
        self.assertTrue(self.sender.sent[0].startswith("⚠️ Không liên lạc được MaiHub"))
        self.assertIn("Không kết nối được MaiHub", self.sender.sent[0])
        self.clock.now = start + 400
        w.step()
        self.assertEqual(len(self.sender.sent), 1)
        self.assertEqual(self.clock.slept[-1], 15)
        self.clock.now = start + 600
        self.client.script = [page([])]
        w.step()
        self.assertEqual(self.sender.sent[1], "✅ MaiHub đã kết nối lại sau 10 phút")
        self.assertIsNone(self.state()["downSince"])
        self.assertFalse(self.state()["downAlerted"])
        self.client.script = [page([])]
        w.step()
        self.assertEqual(len(self.sender.sent), 2)

    def test_first_run_failure_does_not_create_state_or_replay_history(self):
        w = self.watcher([bridge.BridgeError("UNREACHABLE", "x"), page([finished(1), finished(2)]), page([])])
        w.step()
        self.assertFalse(os.path.exists(self.state_path))
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.state()["cursor"], 2)

    def test_null_workspace_keeps_cursor_and_sends_nothing(self):
        w = self.watcher([page([finished(5)]), page([]), page([], None), page([finished(6)], "ws1")])
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.state()["cursor"], 5)
        self.assertEqual(self.state()["workspaceId"], "ws1")
        w.step()
        self.assertEqual(len(self.sender.sent), 1)
        self.assertEqual(self.state()["cursor"], 6)
        self.assertNotIn("workspace", self.sender.sent[0])

    def test_hot_loop_guard_sleeps_on_instant_empty_wait(self):
        w = self.watcher([page([]), page([])])
        w.step()
        w.step()
        self.assertEqual(self.clock.slept, [1])

    def test_latest_stops_when_seq_does_not_advance(self):
        w = self.watcher([page([finished(3)]), page([finished(3)])])
        w.step()
        self.assertEqual(self.state()["cursor"], 3)
        self.assertEqual(len(self.client.calls), 2)

    def test_latest_missing_seq_is_bad_response(self):
        w = self.watcher([page([{"type": "run.finished", "payload": {}}])])
        w.step()
        self.assertFalse(os.path.exists(self.state_path))
        self.assertEqual(self.clock.slept, [15])

    def test_dry_run_does_not_persist_state(self):
        w = bridge.Watcher(FakeWatchClient([page([finished(1)]), page([]), page([finished(2)])]), self.sender,
                           self.state_path, clock=self.clock, sleep=self.clock.sleep, persist=False)
        w.step()
        w.step()
        self.assertEqual(len(self.sender.sent), 1)
        self.assertFalse(os.path.exists(os.path.dirname(self.state_path)))

    def test_state_file_mode_is_0600(self):
        w = self.watcher([page([])])
        w.step()
        self.assertEqual(os.stat(self.state_path).st_mode & 0o777, 0o600)

    def test_malformed_events_are_bad_response_not_crash(self):
        bad_pages = [page([{"type": "run.finished", "payload": {}}]), page(["oops"]), page([{"seq": True, "type": "x"}]),
                     page([{"seq": 3}]), {"events": "nope", "workspaceId": "ws1"}, "garbage"]
        w = self.watcher([page([finished(1)]), page([])] + bad_pages)
        w.step()
        for _ in bad_pages:
            w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.state()["cursor"], 1)
        self.assertIsNotNone(self.state()["downSince"])

    def test_short_outage_recovers_silently(self):
        err = bridge.BridgeError("UNREACHABLE", "x")
        w = self.watcher([page([]), err, page([])])
        w.step()
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, [])
        self.assertIsNone(self.state()["downSince"])

    def test_unauthorized_one_alert_then_300s(self):
        err = bridge.BridgeError("UNAUTHORIZED", "Khoá không hợp lệ", status=401)
        w = self.watcher([page([]), err, err, page([])])
        w.step()
        w.step()
        w.step()
        self.assertEqual(len(self.sender.sent), 1)
        self.assertTrue(self.sender.sent[0].startswith("🔑"))
        self.assertEqual(self.clock.slept, [300, 300])
        w.step()
        self.assertFalse(self.state()["authAlerted"])

    def test_auth_retry_reloads_client_so_repair_recovers(self):
        err = bridge.BridgeError("UNAUTHORIZED", "Khoá không hợp lệ", status=401)
        fresh = FakeWatchClient([page([finished(1)])])
        reloads = []
        w = self.watcher([page([]), err])
        w.reload_client = lambda: reloads.append(1) or fresh
        w.step()
        w.step()  # lỗi UNAUTHORIZED: báo, chờ 300 giây rồi nạp lại .env
        self.assertEqual(reloads, [1])
        self.assertIs(w.client, fresh)
        w.step()  # client mới (khoá mới) chạy được: gửi tin và xoá cờ
        self.assertEqual(len(self.sender.sent), 2)
        self.assertTrue(self.sender.sent[1].startswith("✅"))
        self.assertFalse(self.state()["authAlerted"])

    def test_auth_retry_keeps_old_client_when_reload_fails(self):
        err = bridge.BridgeError("PIN_MISMATCH", "lệch")
        w = self.watcher([page([]), err])
        old = w.client

        def broken():
            raise bridge.BridgeError("CONFIG", "Thiếu cấu hình")
        w.reload_client = broken
        w.step()
        w.step()
        self.assertIs(w.client, old)
        self.assertEqual(self.clock.slept, [300])

    def test_save_failure_keeps_cursor_and_does_not_crash(self):
        w = self.watcher([page([]), page([finished(1)])])
        w.step()
        err = io.StringIO()
        with mock.patch("tempfile.mkstemp", side_effect=OSError("No space left")), mock.patch("sys.stderr", err):
            w.step()
        self.assertEqual(w.state["cursor"], 1)
        self.assertEqual(len(self.sender.sent), 1)
        self.assertIn("No space left", err.getvalue())

    def test_workspace_notice_uses_name_from_system_status(self):
        w = self.watcher([page([finished(5)]), page([]), page([finished(1)], "ws2"), page([finished(9)], "ws2"), page([], "ws2")])
        self.client.status = {"workspace": {"id": "ws2", "name": "Cửa hàng B"}}
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, ["Đã chuyển workspace: Cửa hàng B"])

    def test_workspace_notice_falls_back_to_id_when_status_fails(self):
        w = self.watcher([page([finished(5)]), page([]), page([finished(1)], "ws2"), page([finished(9)], "ws2"), page([], "ws2")])
        self.client.status = bridge.BridgeError("UNREACHABLE", "x")
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, ["Đã chuyển workspace: ws2"])

    def test_pin_mismatch_alert(self):
        w = self.watcher([page([]), bridge.BridgeError("PIN_MISMATCH", "lệch")])
        w.step()
        w.step()
        self.assertTrue(self.sender.sent[0].startswith("🔐"))

    def test_failure_details_fetched_via_runs_get(self):
        runs = {"r1": {"results": [{"outcome": "failed", "targetName": "N", "error": "E"}]}}
        w = self.watcher([page([]), page([finished(1, posted=0, failed=1)])], runs)
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, ["⚠️ Đăng ngay: xong 0/1, lỗi 1\n• N: E"])

    def test_state_file_is_private_json(self):
        w = self.watcher([page([])])
        w.step()
        self.assertEqual(sorted(self.state()), ["authAlerted", "cursor", "downAlerted", "downSince", "workspaceId"])


class WatchCommandTests(BridgeTestCase):
    def test_dry_run_prints_and_never_leaks_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            maihub_env = os.path.join(tmp, "maihub.env")
            bot_env = os.path.join(tmp, "bot.env")
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=%s\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, API_KEY, PIN))
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            sender = bridge.PrintSender()
            out = io.StringIO()
            with mock.patch("sys.stdout", out):
                sender.send("xin chào")
            self.assertEqual(out.getvalue(), "xin chào\n")
            target = bridge.resolve_notify_target({}, bridge.parse_env_file(bot_env))
            self.assertEqual(target["chat_id"], "9")
            with mock.patch("maihub_bridge.Watcher.run_forever"):
                code, o, e = self.run_cli(["watch", "--env-file", maihub_env, "--notify-env", bot_env, "--dry-run"], {})
            self.assertEqual(code, 0)
            self.assertNotIn(TG_TOKEN, o + e)
            self.assertFalse(os.path.exists(os.path.join(tmp, "state")))  # dry-run không tạo/ghi trạng thái

    def test_dry_run_selects_print_sender(self):
        with tempfile.TemporaryDirectory() as tmp:
            maihub_env = os.path.join(tmp, "maihub.env")
            bot_env = os.path.join(tmp, "bot.env")
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=%s\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, API_KEY, PIN))
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            for flags, expected in (([], bridge.TelegramSender), (["--dry-run"], bridge.PrintSender)):
                with mock.patch("maihub_bridge.Watcher") as watcher:
                    code, _, _ = self.run_cli(["watch", "--env-file", maihub_env, "--notify-env", bot_env] + flags, {})
                self.assertEqual(code, 0)
                self.assertIsInstance(watcher.call_args[0][1], expected)
                self.assertEqual(watcher.call_args[1]["persist"], not flags)

    def test_watch_without_env_file_or_state_is_config_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bot_env = os.path.join(tmp, "bot.env")
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            code, o, e = self.run_cli(["watch", "--notify-env", bot_env], {})
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertNotIn(TG_TOKEN, o + e)

    def test_watch_with_only_state_reads_maihub_from_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            bot_env = os.path.join(tmp, "bot.env")
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            with mock.patch("maihub_bridge.Watcher") as watcher:
                code, _, _ = self.run_cli(["watch", "--notify-env", bot_env, "--state", os.path.join(tmp, "s", "w.json"), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(watcher.call_args[0][0].config.url, self.hub.url)

    def test_check_telegram_exit_codes_and_no_watcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            maihub_env = os.path.join(tmp, "maihub.env")
            bot_env = os.path.join(tmp, "bot.env")
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=%s\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, API_KEY, PIN))
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            argv = ["watch", "--env-file", maihub_env, "--notify-env", bot_env, "--check-telegram"]
            with mock.patch("maihub_bridge.Watcher") as watcher:
                with mock.patch.object(bridge.TelegramSender, "check", return_value=(True, "")):
                    code, o, e = self.run_cli(argv, {})
                self.assertEqual(code, 0)
                self.assertNotIn(TG_TOKEN, o + e)
                with mock.patch.object(bridge.TelegramSender, "check", return_value=(False, "URLError: down")):
                    code, o, e = self.run_cli(argv, {})
                self.assertEqual(code, bridge.EXIT_NETWORK)
                self.assertIn("down", e)
                self.assertNotIn(TG_TOKEN, o + e)
                watcher.assert_not_called()

    def test_watch_passes_reload_client_that_rereads_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            maihub_env = os.path.join(tmp, "maihub.env")
            bot_env = os.path.join(tmp, "bot.env")
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=old\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, PIN))
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\nADMIN_USER_ID=9\n" % TG_TOKEN)
            with mock.patch("maihub_bridge.Watcher") as watcher:
                self.run_cli(["watch", "--env-file", maihub_env, "--notify-env", bot_env], {})
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=new\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, PIN))
            self.assertEqual(watcher.call_args[1]["reload_client"]().config.api_key, "new")

    def test_missing_notify_target_is_config_error_without_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            maihub_env = os.path.join(tmp, "maihub.env")
            bot_env = os.path.join(tmp, "bot.env")
            with open(maihub_env, "w") as handle:
                handle.write("MAIHUB_URL=%s\nMAIHUB_API_KEY=%s\nMAIHUB_CERT_SHA256=%s\n" % (self.hub.url, API_KEY, PIN))
            with open(bot_env, "w") as handle:
                handle.write("TG_TOKEN=%s\n" % TG_TOKEN)
            code, o, e = self.run_cli(["watch", "--env-file", maihub_env, "--notify-env", bot_env], {})
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertNotIn(TG_TOKEN, o + e)

    def test_token_never_in_stderr_when_sending_fails(self):
        clock = FakeClock()
        opener = FakeOpener([OSError("conn %s" % TG_TOKEN)] * 4)
        sender = bridge.TelegramSender({"token": TG_TOKEN, "chat_id": "1", "thread_id": None}, ROUTE, sleep=clock.sleep, opener=opener)
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            sender.send("x")
        self.assertNotIn(TG_TOKEN, err.getvalue())


class InstallWatchTests(InstallFixture):
    def setUp(self):
        InstallTests.setUp(self)
        self.env_dir = os.path.join(self.tmp.name, "mh dir".replace(" ", "-"))
        os.mkdir(self.env_dir)
        self.env_file = os.path.join(self.env_dir, ".env")
        self.notify_env = os.path.join(self.tmp.name, "bot.env")
        for path in (self.env_file, self.notify_env):
            with open(path, "w") as handle:
                handle.write("X=1\n")

    def watch_args(self, **over):
        ns = dict(env_file=self.env_file, notify_env=self.notify_env, user="claudeproxy", state_dir=None, skip_telegram_check=False)
        ns.update(over)
        service = ns.pop("name", "tg-bot")
        args = mock.Mock(**ns)
        args.name = service  # Mock(name=...) nhận tên của mock, không phải thuộc tính
        return args

    def install_watch(self, run, euid=0, **over):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), mock.patch("os.chown") as chown:
            code = bridge.cmd_install_watch(self.watch_args(**over), run=run, geteuid=lambda: euid, systemd_dir=self.systemd, getpwnam=self.pw)
        self.chown = chown
        return code, out.getvalue(), err.getvalue()

    def unit_path(self, name="tg-bot"):
        return os.path.join(self.systemd, "maihub-watch-%s.service" % name)

    def test_unit_content(self):
        text = bridge.render_watch_unit("tg-bot", "claudeproxy", "/o/maihub_bridge.py", "/o/.env", "/d/.env", "/o/state")
        for line in ["After=network-online.target", "Wants=network-online.target", "Type=simple", "User=claudeproxy",
                     "ExecStart=/usr/bin/python3 -I /o/maihub_bridge.py watch --env-file /o/.env --notify-env /d/.env --state /o/state/watch-state.json",
                     "Restart=always", "RestartSec=10", "NoNewPrivileges=yes", "ProtectSystem=strict",
                     "ReadWritePaths=/o/state", "PrivateTmp=yes", "WantedBy=multi-user.target"]:
            self.assertIn(line + "\n", text)
        self.assertIn("tg-bot.service", text)

    def test_whitespace_path_rejected(self):
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.render_watch_unit("b", "u", "/o/b.py", "/o d/.env", "/d/.env", "/o/state")
        self.assertEqual(ctx.exception.code, "CONFIG")

    def test_install_watch_flow(self):
        run = FakeRun()
        code, out, err = self.install_watch(run)
        self.assertEqual(code, 0, out + err)
        state = os.path.join(self.env_dir, "state")
        self.assertEqual(os.stat(state).st_mode & 0o777, 0o700)
        self.assertEqual(self.chown.call_args_list[0][0], (state, 1234, 5678))
        bridge_path = os.path.abspath(bridge.__file__)  # không có maihub_bridge.py cạnh .env
        self.assertEqual(run.calls[0][0], ["sudo", "-u", "claudeproxy", "-H", "timeout", "5", "python3", "-I", bridge_path, "watch",
                                           "--env-file", self.env_file, "--notify-env", self.notify_env, "--dry-run"])
        self.assertEqual(run.calls[0][1]["timeout"], bridge.WATCH_DRY_RUN_SAFETY_SEC)
        self.assertEqual(run.calls[1][0], ["sudo", "-u", "claudeproxy", "-H", "timeout", "30", "python3", "-I", bridge_path, "watch",
                                           "--env-file", self.env_file, "--notify-env", self.notify_env, "--check-telegram"])
        self.assertEqual(run.calls[2][0], ["systemctl", "daemon-reload"])
        self.assertEqual(run.calls[3][0], ["systemctl", "enable", "maihub-watch-tg-bot.service"])
        self.assertEqual(run.calls[4][0], ["systemctl", "restart", "maihub-watch-tg-bot.service"])
        self.assertEqual(os.stat(self.unit_path()).st_mode & 0o777, 0o644)
        with open(self.unit_path()) as handle:
            self.assertIn("ReadWritePaths=" + state + "\n", handle.read())
        self.assertEqual(os.listdir(self.systemd), ["maihub-watch-tg-bot.service"])

    def test_install_watch_prefers_bridge_next_to_env(self):
        local = os.path.join(self.env_dir, "maihub_bridge.py")
        open(local, "w").close()
        run = FakeRun()
        code, out, err = self.install_watch(run, state_dir=os.path.join(self.tmp.name, "st"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(run.calls[0][0][8], local)
        with open(self.unit_path()) as handle:
            self.assertIn("-I %s watch" % local, handle.read())
        self.assertTrue(os.path.isdir(os.path.join(self.tmp.name, "st")))

    def test_install_watch_requires_root(self):
        run = FakeRun()
        code, _, err = self.install_watch(run, euid=1000)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("root", err)
        self.assertEqual(run.calls, [])
        self.assertEqual(os.listdir(self.systemd), [])

    def test_dry_run_failure_aborts_before_writing_unit(self):
        run = FakeRun(fail_on="--dry-run")
        code, _, err = self.install_watch(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("dry-run", err)
        self.assertEqual(len(run.calls), 1)
        self.assertEqual(os.listdir(self.systemd), [])

    def test_dry_run_safety_net_timeout_is_failure(self):
        run = FakeRun(timeout_on="--dry-run")
        code, _, err = self.install_watch(run)
        self.assertNotEqual(code, 0)
        self.assertEqual(len(run.calls), 1)
        self.assertEqual(os.listdir(self.systemd), [])

    def test_dry_run_timeout_exit_124_counts_as_success(self):
        run = FakeRun(fail_on="--dry-run", fail_code=124)
        code, out, err = self.install_watch(run)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(run.calls), 5)
        self.assertTrue(os.path.exists(self.unit_path()))

    def test_install_watch_validates_inputs_before_side_effects(self):
        for over in (dict(name="bad name"), dict(user="ghost"), dict(env_file=os.path.join(self.tmp.name, "nope"))):
            run = FakeRun()
            code, _, err = self.install_watch(run, **over)
            self.assertEqual(code, bridge.EXIT_CONFIG, over)
            self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
        self.assertEqual(os.listdir(self.systemd), [])

    def test_install_watch_whitespace_state_dir_changes_nothing(self):
        run = FakeRun()
        code, _, _ = self.install_watch(run, state_dir=os.path.join(self.tmp.name, "a b"))
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "a b")))

    def test_install_watch_systemctl_failure(self):
        code, _, err = self.install_watch(FakeRun(fail_on="enable"))
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("enable", err)

    def test_pair_install_runs_watch_steps_after_mcp(self):
        data_dir = self.add_bot("tg-claude-bot-a", "claudeproxy")
        run = FakeRun()
        code, out, err = self.install(run)
        self.assertEqual(code, 0, out + err)
        install_dir = self.args().dir
        self.assertEqual([c[0][7] if c[0][5] == "-I" else c[0][5] for c in run.calls[:3]], ["doctor", "mcp", "mcp"])
        dry = run.calls[3][0]
        self.assertEqual(dry[dry.index("--notify-env") + 1], os.path.join(data_dir, ".env"))
        self.assertEqual(dry[dry.index("--env-file") + 1], os.path.join(install_dir, ".env"))
        self.assertEqual(run.calls[6][0], ["systemctl", "enable", "maihub-watch-tg-claude-bot-a.service"])
        self.assertEqual(run.calls[7][0], ["systemctl", "restart", "maihub-watch-tg-claude-bot-a.service"])
        with open(os.path.join(self.systemd, "maihub-watch-tg-claude-bot-a.service")) as handle:
            unit = handle.read()
        self.assertIn("ReadWritePaths=" + os.path.join(install_dir, "state") + "\n", unit)
        self.assertIn("sudo systemctl disable --now maihub-watch-tg-claude-bot-a.service", out)
        self.assertIn("sudo rm " + os.path.join(self.systemd, "maihub-watch-tg-claude-bot-a.service"), out)
        self.assertNotIn("secret-token", out + err)

    def test_check_telegram_failure_aborts_before_unit_and_hides_token(self):
        run = FakeRun(fail_on="--check-telegram")
        code, _, err = self.install_watch(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("Telegram", err)
        self.assertIn("--skip-telegram-check", err)
        self.assertEqual(len(run.calls), 2)
        self.assertEqual(os.listdir(self.systemd), [])

    def test_check_telegram_timeout_aborts(self):
        run = FakeRun(timeout_on="--check-telegram")
        code, _, _ = self.install_watch(run)
        self.assertEqual(code, bridge.EXIT_NETWORK)
        self.assertEqual(os.listdir(self.systemd), [])

    def test_skip_telegram_check_omits_probe(self):
        run = FakeRun(fail_on="--check-telegram")
        code, out, err = self.install_watch(run, skip_telegram_check=True)
        self.assertEqual(code, 0, out + err)
        self.assertFalse(any("--check-telegram" in c[0] for c in run.calls))
        self.assertEqual([c[0][:2] for c in run.calls[1:]], [["systemctl", "daemon-reload"], ["systemctl", "enable"], ["systemctl", "restart"]])

    def test_warns_when_proxy_file_exists_but_no_route_in_env(self):
        with open(self.proxy_file, "w") as handle:
            handle.write("http://127.0.0.1:3128\n")
        code, out, err = self.install_watch(FakeRun())
        self.assertEqual(code, 0, out + err)
        self.assertIn("CẢNH BÁO", err)
        self.assertIn("TELEGRAM_PROXY", err)
        self.assertIn("TELEGRAM_API_BASE", err)
        self.assertNotIn("127.0.0.1", err)  # không in nội dung tệp proxy (có thể chứa mật khẩu)

    def test_no_warning_when_route_set_or_no_proxy_file(self):
        code, out, err = self.install_watch(FakeRun())
        self.assertNotIn("CẢNH BÁO", err)
        with open(self.proxy_file, "w") as handle:
            handle.write("http://127.0.0.1:3128\n")
        with open(self.env_file, "w") as handle:
            handle.write("TELEGRAM_PROXY=http://127.0.0.1:3128\n")
        code, out, err = self.install_watch(FakeRun())
        self.assertEqual(code, 0, out + err)
        self.assertNotIn("CẢNH BÁO", err)

    def test_install_watch_refuses_symlinks_and_untrusted_parent(self):
        victim = os.path.join(self.tmp.name, "victim")
        os.mkdir(victim)
        state = os.path.join(self.env_dir, "state")
        os.symlink(victim, state)
        run = FakeRun()
        code, _, err = self.install_watch(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.assertEqual(run.calls, [])
        self.chown.assert_not_called()
        os.unlink(state)
        link_dir = os.path.join(self.tmp.name, "linkdir")
        os.symlink(self.env_dir, link_dir)
        code, _, err = self.install_watch(run, env_file=os.path.join(link_dir, ".env"))
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.trusted.return_value = False
        code, _, err = self.install_watch(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("root", err)
        self.assertEqual(run.calls, [])
        self.assertEqual(os.listdir(self.systemd), [])
        self.assertFalse(os.path.lexists(state))

    def test_pair_install_no_watch_skips_watch_steps(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        run = FakeRun()
        code, out, err = self.install(run, no_watch=True)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(run.calls), 3)
        self.assertEqual(os.listdir(self.systemd), ["tg-claude-bot-a.service"])
        self.assertNotIn("systemctl", out)

    def test_pair_install_watch_failure_reports_step(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        code, _, err = self.install(FakeRun(fail_on="--dry-run"))
        self.assertNotEqual(code, 0)
        self.assertIn("cài watch", err)


class InstallHardeningTests(InstallFixture):
    def test_install_refuses_symlinked_install_dir_before_any_side_effect(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        victim = os.path.join(self.tmp.name, "victim")
        os.mkdir(victim)
        os.makedirs(self.install_root)
        os.symlink(victim, os.path.join(self.install_root, "bot1"))
        run = FakeRun()
        code, out, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.assertEqual(run.calls, [])
        self.chown.assert_not_called()
        self.assertEqual(os.listdir(victim), [])
        self.assertEqual([r for r in self.hub.requests if r["path"] == "/v1/pair"], [])

    def test_install_refuses_symlinked_state_dir(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        victim = os.path.join(self.tmp.name, "victim")
        os.mkdir(victim)
        install_dir = self.args().dir
        os.makedirs(install_dir)
        os.symlink(victim, os.path.join(install_dir, "state"))
        code, _, err = self.install(FakeRun())
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.chown.assert_not_called()
        self.assertEqual(os.listdir(victim), [])

    def test_install_refuses_untrusted_parent(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        self.trusted.return_value = False
        run = FakeRun()
        code, _, err = self.install(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("root", err)
        self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(self.install_root))

    def test_is_root_trusted_dir_rules(self):
        self.assertFalse(REAL_IS_TRUSTED_DIR(self.tmp.name))  # thuộc user thường, không phải root

        def fake(uid, mode):
            return mock.Mock(st_uid=uid, st_mode=mode)
        with mock.patch("os.lstat", return_value=fake(0, 0o40755)):
            self.assertTrue(REAL_IS_TRUSTED_DIR("/x"))
        for uid, mode in ((0, 0o40775), (0, 0o40757), (1000, 0o40755), (0, 0o100644), (0, 0o120777)):
            with mock.patch("os.lstat", return_value=fake(uid, mode)):
                self.assertFalse(REAL_IS_TRUSTED_DIR("/x"), (uid, oct(mode)))

    def test_env_file_has_key_reads_only_bounded_regular_files(self):
        regular = os.path.join(self.tmp.name, "a.env")
        with open(regular, "w") as handle:
            handle.write("export TG_TOKEN=x\n")
        self.assertTrue(bridge._env_file_has_key(regular, "TG_TOKEN"))
        link = os.path.join(self.tmp.name, "link.env")
        os.symlink(regular, link)
        self.assertFalse(bridge._env_file_has_key(link, "TG_TOKEN"))
        fifo = os.path.join(self.tmp.name, "fifo.env")
        os.mkfifo(fifo)
        self.assertFalse(bridge._env_file_has_key(fifo, "TG_TOKEN"))  # không treo
        big = os.path.join(self.tmp.name, "big.env")
        with open(big, "w") as handle:
            handle.write("#" * (bridge.ENV_READ_LIMIT + 10) + "\nTG_TOKEN=x\n")
        self.assertFalse(bridge._env_file_has_key(big, "TG_TOKEN"))
        self.assertFalse(bridge._env_file_has_key(os.path.join(self.tmp.name, "missing"), "TG_TOKEN"))

    def test_mcp_failure_prints_stderr_tail(self):
        stderr = b"\n".join(b"line %d" % i for i in range(10)) + b"\nsudo: claude: command not found\n"
        run = mock.Mock(return_value=mock.Mock(returncode=1, stderr=stderr))
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.register_mcp("claude", "u", "/b", "/e", run, self.home)
        self.assertIn("command not found", ctx.exception.message)
        self.assertIn("mã 1", ctx.exception.message)
        self.assertNotIn("line 0", ctx.exception.message)

    def test_summary_prints_backup_path_and_warns_rm_deletes_it(self):
        self.add_bot("tg-claude-bot-a", "claudeproxy")
        with open(os.path.join(self.home, ".claude.json"), "w") as handle:
            handle.write("original")
        code, out, err = self.install(FakeRun(), no_watch=True)
        self.assertEqual(code, 0, out + err)
        backup = os.path.join(self.args().dir, ".claude.json.before-maihub")
        self.assertIn(backup, out)
        self.assertLess(out.index(backup), out.index("sudo rm -rf"))


class FormatVideoFinishedTests(unittest.TestCase):
    def fmt(self, **over):
        payload = {"videoId": "v1", "name": "Flash sale", "ok": True, "durationSec": 20.4, "sizeBytes": 100, "mediaId": "m1"}
        payload.update(over)
        return bridge.format_event({"seq": 1, "type": "videos.finished", "payload": payload, "createdAt": 1}, lambda r: None)

    def test_success_shows_name_and_rounded_seconds(self):
        self.assertEqual(self.fmt(), "🎬 Video xong: Flash sale (20s)")
        self.assertEqual(self.fmt(durationSec=19.6), "🎬 Video xong: Flash sale (20s)")

    def test_success_without_duration_omits_seconds(self):
        self.assertEqual(self.fmt(durationSec=None), "🎬 Video xong: Flash sale")

    def test_failure_clips_error_to_120_chars(self):
        self.assertEqual(self.fmt(ok=False, error="Hết hạn"), "⚠️ Video lỗi: Flash sale — Hết hạn")
        line = self.fmt(ok=False, error="x" * 300)
        self.assertEqual(line, "⚠️ Video lỗi: Flash sale — " + "x" * 119 + "…")

    def test_failure_without_error_text(self):
        self.assertEqual(self.fmt(ok=False, error=None), "⚠️ Video lỗi: Flash sale — lỗi không rõ")

    def test_cancelled_is_silent(self):
        self.assertIsNone(self.fmt(ok=False, cancelled=True, error="Đã huỷ"))


if __name__ == "__main__":
    unittest.main()
