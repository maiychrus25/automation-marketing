# -*- coding: utf-8 -*-
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


if __name__ == "__main__":
    unittest.main()
