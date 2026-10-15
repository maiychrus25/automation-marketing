# -*- coding: utf-8 -*-
import base64
import hashlib
import io
import json
import os
import ssl
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
                        return self._reply(200, {"ok": True, "result": {"apiKey": API_KEY, "keyName": "bot-test"}})
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
        expected = {"a.webp": "image/webp", "a.JPG": "image/jpeg", "a.mov": "video/quicktime", "a.webm": "video/webm", "a.mp4": "video/mp4"}
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
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on

    def __call__(self, cmd, **kwargs):
        self.calls.append((list(cmd), kwargs))
        code = 1 if self.fail_on and self.fail_on in cmd else 0
        return mock.Mock(returncode=code)


class InstallTests(BridgeTestCase):
    def setUp(self):
        BridgeTestCase.setUp(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.systemd = os.path.join(self.tmp.name, "systemd")
        os.mkdir(self.systemd)
        self.home = os.path.join(self.tmp.name, "home")
        os.mkdir(self.home)
        self.install_root = os.path.join(self.tmp.name, "opt")

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
        ns = dict(code=make_pair_code(self.hub.url, PIN), install=True, bot=None, cli=None, dir=os.path.join(self.install_root, "bot1"))
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
        self.assertEqual(len(run.calls), 2)
        self.assertEqual(run.calls[1][1]["cwd"], self.home)
        self.assertIn(os.path.join(install_dir, "maihub_bridge.py"), run.calls[1][0])
        self.assertIn("mcp remove maihub -s user", out)
        self.assertIn(install_dir, out)
        self.assertNotIn(API_KEY, out + err)
        self.assertNotIn("secret-token", out + err)
        self.assertTrue(os.path.isdir(data_dir))

    def test_install_codex_inferred_from_user_and_cli_override(self):
        self.add_bot("bot-one", "codexproxy")
        run = FakeRun()
        code, out, err = self.install(run)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(run.calls[1][0][4], "codex")

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


if __name__ == "__main__":
    unittest.main()
