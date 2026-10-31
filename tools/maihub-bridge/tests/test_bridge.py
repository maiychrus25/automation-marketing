# -*- coding: utf-8 -*-
import base64
import fcntl
import hashlib
import io
import json
import os
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
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
        self.video_bytes = b"VIDEO" * 50000  # 250 KB: nhiều hơn một khối 64 KiB
        self.video_missing_tail = 0  # >0: khai Content-Length lớn hơn số byte thật gửi
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
                if self.path.startswith("/v1/videos/file?"):
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    if query.get("videoId") == ["missing"]:
                        return self._reply(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Không thấy video"}})
                    data = outer.video_bytes
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(len(data) + outer.video_missing_tail))
                    self.end_headers()
                    self.wfile.write(data)
                    return
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


class RunSelectionToolTests(unittest.TestCase):
    """runs.active / runs.cancel arrive through the filtered describe catalog; the bridge only forwards."""

    CATALOG = {"protocol": 1, "methods": [
        {"name": "runs.active", "description": "Các lượt đang chạy", "destructive": False,
         "paramsSchema": {"type": "object", "properties": {}}, "resultSchema": {"type": "array"}},
        {"name": "runs.cancel", "description": "Dừng một lượt", "destructive": True,
         "paramsSchema": {"type": "object", "properties": {"confirm": {"type": "boolean"}, "runId": {"type": "string"}}, "required": ["confirm"]},
         "resultSchema": {"type": "object"}},
    ]}

    class Client(object):
        def __init__(self, catalog, conflict=False):
            self.catalog, self.conflict, self.calls = catalog, conflict, []

        def describe(self):
            return self.catalog

        def call(self, method, params=None, idempotency_key=None):
            if method == "system.status":
                return {"lastEventSeq": 0, "workspace": {"id": "w1"}}
            self.calls.append((method, dict(params or {}), idempotency_key))
            if self.conflict and method == "runs.cancel" and "runId" not in (params or {}):
                raise bridge.BridgeError("CONFLICT", "Chọn lượt cần dừng", {})
            return [] if method == "runs.active" else {"cancelled": True}

    def call(self, client, name, arguments):
        out = io.StringIO()
        req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
        bridge.McpServer(client, io.StringIO(req + "\n"), out, io.StringIO()).run()
        return json.loads(out.getvalue().splitlines()[-1])["result"]

    def test_catalog_methods_become_tools_with_optional_run_id(self):
        tools = dict((t["name"], t) for t in bridge.build_tools(self.CATALOG))
        self.assertIn("maihub_runs_active", tools)
        self.assertEqual(tools["maihub_runs_cancel"]["inputSchema"]["properties"]["runId"], {"type": "string"})
        self.assertEqual(tools["maihub_runs_cancel"]["inputSchema"]["required"], ["confirm"])
        self.assertIn("Cần confirm: true", tools["maihub_runs_cancel"]["description"])

    def test_run_id_is_forwarded_exactly_and_idempotency_stripped(self):
        client = self.Client(self.CATALOG)
        result = self.call(client, "maihub_runs_cancel", {"confirm": True, "runId": "r-2", "idempotencyKey": "k"})
        self.assertNotIn("isError", result)
        self.assertEqual(client.calls, [("runs.cancel", {"confirm": True, "runId": "r-2"}, "k")])
        self.assertEqual(json.loads(self.call(client, "maihub_runs_active", {})["content"][0]["text"]), [])

    def test_conflict_is_shown_and_never_falls_back_to_another_call(self):
        client = self.Client(self.CATALOG, conflict=True)
        result = self.call(client, "maihub_runs_cancel", {"confirm": True})
        self.assertTrue(result["isError"])
        self.assertTrue(result["content"][0]["text"].startswith("CONFLICT: Chọn lượt cần dừng"))
        self.assertEqual([c[0] for c in client.calls], ["runs.cancel"])

    def test_scoped_catalog_without_the_methods_exposes_no_tool(self):
        names = [t["name"] for t in bridge.build_tools({"protocol": 1, "methods": []})]
        self.assertNotIn("maihub_runs_active", names)
        self.assertNotIn("maihub_runs_cancel", names)

    def test_guide_explains_active_cancel_and_two_live_runs(self):
        for word in ("maihub_runs_active", "maihub_runs_cancel", "runId", "CONFLICT", "NOT_FOUND", "tối đa 2"):
            self.assertIn(word, bridge.GUIDE)
        self.assertNotIn("chỉ chạy một việc dùng trình duyệt", bridge.GUIDE)
        self.assertIn("làm mới", bridge.GUIDE)


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
        self.assertEqual(sorted(tools), ["maihub_download_video", "maihub_drafts_delete", "maihub_events_wait", "maihub_guide", "maihub_system_status", "maihub_upload_media", "maihub_wait_for"])
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
        self.assertEqual(len(replies[0]["result"]["tools"]), 7)
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
        self.assertEqual(result["content"][0]["text"].split("\n")[0], "NOT_FOUND: Không thấy nháp")

    def test_call_confirmation_required_guidance(self):
        result = self.call("maihub_drafts_delete", {"id": "d1"})
        self.assertTrue(result["isError"])
        text = result["content"][0]["text"]
        self.assertTrue(text.startswith("CONFIRMATION_REQUIRED: Cần xác nhận"))
        self.assertIn("Hãy hỏi người dùng xác nhận rồi gọi lại với confirm: true", text)

    def test_error_text_has_details_and_hint(self):
        err = bridge.BridgeError("NOT_FOUND", "Không thấy", {"missing": ["p1"]})
        lines = bridge.format_tool_error(err).split("\n")
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0], "NOT_FOUND: Không thấy")
        self.assertEqual(lines[1], 'Chi tiết: {"missing":["p1"]}')
        self.assertEqual(lines[2], "Gợi ý: " + bridge.ERROR_HINTS["NOT_FOUND"])

    def test_error_text_unknown_code_is_single_line(self):
        self.assertEqual(bridge.format_tool_error(bridge.BridgeError("WEIRD", "lạ")), "WEIRD: lạ")

    def test_error_text_confirmation_keeps_guidance(self):
        text = bridge.format_tool_error(bridge.BridgeError("CONFIRMATION_REQUIRED", "Cần xác nhận"))
        self.assertIn(bridge.CONFIRM_GUIDANCE, text)

    def test_initialize_has_instructions(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})])
        self.assertEqual(replies[0]["result"]["instructions"], bridge.GUIDE)

    def test_guide_tool_returns_guide(self):
        result = self.call("maihub_guide", {})
        self.assertNotIn("isError", result)
        self.assertEqual(result["content"][0]["text"], bridge.GUIDE)

    def test_guide_mentions_real_tools_and_events(self):
        for word in ("maihub_wait_for", "maihub_upload_media", "maihub_download_video", "run.finished", "comments.collectFinished",
                     "videos.finished", "idempotencyKey", "serverNowMs", "uncertain_after_submit",
                     "maihub_videos_adCreate", "stt_mismatch", "fallback_still", "stepText"):
            self.assertIn(word, bridge.GUIDE)

    def test_success_result_is_compact_json(self):
        text = self.call("maihub_system_status", {})["content"][0]["text"]
        self.assertNotIn("\n  ", text)
        self.assertNotIn('": ', text)

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


class DownloadVideoTests(BridgeTestCase):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.dest = os.path.join(self.dir, "out.mp4")

    def test_success_writes_exact_bytes(self):
        result = self.client.download_video("vid-1", "video", self.dest)
        self.assertEqual(result, {"path": self.dest, "sizeBytes": 250000})
        with open(self.dest, "rb") as handle:
            self.assertEqual(handle.read(), self.hub.video_bytes)
        self.assertEqual(os.listdir(self.dir), ["out.mp4"])
        self.assertEqual(os.stat(self.dest).st_mode & 0o777, 0o600)
        req = self.hub.requests[-1]
        self.assertEqual(req["path"], "/v1/videos/file?videoId=vid-1&kind=video")
        self.assertEqual(req["headers"]["Authorization"], "Bearer " + API_KEY)

    def test_not_found_json_error_leaves_no_file(self):
        with self.assertRaises(bridge.BridgeError) as ctx:
            self.client.download_video("missing", "video", self.dest)
        self.assertEqual(ctx.exception.code, "NOT_FOUND")
        self.assertEqual(os.listdir(self.dir), [])

    def test_unwritable_destination_is_local_error_not_network(self):
        dest = os.path.join(self.dir, "no-such-dir", "out.mp4")
        with self.assertRaises(bridge.BridgeError) as ctx:
            self.client.download_video("vid-1", "video", dest)
        self.assertEqual(ctx.exception.code, "INVALID_PARAMS")
        self.assertIn("Không ghi được tệp đích", ctx.exception.message)
        self.assertEqual(os.listdir(self.dir), [])

    def test_invalid_params_rejected_before_network(self):
        for video_id, kind in (("../x", "video"), ("", "video"), ("a" * 65, "video"), ("v1", "audio"), (None, "video")):
            with self.assertRaises(bridge.BridgeError) as ctx:
                self.client.download_video(video_id, kind, self.dest)
            self.assertEqual(ctx.exception.code, "INVALID_PARAMS")
        self.assertEqual(self.hub.requests, [])

    def test_truncated_body_is_error_and_leaves_no_file(self):
        self.hub.video_missing_tail = 10
        with self.assertRaises(bridge.BridgeError) as ctx:
            self.client.download_video("vid-1", "video", self.dest)
        self.assertEqual(ctx.exception.code, "UNREACHABLE")
        self.assertEqual(os.listdir(self.dir), [])

    def test_pin_mismatch_never_sends_key(self):
        client = bridge.MaiHubClient(bridge.Config(self.hub.url, API_KEY, "0" * 64), timeout=10)
        with self.assertRaises(bridge.BridgeError) as ctx:
            client.download_video("vid-1", "video", self.dest)
        self.assertEqual(ctx.exception.code, "PIN_MISMATCH")
        self.assertEqual(self.hub.requests, [])
        self.assertEqual(os.listdir(self.dir), [])

    def call_tool(self, arguments):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                        "params": {"name": "maihub_download_video", "arguments": arguments}})])
        return replies[0]["result"]

    def test_tool_listed(self):
        replies = self.mcp([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})])
        tools = dict((t["name"], t) for t in replies[0]["result"]["tools"])
        schema = tools["maihub_download_video"]["inputSchema"]
        self.assertEqual(schema["required"], ["videoId"])
        self.assertEqual(schema["properties"]["kind"]["enum"], ["thumb", "video"])

    def test_tool_default_dir_under_home(self):
        with mock.patch.dict(os.environ, {"HOME": self.dir}):
            result = self.call_tool({"videoId": "vid-1"})
            thumb = self.call_tool({"videoId": "vid-1", "kind": "thumb"})
        folder = os.path.join(self.dir, "maihub-videos")
        self.assertEqual(json.loads(result["content"][0]["text"])["path"], os.path.join(folder, "vid-1.mp4"))
        self.assertEqual(json.loads(thumb["content"][0]["text"])["path"], os.path.join(folder, "vid-1.jpg"))
        self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)
        self.assertEqual(os.path.getsize(os.path.join(folder, "vid-1.mp4")), 250000)

    def test_tool_explicit_directory_and_file(self):
        result = self.call_tool({"videoId": "vid-1", "path": self.dir})
        self.assertEqual(json.loads(result["content"][0]["text"])["path"], os.path.join(self.dir, "vid-1.mp4"))
        result = self.call_tool({"videoId": "vid-1", "path": self.dest})
        self.assertEqual(json.loads(result["content"][0]["text"])["path"], self.dest)

    def test_tool_errors(self):
        result = self.call_tool({"videoId": "missing", "path": self.dir})
        self.assertTrue(result["isError"])
        self.assertTrue(result["content"][0]["text"].startswith("NOT_FOUND: "))
        self.assertTrue(self.call_tool({"videoId": "../x", "path": self.dir})["isError"])
        self.assertTrue(self.call_tool({"videoId": "vid-1", "kind": "audio", "path": self.dir})["isError"])

    def test_cli(self):
        code, out, _ = self.run_cli(["download-video", "vid-1", "--kind", "video", "-o", self.dest])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"path": self.dest, "sizeBytes": 250000})
        code, out, err = self.run_cli(["download-video", "missing", "-o", self.dir])
        self.assertEqual(code, bridge.EXIT_SERVER_ERROR)
        self.assertEqual(out, "")
        self.assertIn("NOT_FOUND", err)
        code, _, err = self.run_cli(["download-video", "../x"])
        self.assertEqual(code, bridge.EXIT_SERVER_ERROR)
        self.assertIn("INVALID_PARAMS", err)


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

    def __init__(self, script, runs=None, drafts=None, briefs=None):
        self.script = list(script)
        self.calls = []
        self.runs = runs or {}
        self.drafts = drafts or {}
        self.briefs = briefs or {}
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
        if method in ("drafts.get", "briefs.get"):
            item = self.drafts[params["id"]] if method == "drafts.get" else self.briefs[params["profileId"]]
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


class FakeWaitClient(object):
    """MaiHub giả cho maihub_wait_for: sự kiện chỉ hiện từ lần gọi events.wait thứ `visible_from`; rỗng thì đồng hồ giả chạy hết timeoutSec."""

    def __init__(self, clock, events=(), last_event_seq=0, workspace="ws1"):
        self.clock = clock
        self.events = list(events)  # (visible_from, event)
        self.status = {"workspace": None} if last_event_seq is None else {"lastEventSeq": last_event_seq, "workspace": {"id": workspace}}
        self.workspace = workspace
        self.workspace_by_call = {}
        self.waits = []  # (after, timeoutSec)
        self.calls = []

    def call(self, method, params=None, idempotency_key=None):
        self.calls.append(method)
        if method == "system.status":
            if isinstance(self.status, Exception):
                raise self.status
            return self.status
        if method != "events.wait":
            return {"started": True}
        self.waits.append((params["after"], params["timeoutSec"]))
        n = len(self.waits)
        found = [e for v, e in self.events if v <= n and e["seq"] > params["after"]]
        if not found:
            self.clock.now += params["timeoutSec"]
        return {"events": found, "workspaceId": self.workspace_by_call.get(n, self.workspace)}


def wait_event(seq, etype="videos.finished", **payload):
    return {"seq": seq, "type": etype, "payload": payload, "createdAt": 1}


class WaitForTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()

    def server(self, client):
        server = bridge.McpServer(client, io.StringIO(), io.StringIO(), io.StringIO(), clock=self.clock, sleep=self.clock.sleep)
        server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        return server

    def test_matching_event_after_session_mark_returns_at_once(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(11, videoId="v1"))], last_event_seq=10)
        server = self.server(client)
        self.assertEqual(server.session_after, 10)
        result = server.wait_for({"types": ["videos.finished"], "match": {"videoId": "v1"}})
        self.assertEqual(result, {"event": wait_event(11, videoId="v1"), "after": 11, "workspaceId": "ws1"})
        self.assertEqual(client.waits, [(10, 25)])

    def test_explicit_after_uses_per_call_workspace_baseline(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=10)
        client.status = {"lastEventSeq": 10}  # phiên không biết workspace: so với workspace thấy đầu tiên trong lời gọi
        server = self.server(client)
        client.workspace = "ws2"
        self.assertTrue(server.wait_for({"after": 0, "maxSec": 100}).get("timedOut"))

    def test_event_before_session_mark_is_ignored(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(5, videoId="v1"))], last_event_seq=10)
        result = self.server(client).wait_for({"maxSec": 5})
        self.assertEqual(result, {"timedOut": True, "after": 10, "workspaceId": "ws1"})

    def test_match_on_third_round_skips_other_events(self):
        events = [(1, wait_event(11, videoId="other")), (3, wait_event(12, videoId="v1"))]
        client = FakeWaitClient(self.clock, events, last_event_seq=10)
        result = self.server(client).wait_for({"match": {"videoId": "v1"}, "maxSec": 100})
        self.assertEqual(result["event"]["seq"], 12)
        self.assertEqual(len(client.waits), 3)

    def test_timeout_reports_highest_seq_seen(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(11, videoId="x"))], last_event_seq=10)
        result = self.server(client).wait_for({"match": {"videoId": "v1"}, "maxSec": 30})
        self.assertEqual(result, {"timedOut": True, "after": 11, "workspaceId": "ws1"})

    def test_workspace_change(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=10)
        client.workspace_by_call = {2: "ws2"}
        events = [(1, wait_event(11, videoId="x")), (2, wait_event(12, videoId="v1"))]
        client.events = events
        result = self.server(client).wait_for({"match": {"videoId": "v1"}, "maxSec": 100})
        self.assertEqual(result, {"workspaceChanged": True})

    def test_workspace_switched_before_call_marks_new_workspace_at_once(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(3, videoId="old"))], last_event_seq=500)
        server = self.server(client)
        self.assertEqual(server.session_workspace, "ws1")
        client.status = {"workspace": None}  # lần duyệt lại dùng events.wait
        client.workspace = "ws2"  # workspace mới có seq nhỏ hơn mốc cũ
        self.assertEqual(server.wait_for({"match": {"videoId": "v1"}}), {"workspaceChanged": True})
        self.assertEqual((server.session_after, server.session_workspace), (3, "ws2"))
        # Sự kiện xảy ra sau khi phát hiện nhưng trước lần chờ kế tiếp vẫn được trả về; sự kiện cũ của ws2 thì không.
        client.events.append((len(client.waits) + 1, wait_event(5, videoId="v1")))
        result = server.wait_for({"match": {"videoId": "v1"}})
        self.assertEqual(result["event"]["seq"], 5)
        self.assertEqual(server.wait_for({"match": {"videoId": "old"}, "maxSec": 5}).get("timedOut"), True)

    def test_workspace_switched_during_call_marks_new_workspace(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=500)
        client.workspace_by_call = {2: "ws2", 3: "ws2"}
        server = self.server(client)
        client.status = {"workspace": None}
        self.assertEqual(server.wait_for({"maxSec": 100}), {"workspaceChanged": True})
        self.assertEqual(len(client.waits), 3)  # 2 lần chờ + 1 lần duyệt lấy mốc mới
        self.assertEqual((server.session_after, server.session_workspace), (0, "ws2"))

    def test_workspace_change_with_unreachable_rescan_clears_session(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=500)
        client.workspace_by_call = {1: "ws2"}
        server = self.server(client)
        original = client.call
        def failing(method, params=None, idempotency_key=None):
            if len(client.waits) >= 1:
                raise bridge.BridgeError("UNREACHABLE", "mất mạng")
            return original(method, params, idempotency_key)
        client.call = failing
        self.assertEqual(server.wait_for({"maxSec": 100}), {"workspaceChanged": True})
        self.assertEqual((server.session_after, server.session_workspace), (None, None))

    def test_explicit_after_detects_workspace_switch_from_session(self):
        client = FakeWaitClient(self.clock, [(2, wait_event(3, videoId="v1"))], last_event_seq=500)
        server = self.server(client)
        client.status = {"lastEventSeq": 2, "workspace": {"id": "ws2"}}
        client.workspace = "ws2"
        self.assertEqual(server.wait_for({"after": 500}), {"workspaceChanged": True})
        self.assertEqual((server.session_after, server.session_workspace), (2, "ws2"))
        self.assertEqual(server.wait_for({"match": {"videoId": "v1"}})["event"]["seq"], 3)

    def test_workspace_id_with_after_catches_switch_back_to_same_session_workspace(self):
        # phiên đang ở wsB; bot lấy mốc 3 từ wsA; MaiHub quay lại wsB: chỉ workspaceId đi kèm after mới lộ ra
        client = FakeWaitClient(self.clock, [(2, wait_event(4, videoId="v1"))], last_event_seq=20, workspace="wsB")
        server = self.server(client)
        self.assertEqual(server.session_workspace, "wsB")
        self.assertTrue(server.wait_for({"after": 3, "maxSec": 1}).get("timedOut"))  # không workspaceId: như cũ
        client.status = {"lastEventSeq": 20, "workspace": {"id": "wsB"}}
        self.assertEqual(server.wait_for({"after": 3, "workspaceId": "wsA"}), {"workspaceChanged": True})

    def test_workspace_id_ignored_without_after(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=10)
        server = self.server(client)
        self.assertEqual(server.wait_for({"workspaceId": "other", "maxSec": 1}), {"timedOut": True, "after": 10, "workspaceId": "ws1"})

    def test_result_workspace_id_is_last_seen_or_baseline(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(11, videoId="v1"))], last_event_seq=10)
        client.workspace = None  # MaiHub chưa mở workspace: dùng workspace gốc
        server = self.server(client)
        self.assertEqual(server.wait_for({"match": {"videoId": "v1"}})["workspaceId"], "ws1")
        self.assertEqual(server.wait_for({"after": 0, "workspaceId": "ws1"})["workspaceId"], "ws1")

    def test_tool_schema_has_workspace_id(self):
        tool = [t for t in bridge.build_tools({"methods": []}) if t["name"] == bridge.WAIT_TOOL][0]
        self.assertIn("workspaceId", tool["inputSchema"]["properties"])
        self.assertIn("truyền kèm workspaceId", tool["description"])
        self.assertIn("workspaceId", bridge.ERROR_HINTS["BUSY"])
        self.assertIn("workspaceId", bridge.GUIDE)

    def test_scan_prefers_status_last_event_seq(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(8, videoId="old"))], last_event_seq=7)
        client.status = bridge.BridgeError("UNREACHABLE", "mất mạng")
        server = self.server(client)
        client.status = {"lastEventSeq": 7, "workspace": {"id": "ws1"}}
        client.calls = []
        self.assertEqual(server.wait_for({"match": {"videoId": "none"}, "maxSec": 1}), {"timedOut": True, "after": 8, "workspaceId": "ws1"})
        self.assertEqual(client.calls[:2], ["system.status", "events.wait"])  # 1 lời gọi lấy mốc, rồi chờ ngay (không duyệt trang)
        self.assertEqual(client.waits[0], (7, 1))
        self.assertEqual(server.session_workspace, "ws1")

    def test_tool_call_sets_missing_mark_before_starting_job(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(11, jobId="j1"))], last_event_seq=10)
        client.status = bridge.BridgeError("UNREACHABLE", "mất mạng")
        server = self.server(client)
        self.assertIsNone(server.session_after)
        client.status = {"lastEventSeq": 10, "workspace": {"id": "ws1"}}
        server._tools = bridge.build_tools({"methods": [{"name": "comments.collect", "description": "x"}]})
        client.calls = []
        server.call_tool("maihub_comments_collect", {})
        self.assertEqual(client.calls, ["system.status", "comments.collect"])
        self.assertEqual(server.wait_for({"match": {"jobId": "j1"}})["event"]["seq"], 11)
        client.calls = []
        server.session_after = None
        server.call_tool(bridge.GUIDE_TOOL, {})
        self.assertEqual(client.calls, [])  # maihub_guide không cần mốc

    def test_default_clock_is_monotonic(self):
        self.assertIs(bridge.McpServer(None).clock, bridge.time.monotonic)

    def test_busy_hint_and_guide_advise_after(self):
        self.assertIn("lastEventSeq", bridge.ERROR_HINTS["BUSY"])
        self.assertNotIn("run.finished", bridge.ERROR_HINTS["BUSY"])
        for text in ("Sau workspaceChanged, gọi lại không kèm after.", "luôn truyền after lấy từ kết quả trước",
                     "Giữ maxSec ≤ 50"):
            self.assertIn(text, bridge.GUIDE)

    def test_explicit_after_replaces_session_mark(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(5, videoId="v1"))], last_event_seq=10)
        result = self.server(client).wait_for({"after": 0})
        self.assertEqual(result["event"]["seq"], 5)
        self.assertEqual(client.waits[0][0], 0)

    def test_mark_computed_by_scanning_when_status_lacks_last_event_seq(self):
        events = [(1, wait_event(3, videoId="old")), (1, wait_event(4, videoId="old")), (3, wait_event(5, videoId="v1"))]
        client = FakeWaitClient(self.clock, events, last_event_seq=None)
        server = self.server(client)
        self.assertIsNone(server.session_after)
        self.assertEqual(client.waits, [])
        result = server.wait_for({"match": {"videoId": "v1"}})
        self.assertEqual(client.waits[0], (0, 0))  # duyệt từ đầu với timeoutSec=0
        self.assertEqual(server.session_after, 4)
        self.assertEqual(result["event"]["seq"], 5)

    def test_initialize_survives_unreachable_status(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(2, videoId="old")), (3, wait_event(5, videoId="v1"))], last_event_seq=None)
        client.status = bridge.BridgeError("UNREACHABLE", "mất mạng")
        server = bridge.McpServer(client, io.StringIO(), io.StringIO(), io.StringIO(), clock=self.clock, sleep=self.clock.sleep)
        server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertIn('"instructions"', server.stdout.getvalue())
        self.assertIsNone(server.session_after)
        client.status = {"lastEventSeq": 2}
        self.assertEqual(server.wait_for({"maxSec": 100})["event"]["seq"], 5)  # mốc tính ở lần wait_for đầu

    def test_consecutive_waits_without_after_both_see_their_events(self):
        events = [(1, wait_event(11, videoId="a")), (1, wait_event(12, videoId="b"))]
        client = FakeWaitClient(self.clock, events, last_event_seq=10)
        server = self.server(client)
        self.assertEqual(server.wait_for({"match": {"videoId": "a"}})["event"]["seq"], 11)
        self.assertEqual(server.wait_for({"match": {"videoId": "b"}})["event"]["seq"], 12)

    def test_invalid_params(self):
        server = self.server(FakeWaitClient(self.clock, [], last_event_seq=0))
        bad = [{"maxSec": 0}, {"maxSec": 601}, {"maxSec": "5"}, {"maxSec": True}, {"match": []}, {"match": {"a": [1]}},
               {"match": {"a": None}}, {"types": "run.finished"}, {"types": [1]}, {"after": -1}, {"after": "1"}, {"after": True},
               {"after": 1, "workspaceId": ""}, {"after": 1, "workspaceId": 5}]
        for args in bad:
            with self.assertRaises(bridge.BridgeError) as ctx:
                server.wait_for(args)
            self.assertEqual(ctx.exception.code, "INVALID_PARAMS", args)
            if "workspaceId" in args:
                self.assertEqual(ctx.exception.details, {"field": "workspaceId"})

    def test_match_does_not_confuse_bool_with_number(self):
        client = FakeWaitClient(self.clock, [(1, wait_event(11, ok=1))], last_event_seq=10)
        result = self.server(client).wait_for({"match": {"ok": True}, "maxSec": 1})
        self.assertTrue(result.get("timedOut"))

    def test_each_poll_timeout_capped_and_within_remaining_time(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=0)
        self.server(client).wait_for({"maxSec": 60})
        self.assertEqual([t for _, t in client.waits], [25, 25, 10])
        client = FakeWaitClient(self.clock, [], last_event_seq=0)
        self.server(client).wait_for({"maxSec": 1})
        self.assertEqual([t for _, t in client.waits], [1])

    def test_default_max_sec_is_50(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=0)
        self.server(client).wait_for({})
        self.assertEqual([t for _, t in client.waits], [25, 25])

    def test_tool_listed_and_errors_formatted(self):
        client = FakeWaitClient(self.clock, [], last_event_seq=0)
        server = self.server(client)
        server._tools = bridge.build_tools({"methods": []})
        names = [t["name"] for t in server.tools()]
        self.assertIn(bridge.WAIT_TOOL, names)
        result = server.call_tool(bridge.WAIT_TOOL, {"maxSec": 0})
        self.assertTrue(result["isError"])
        self.assertTrue(result["content"][0]["text"].startswith("INVALID_PARAMS: "))
        ok = server.call_tool(bridge.WAIT_TOOL, {"maxSec": 1})
        self.assertEqual(json.loads(ok["content"][0]["text"]), {"timedOut": True, "after": 0, "workspaceId": "ws1"})


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
        self.assertEqual(self.fmt(finished(1, kind="join", failed=1, posted=1)).split("\n")[0], "⚠️ Tham gia nhóm: xong 1/2, lỗi 1")
        self.assertEqual(self.fmt(finished(1, kind="scan_groups", status="cancelled", posted=1, failed=0)), "⏹ Quét nhóm: đã huỷ (1/1)")

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

    def test_side_jobs_done_without_failure_are_silent(self):
        for kind in ("join", "scan_groups", "collect_comments"):
            self.assertIsNone(self.fmt(finished(1, kind=kind)))
            self.assertIsNotNone(self.fmt(finished(1, kind=kind, failed=1)))
            self.assertIsNotNone(self.fmt(finished(1, kind=kind, status="cancelled")))
        self.assertEqual(self.fmt(finished(1, kind="post")), "✅ Đăng ngay: xong 2/2")

    def test_collect_finished_is_silent(self):
        self.assertIsNone(self.fmt({"seq": 1, "type": "comments.collectFinished", "payload": {"jobId": "j1", "leads": 3}}))

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


class FormatBriefTests(unittest.TestCase):
    def setUp(self):
        self.event = {"seq": 7, "type": "briefs.finished", "createdAt": 1, "payload": {
            "profileId": "p1", "pageName": "Mai Shop", "ok": True, "draftIds": ["draft-ab12", "draft-cd34"]}}
        self.drafts = {
            "draft-ab12": {"draft": {"id": "draft-ab12", "name": "Bài sáng", "params": {"text": "Bài thứ nhất"}}, "media": []},
            "draft-cd34": {"draft": {"id": "draft-cd34", "name": "Bài tối", "params": {"text": "Bài thứ hai"}}, "media": []}}
        self.brief = {"brief": {"profileId": "p1", "attempts": 0, "status": "idle", "claimedAt": None}}
        self.draft_calls = []
        self.brief_calls = []

    def fetch_draft(self, draft_id):
        self.draft_calls.append(draft_id)
        item = self.drafts[draft_id]
        if isinstance(item, Exception):
            raise item
        return item

    def fetch_brief(self, profile_id):
        self.brief_calls.append(profile_id)
        if isinstance(self.brief, Exception):
            raise self.brief
        return self.brief

    def fmt(self):
        formatter = getattr(bridge, "format_brief_messages", None)
        self.assertTrue(callable(formatter), "format_brief_messages is missing")
        return formatter(self.event, self.fetch_draft, self.fetch_brief)

    def test_two_drafts_have_separate_messages_and_reply_codes(self):
        self.assertEqual(self.fmt(), [
            "📝 Mai Shop — bài 1/2 · mã #ab12\nBài thứ nhất\nNhắn: đăng #ab12 · sửa #ab12 … · bỏ #ab12",
            "📝 Mai Shop — bài 2/2 · mã #cd34\nBài thứ hai\nNhắn: đăng #cd34 · sửa #cd34 … · bỏ #cd34"])
        self.assertEqual(self.draft_calls, ["draft-ab12", "draft-cd34"])
        self.assertEqual(self.brief_calls, [])

    def test_text_is_clipped_to_800_characters(self):
        self.drafts["draft-ab12"]["draft"]["params"]["text"] = "x" * 1000
        self.assertEqual(self.fmt()[0].split("\n")[1], "x" * 799 + "…")

    def test_video_extensions_have_video_label(self):
        for path in ("a.mp4", "a.mov", "a.webm", "A.MP4"):
            with self.subTest(path=path):
                self.drafts["draft-ab12"]["media"] = [{"path": path}]
                self.assertEqual(self.fmt()[0].split("\n")[2], "🎬 kèm video")

    def test_images_have_count_label(self):
        self.drafts["draft-ab12"]["media"] = [{"path": p} for p in ("a.jpg", "b.png", "c.webp")]
        self.assertEqual(self.fmt()[0].split("\n")[2], "🖼 kèm 3 ảnh")

    def test_failed_draft_fetch_has_fallback_and_keeps_next_draft(self):
        self.drafts["draft-ab12"] = bridge.BridgeError("NOT_FOUND", "Đã xoá")
        messages = self.fmt()
        self.assertEqual(messages[0], "📝 Mai Shop — bài 1/2 · mã #ab12\n"
                         "(không đọc được nội dung, mở MaiHub để xem)\nNhắn: đăng #ab12 · sửa #ab12 … · bỏ #ab12")
        self.assertIn("Bài thứ hai", messages[1])

    def test_failure_before_three_attempts_is_silent(self):
        self.event["payload"].update(ok=False, error="Lỗi nghiên cứu")
        for attempts in (0, 1, 2):
            with self.subTest(attempts=attempts):
                self.brief["brief"]["attempts"] = attempts
                self.assertEqual(self.fmt(), [])
        self.assertEqual(self.draft_calls, [])
        self.assertEqual(self.brief_calls, ["p1", "p1", "p1"])

    def test_failure_at_or_after_three_attempts_warns(self):
        self.event["payload"].update(ok=False, error="Lỗi nghiên cứu")
        for attempts in (3, 4):
            with self.subTest(attempts=attempts):
                self.brief["brief"]["attempts"] = attempts
                self.assertEqual(self.fmt(), ["⚠️ Mai Shop: hôm nay chưa tạo được bài đề xuất — Lỗi nghiên cứu"])
        self.assertEqual(self.draft_calls, [])

    def test_failure_error_is_clipped_to_200_characters(self):
        self.event["payload"].update(ok=False, error="e" * 1000)
        self.brief["brief"]["attempts"] = 3
        self.assertEqual(self.fmt(), ["⚠️ Mai Shop: hôm nay chưa tạo được bài đề xuất — " + "e" * 199 + "…"])

    def test_failed_brief_fetch_is_silent(self):
        self.event["payload"].update(ok=False, error="Lỗi nghiên cứu")
        self.brief = bridge.BridgeError("UNREACHABLE", "Mất mạng")
        self.assertEqual(self.fmt(), [])
        self.assertEqual(self.brief_calls, ["p1"])
        self.assertEqual(self.draft_calls, [])

    def test_delayed_failure_snapshots_warn_exactly_once_without_fetching_current_counter(self):
        self.event['payload'].update(ok=False, error='failure', attemptDate='2026-10-26')
        self.brief['brief']['attempts'] = 3
        messages = []
        for attempt in (1, 2, 3):
            self.event['payload']['attempts'] = attempt
            messages.extend(self.fmt())
        self.assertEqual(len(messages), 1)
        self.assertEqual(self.brief_calls, [])
        self.brief['brief']['attempts'] = 0
        self.assertEqual(len(self.fmt()), 1)
        self.brief = bridge.BridgeError('NOT_FOUND', 'deleted')
        self.assertEqual(len(self.fmt()), 1)
        self.assertEqual(self.brief_calls, [])

    def test_empty_draft_ids_are_silent(self):
        self.event["payload"]["draftIds"] = []
        self.assertEqual(self.fmt(), [])
        self.assertEqual(self.draft_calls, [])
        self.assertEqual(self.brief_calls, [])

    def test_page_name_stays_on_one_line_and_is_bounded(self):
        self.event["payload"]["pageName"] = "  Mai\n\tShop " + "p" * 500
        header = self.fmt()[0].split("\n")[0]
        self.assertEqual(header, "📝 " + "Mai Shop " + "p" * 190 + "… — bài 1/2 · mã #ab12")

    def test_single_message_formatter_is_silent_for_daily_events(self):
        for event_type in ("briefs.finished", "pages.learnFinished"):
            with self.subTest(event_type=event_type):
                self.assertIsNone(bridge.format_event({"type": event_type, "payload": self.event["payload"]},
                                                      lambda run_id: self.fail("must not fetch runs")))

    def test_guide_covers_daily_reply_actions_and_safeguards(self):
        for text in ("8. Đề xuất hằng ngày", "đăng #", "đăng luôn", "sửa #", "bỏ #",
                     "maihub_drafts_approve", "plannedAt", "maihub_drafts_update", "maihub_drafts_delete",
                     "maihub_briefs_save", "notes", "enabled", "maihub_pages_learn", "force", "true",
                     "maihub_drafts_list", "24 giờ", "Không bao giờ tự duyệt",
                     "Cần MaiHub từ 26.32.0 cho pages.*, briefs.*, research.trending"):
            with self.subTest(text=text):
                self.assertIn(text, bridge.GUIDE)


class FormatDoneWithoutCountsTests(unittest.TestCase):
    def test_done_with_zero_total_has_no_counts(self):
        text = bridge.format_event(finished(1, posted=0, failed=0, skipped=0), lambda r: None)
        self.assertEqual(text, "✅ Đăng ngay: xong")
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

    def watcher(self, script, runs=None, sender=None, drafts=None, briefs=None):
        self.client = FakeWatchClient(script, runs, drafts, briefs)
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

    def test_briefs_finished_sends_each_draft_then_advances_cursor(self):
        event = {"seq": 7, "type": "briefs.finished", "createdAt": 1, "payload": {
            "profileId": "p1", "pageName": "Mai Shop", "ok": True, "draftIds": ["draft-ab12", "draft-cd34"]}}
        drafts = {
            "draft-ab12": {"draft": {"id": "draft-ab12", "name": "Bài sáng", "params": {"text": "Bài thứ nhất"}}, "media": []},
            "draft-cd34": {"draft": {"id": "draft-cd34", "name": "Bài tối", "params": {"text": "Bài thứ hai"}}, "media": [{"path": "a.mp4"}]}}
        w = self.watcher([page([]), page([event])], drafts=drafts)
        w.step()
        w.step()
        self.assertEqual(self.sender.sent, [
            "📝 Mai Shop — bài 1/2 · mã #ab12\nBài thứ nhất\nNhắn: đăng #ab12 · sửa #ab12 … · bỏ #ab12",
            "📝 Mai Shop — bài 2/2 · mã #cd34\nBài thứ hai\n🎬 kèm video\nNhắn: đăng #cd34 · sửa #cd34 … · bỏ #cd34"])
        self.assertEqual(self.state()["cursor"], 7)
        self.assertEqual(self.state()["workspaceId"], "ws1")
        self.assertEqual(self.client.calls[-2:], [("drafts.get", {"id": "draft-ab12"}), ("drafts.get", {"id": "draft-cd34"})])

    def test_briefs_finished_failure_uses_brief_attempts_and_advances_cursor(self):
        event = {"seq": 7, "type": "briefs.finished", "createdAt": 1, "payload": {
            "profileId": "p1", "pageName": "Mai Shop", "ok": False, "draftIds": [], "error": "Quá giờ"}}
        for attempts in (1, 3):
            with self.subTest(attempts=attempts):
                self.sender.sent = []
                w = self.watcher([page([event])], briefs={"p1": {"brief": {
                    "profileId": "p1", "attempts": attempts, "status": "idle", "claimedAt": None}}})
                w.state = {"cursor": 0, "workspaceId": "ws1"}
                w.step()
                expected = [] if attempts == 1 else ["⚠️ Mai Shop: hôm nay chưa tạo được bài đề xuất — Quá giờ"]
                self.assertEqual(self.sender.sent, expected)
                self.assertEqual(self.state()["cursor"], 7)
                self.assertEqual(self.client.calls, [("events.wait", {"after": 0, "timeoutSec": 25}),
                                                     ("briefs.get", {"profileId": "p1"})])

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


class InstallBriefTests(InstallFixture):
    def setUp(self):
        # Cài unit chỉ dùng FakeRun, không cần HTTP server của fixture cha.
        with mock.patch.object(BridgeTestCase, "setUp"):
            InstallFixture.setUp(self)
        self.env_dir = os.path.join(self.tmp.name, "maihub")
        os.mkdir(self.env_dir)
        self.env_file = os.path.join(self.env_dir, ".env")
        with open(self.env_file, "w") as handle:
            handle.write("# Keep configuration\nMAIHUB_URL=https://hub:7443\nMAIHUB_API_KEY=" + API_KEY +
                         "\nMAIHUB_CERT_SHA256=" + PIN + "\nTELEGRAM_PROXY=http://proxy:8080\n")

    def brief_args(self, **over):
        ns = dict(env_file=self.env_file, user="claudeproxy", state_dir=None, agent_cmd=None,
                  protected=False, receiver_env=None, receiver_user=None)
        ns.update(over)
        service = ns.pop("name", "tg-bot")
        args = mock.Mock(**ns)
        args.name = service
        return args

    def install_brief(self, run, euid=0, **over):
        self.assertTrue(callable(getattr(bridge, "cmd_install_brief", None)), "cmd_install_brief chưa được triển khai")
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), mock.patch("os.chown") as chown:
            code = bridge.cmd_install_brief(self.brief_args(**over), run=run, geteuid=lambda: euid,
                                            systemd_dir=self.systemd, getpwnam=self.pw)
        self.chown = chown
        return code, out.getvalue(), err.getvalue()

    def unit_path(self, suffix="service"):
        return os.path.join(self.systemd, "maihub-brief-tg-bot." + suffix)

    def dry_run(self, client, which="/usr/bin/claude"):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(bridge, "MaiHubClient", return_value=client), \
                mock.patch.object(bridge.shutil, "which", return_value=which) as lookup, \
                mock.patch.object(bridge, "run_agent") as agent, \
                mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            try:
                code = bridge.main(["brief-tick", "--env-file", self.env_file, "--dry-run"])
            except SystemExit as exc:
                self.fail("brief-tick --dry-run chưa được đăng ký: %s" % exc)
        agent.assert_not_called()
        self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
        return code, out.getvalue(), err.getvalue(), lookup

    def test_unit_content(self):
        self.assertTrue(callable(getattr(bridge, "render_brief_units", None)), "render_brief_units chưa được triển khai")
        service, timer = bridge.render_brief_units("tg-bot", "claudeproxy", "/o/maihub_bridge.py", "/o/.env", "/o/state")
        for line in ["After=network-online.target", "Wants=network-online.target", "Type=oneshot", "User=claudeproxy",
                     "ExecStart=/usr/bin/python3 -I /o/maihub_bridge.py brief-tick --env-file /o/.env --state /o/state/brief-state.json",
                     "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/o/state", "PrivateTmp=yes",
                     "TimeoutStartSec=3600"]:
            self.assertIn(line + "\n", service)
        for line in ["[Timer]", "OnCalendar=*:0/15", "Persistent=true", "Unit=maihub-brief-tg-bot.service",
                     "[Install]", "WantedBy=timers.target"]:
            self.assertIn(line + "\n", timer)

    def test_render_rejects_whitespace_in_each_path(self):
        self.assertTrue(callable(getattr(bridge, "render_brief_units", None)), "render_brief_units chưa được triển khai")
        for index in range(3):
            for whitespace in (" ", "\t", "\n"):
                paths = ["/o/bridge.py", "/o/.env", "/o/state"]
                paths[index] += whitespace + "bad"
                with self.subTest(index=index, whitespace=whitespace), self.assertRaises(bridge.BridgeError) as ctx:
                    bridge.render_brief_units("bot", "user", *paths)
                self.assertEqual(ctx.exception.code, "CONFIG")

    def test_install_flow_checks_before_writing_and_enables_timer(self):
        run = FakeRun()

        def checked_run(cmd, **kwargs):
            if "--dry-run" in cmd:
                self.assertEqual(os.listdir(self.systemd), [])
                self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
            else:
                self.assertTrue(os.path.isfile(self.unit_path()))
                self.assertTrue(os.path.isfile(self.unit_path("timer")))
            return run(cmd, **kwargs)

        code, out, err = self.install_brief(checked_run)
        self.assertEqual(code, 0, out + err)
        state = os.path.join(self.env_dir, "state")
        self.assertEqual(os.stat(state).st_mode & 0o777, 0o700)
        self.assertEqual(self.chown.call_args_list[0][0], (state, 1234, 5678))
        self.assertEqual(run.calls[0][0], ["sudo", "-u", "claudeproxy", "-H", "python3", "-I", os.path.abspath(bridge.__file__),
                                           "brief-tick", "--env-file", self.env_file, "--state",
                                           os.path.join(state, "brief-state.json"), "--dry-run"])
        self.assertEqual(run.calls[0][1]["cwd"], self.home)
        self.assertEqual([call[0] for call in run.calls[1:]], [["systemctl", "daemon-reload"],
                         ["systemctl", "enable", "--now", "maihub-brief-tg-bot.timer"]])
        for _, options in run.calls:
            self.assertEqual(options["timeout"], bridge.RUN_TIMEOUT)
        for suffix in ("service", "timer"):
            self.assertEqual(os.stat(self.unit_path(suffix)).st_mode & 0o777, 0o644)
        self.assertEqual(sorted(os.listdir(self.systemd)), ["maihub-brief-tg-bot.service", "maihub-brief-tg-bot.timer"])
        self.assertNotIn(API_KEY, out + err)

    def test_install_prefers_local_bridge_and_custom_state(self):
        local = os.path.join(self.env_dir, "maihub_bridge.py")
        open(local, "w").close()
        state = os.path.join(self.tmp.name, "custom-state")
        run = FakeRun()
        code, out, err = self.install_brief(run, state_dir=state)
        self.assertEqual(code, 0, out + err)
        self.assertIn(local, run.calls[0][0])
        self.assertIn(os.path.join(state, "brief-state.json"), run.calls[0][0])
        with open(self.unit_path()) as handle:
            text = handle.read()
        self.assertIn("-I %s brief-tick" % local, text)
        self.assertIn("ReadWritePaths=" + state + "\n", text)

    def test_requires_root_without_side_effects(self):
        run = FakeRun()
        code, _, err = self.install_brief(run, euid=1000, agent_cmd="codex exec -")
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("root", err)
        self.assertEqual(run.calls, [])
        self.assertEqual(os.listdir(self.systemd), [])
        self.assertNotIn("MAIHUB_AGENT_CMD", bridge.parse_env_file(self.env_file))

    def test_invalid_inputs_have_no_side_effects(self):
        for over in (dict(name="bad name"), dict(name="../escape"), dict(name="bot\n"), dict(user="ghost"),
                     dict(env_file=os.path.join(self.tmp.name, "missing")), dict(state_dir=os.path.join(self.tmp.name, "bad path"))):
            with self.subTest(over=over):
                run = FakeRun()
                code, _, _ = self.install_brief(run, **over)
                self.assertEqual(code, bridge.EXIT_CONFIG)
                self.assertEqual(run.calls, [])
        self.assertEqual(os.listdir(self.systemd), [])
        self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "bad path")))

    def test_symlink_state_and_env_directory_rejected_before_changes(self):
        state = os.path.join(self.env_dir, "state")
        os.symlink(self.home, state)
        run = FakeRun()
        code, _, err = self.install_brief(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.assertEqual(run.calls, [])
        self.chown.assert_not_called()
        os.unlink(state)
        link = os.path.join(self.tmp.name, "link")
        os.symlink(self.env_dir, link)
        code, _, err = self.install_brief(run, env_file=os.path.join(link, ".env"))
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("symlink", err)
        self.assertEqual(run.calls, [])
        self.chown.assert_not_called()

    def test_untrusted_state_parent_rejected_before_changes(self):
        self.trusted.return_value = False
        run = FakeRun()
        code, _, _ = self.install_brief(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertEqual(run.calls, [])
        self.chown.assert_not_called()
        self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))

    def test_failed_dry_run_does_not_write_units_or_call_systemctl(self):
        for exit_code in (1, 124):
            run = FakeRun(fail_on="--dry-run", fail_code=exit_code)
            code, _, err = self.install_brief(run)
            self.assertEqual(code, bridge.EXIT_CONFIG)
            self.assertIn("dry-run", err)
            self.assertEqual(len(run.calls), 1)
            self.assertEqual(os.listdir(self.systemd), [])

    def test_failed_reinstall_keeps_existing_units(self):
        for suffix in ("service", "timer"):
            with open(self.unit_path(suffix), "w") as handle:
                handle.write("existing " + suffix)
        run = FakeRun(fail_on="--dry-run")
        code, _, _ = self.install_brief(run)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        for suffix in ("service", "timer"):
            with open(self.unit_path(suffix)) as handle:
                self.assertEqual(handle.read(), "existing " + suffix)
        self.assertEqual(len(run.calls), 1)

    def test_failed_agent_override_preserves_existing_env_and_state(self):
        with open(self.env_file, "ab") as handle:
            handle.write(b"MAIHUB_AGENT_CMD=old\r\n# Preserve exact bytes")
        with open(self.env_file, "rb") as handle:
            original = handle.read()
        state = os.path.join(self.env_dir, "state")
        os.mkdir(state, 0o750)
        state_file = os.path.join(state, "brief-state.json")
        with open(state_file, "wb") as handle:
            handle.write(b'{"lastOnboardAt":123}')
        before = os.stat(state)
        run = FakeRun(fail_on="--dry-run")
        code, _, _ = self.install_brief(run, agent_cmd="new")
        self.assertEqual(code, bridge.EXIT_CONFIG)
        with self.subTest(resource="env"), open(self.env_file, "rb") as handle:
            self.assertEqual(handle.read(), original)
        with self.subTest(resource="state"):
            after = os.stat(state)
            self.assertEqual((after.st_mode, after.st_uid, after.st_gid, after.st_ino, after.st_mtime_ns),
                             (before.st_mode, before.st_uid, before.st_gid, before.st_ino, before.st_mtime_ns))
            self.assertFalse(any(call[0][0] == state for call in self.chown.call_args_list))
            with open(state_file, "rb") as handle:
                self.assertEqual(handle.read(), b'{"lastOnboardAt":123}')
        self.assertEqual(len(run.calls), 1)
        self.assertEqual(os.listdir(self.systemd), [])
        candidate = run.calls[0][0][run.calls[0][0].index("--env-file") + 1]
        self.assertNotEqual(candidate, self.env_file)
        self.assertFalse(os.path.exists(os.path.dirname(candidate)))

    def test_failed_or_timed_out_override_does_not_create_state(self):
        with open(self.env_file, "ab") as handle:
            handle.write(b"MAIHUB_AGENT_CMD=old\n")
        with open(self.env_file, "rb") as handle:
            original = handle.read()
        for run, expected in ((FakeRun(fail_on="--dry-run"), bridge.EXIT_CONFIG),
                              (FakeRun(timeout_on="--dry-run"), bridge.EXIT_NETWORK)):
            with self.subTest(expected=expected):
                code, _, _ = self.install_brief(run, agent_cmd="new")
                self.assertEqual(code, expected)
                self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
                with open(self.env_file, "rb") as handle:
                    self.assertEqual(handle.read(), original)
                self.assertEqual(len(run.calls), 1)
                self.assertEqual(os.listdir(self.systemd), [])
                candidate = run.calls[0][0][run.calls[0][0].index("--env-file") + 1]
                self.assertNotEqual(candidate, self.env_file)
                self.assertFalse(os.path.exists(os.path.dirname(candidate)))

    def test_dry_run_timeout_aborts_before_writing_units(self):
        run = FakeRun(timeout_on="--dry-run")
        code, _, _ = self.install_brief(run)
        self.assertEqual(code, bridge.EXIT_NETWORK)
        self.assertEqual(len(run.calls), 1)
        self.assertEqual(os.listdir(self.systemd), [])

    def test_systemctl_failure_stops_installation(self):
        for step, count in (("daemon-reload", 2), ("enable", 3)):
            run = FakeRun(fail_on=step)
            code, _, err = self.install_brief(run)
            self.assertEqual(code, bridge.EXIT_CONFIG)
            self.assertIn(step, err)
            self.assertEqual(len(run.calls), count)

    def test_agent_override_probed_before_writing_keeps_other_env_keys(self):
        with open(self.env_file, "a") as handle:
            handle.write("MAIHUB_AGENT_CMD=old -p\nMAIHUB_AGENT_TIMEOUT_SEC=123\n")
        run = FakeRun()

        def checked_run(cmd, **kwargs):
            if "--dry-run" in cmd:
                self.assertEqual(bridge.parse_env_file(self.env_file)["MAIHUB_AGENT_CMD"], "old -p")
                self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
                candidate = cmd[cmd.index("--env-file") + 1]
                self.assertNotEqual(candidate, self.env_file)
                values = bridge.parse_env_file(candidate)
                self.assertEqual(values["MAIHUB_AGENT_CMD"], "codex exec -")
                self.assertEqual(values["MAIHUB_API_KEY"], API_KEY)
                self.assertEqual(values["MAIHUB_AGENT_TIMEOUT_SEC"], "123")
                self.assertEqual(os.stat(candidate).st_mode & 0o777, 0o600)
                self.assertEqual(os.stat(os.path.dirname(candidate)).st_mode & 0o777, 0o700)
            return run(cmd, **kwargs)

        with mock.patch.object(bridge, "write_env_file", wraps=bridge.write_env_file) as writer:
            code, out, err = self.install_brief(checked_run, agent_cmd="codex exec -")
        self.assertEqual(code, 0, out + err)
        writer.assert_called_once_with(self.env_file, {"MAIHUB_AGENT_CMD": "codex exec -"}, uid=1234, gid=5678)
        candidate = run.calls[0][0][run.calls[0][0].index("--env-file") + 1]
        self.chown.assert_any_call(os.path.dirname(candidate), 1234, 5678)
        self.assertFalse(os.path.exists(os.path.dirname(candidate)))
        values = bridge.parse_env_file(self.env_file)
        self.assertEqual(values["MAIHUB_API_KEY"], API_KEY)
        self.assertEqual(values["TELEGRAM_PROXY"], "http://proxy:8080")
        self.assertEqual(values["MAIHUB_AGENT_TIMEOUT_SEC"], "123")
        self.assertEqual(os.stat(self.env_file).st_mode & 0o777, 0o600)
        with open(self.env_file) as handle:
            self.assertIn("# Keep configuration\n", handle.read())

    def test_no_override_preserves_env_file(self):
        with open(self.env_file) as handle:
            original = handle.read()
        code, out, err = self.install_brief(FakeRun())
        self.assertEqual(code, 0, out + err)
        with open(self.env_file) as handle:
            self.assertEqual(handle.read(), original)

    def test_invalid_agent_override_rejected_before_changes(self):
        for command in ("", "   ", "claude '\"", "claude\nOTHER=value", "claude\rOTHER=value"):
            run = FakeRun()
            code, _, _ = self.install_brief(run, agent_cmd=command)
            self.assertEqual(code, bridge.EXIT_CONFIG)
            self.assertEqual(run.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.env_dir, "state")))
        self.assertNotIn("MAIHUB_AGENT_CMD", bridge.parse_env_file(self.env_file))

    def test_install_cli_dispatch(self):
        self.assertTrue(callable(getattr(bridge, "cmd_install_brief", None)), "cmd_install_brief chưa được triển khai")
        with mock.patch.object(bridge, "cmd_install_brief", return_value=0) as install:
            code = bridge.main(["install-brief", "--env-file", self.env_file, "--user", "claudeproxy", "--name", "tg-bot",
                                "--state-dir", "/custom/state", "--agent-cmd", "codex exec -"])
        self.assertEqual(code, 0)
        args = install.call_args[0][0]
        self.assertEqual((args.env_file, args.user, args.name, args.state_dir, args.agent_cmd),
                         (self.env_file, "claudeproxy", "tg-bot", "/custom/state", "codex exec -"))

    def test_tick_dry_run_checks_status_and_default_agent_only(self):
        client = mock.Mock()
        code, out, err, lookup = self.dry_run(client)
        self.assertEqual(code, 0, out + err)
        client.call.assert_called_once_with("system.status")
        lookup.assert_called_once_with("claude")

    def test_tick_dry_run_respects_quoted_agent_command(self):
        with open(self.env_file, "a") as handle:
            handle.write('MAIHUB_AGENT_CMD="/opt/agent tools/cli" exec -\n')
        client = mock.Mock()
        code, out, err, lookup = self.dry_run(client, which="/opt/agent tools/cli")
        self.assertEqual(code, 0, out + err)
        lookup.assert_called_once_with("/opt/agent tools/cli")
        client.call.assert_called_once_with("system.status")

    def test_tick_dry_run_missing_agent_is_config_error(self):
        client = mock.Mock()
        code, _, err, _ = self.dry_run(client, which=None)
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertIn("claude", err)
        client.call.assert_called_once_with("system.status")

    def test_tick_dry_run_unreachable_is_failure(self):
        client = mock.Mock()
        client.call.side_effect = bridge.BridgeError("UNREACHABLE", "Không kết nối được MaiHub")
        code, _, _, lookup = self.dry_run(client)
        self.assertEqual(code, bridge.EXIT_NETWORK)
        lookup.assert_not_called()
        client.call.assert_called_once_with("system.status")


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


class SendVideoTests(unittest.TestCase):
    def make(self, script, thread_id=None):
        clock = FakeClock()
        opener = FakeOpener(script)
        target = {"token": TG_TOKEN, "chat_id": "42", "thread_id": thread_id}
        sender = bridge.TelegramSender(target, ROUTE, sleep=clock.sleep, opener=opener)
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "video-v1.mp4")
        with open(path, "wb") as handle:
            handle.write(b"\x00MP4DATA\xff")
        return sender, opener, clock, path

    def test_multipart_request_shape(self):
        sender, opener, _, path = self.make([OK_BODY], thread_id=7)
        self.assertTrue(sender.send_video(path, "🎬 Video xong: A"))
        req = opener.requests[0]
        self.assertEqual(req.full_url, "https://api.telegram.org/bot%s/sendVideo" % TG_TOKEN)
        ctype = req.get_header("Content-type")
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        self.assertIn(ctype.split("boundary=")[1].encode("ascii"), req.data)
        for needle in (b'name="chat_id"\r\n\r\n42', b'name="message_thread_id"\r\n\r\n7', b'name="supports_streaming"\r\n\r\ntrue',
                       "name=\"caption\"\r\n\r\n🎬 Video xong: A".encode("utf-8"),
                       b'name="video"; filename="video-v1.mp4"\r\nContent-Type: video/mp4\r\n\r\n\x00MP4DATA\xff\r\n'):
            self.assertIn(needle, req.data)

    def test_no_thread_field_when_unset(self):
        sender, opener, _, path = self.make([OK_BODY])
        self.assertTrue(sender.send_video(path, "c"))
        self.assertNotIn(b"message_thread_id", opener.requests[0].data)

    def test_retry_after_once_then_gives_up(self):
        sender, opener, clock, path = self.make([http_429(3), OK_BODY])
        self.assertTrue(sender.send_video(path, "c"))
        self.assertEqual(clock.slept, [3])
        sender, opener, clock, path = self.make([http_429(3), http_429(3)])
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertFalse(sender.send_video(path, "c"))
        self.assertEqual(len(opener.requests), 2)

    def test_failure_returns_false_and_hides_token(self):
        for script in ([OSError("conn %s" % TG_TOKEN)], [FakeResponse(b'{"ok": false}')]):
            sender, opener, clock, path = self.make(script)
            err = io.StringIO()
            with mock.patch("sys.stderr", err):
                self.assertFalse(sender.send_video(path, "c"))
            self.assertNotIn(TG_TOKEN, err.getvalue())
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(clock.slept, [])

    def test_missing_file_returns_false(self):
        sender, opener, _, path = self.make([OK_BODY])
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertFalse(sender.send_video(path + ".nope", "c"))
        self.assertEqual(opener.requests, [])


class VideoSender(FakeSender):
    def __init__(self, result=True):
        super().__init__()
        self.videos = []
        self.result = result
        self.seen_file = None

    def _describe(self, err):
        return "%s: %s" % (type(err).__name__, err)

    def send_video(self, path, caption):
        self.seen_file = os.path.exists(path)
        self.videos.append((path, caption))
        return self.result


class VideoDownloadClient(FakeWatchClient):
    def __init__(self, script, fail=None, size=1000):
        super().__init__(script)
        self.fail = fail
        self.size = size
        self.downloads = []

    def download_video(self, video_id, kind, dest_path):
        self.downloads.append((video_id, kind, dest_path))
        if self.fail:
            raise self.fail
        with open(dest_path, "wb") as handle:
            handle.write(b"x" * self.size)
        return {"path": dest_path, "sizeBytes": self.size}


def video_event(seq, **over):
    payload = {"videoId": "v1", "name": "Flash sale", "ok": True, "durationSec": 20.4, "sizeBytes": 1000, "mediaId": "m1"}
    payload.update(over)
    return {"seq": seq, "type": "videos.finished", "payload": payload, "createdAt": 1}


class WatcherVideoTests(unittest.TestCase):
    CAPTION = "🎬 Video xong: Flash sale (20s)"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = os.path.join(self.tmp.name, "state", "watch-state.json")
        self.clock = FakeClock()

    def run_events(self, events, sender, client=None):
        self.client = client or VideoDownloadClient([page([]), page(events)])
        w = bridge.Watcher(self.client, sender, self.state_path, clock=self.clock, sleep=self.clock.sleep)
        with mock.patch("sys.stderr", io.StringIO()) as err:
            w.step()
            w.step()
        self.err = err.getvalue()
        with open(self.state_path) as handle:
            self.cursor = json.load(handle)["cursor"]

    def assert_state_clean(self):
        self.assertEqual(os.listdir(os.path.dirname(self.state_path)), ["watch-state.json"])

    def test_ok_video_is_sent_with_caption_and_temp_removed(self):
        sender = VideoSender()
        self.run_events([video_event(1)], sender)
        self.assertEqual(sender.videos, [(os.path.join(os.path.dirname(self.state_path), "video-v1.mp4"), self.CAPTION)])
        self.assertTrue(sender.seen_file)
        self.assertEqual(sender.sent, [])
        self.assertEqual(self.client.downloads[0][:2], ("v1", "video"))
        self.assertEqual(self.cursor, 1)
        self.assert_state_clean()

    def test_oversize_payload_sends_text_only(self):
        sender = VideoSender()
        self.run_events([video_event(1, sizeBytes=50 * 1024 * 1024 + 1)], sender)
        self.assertEqual(sender.sent, [self.CAPTION])
        self.assertEqual(sender.videos, [])
        self.assertEqual(self.client.downloads, [])

    def test_oversize_after_download_falls_back(self):
        sender = VideoSender()
        client = VideoDownloadClient([page([]), page([video_event(1)])], size=50 * 1024 * 1024 + 1)
        self.run_events([], sender, client)
        self.assertEqual(sender.sent, [self.CAPTION])
        self.assertEqual(sender.videos, [])
        self.assert_state_clean()

    def test_download_failure_falls_back_to_text(self):
        sender = VideoSender()
        client = VideoDownloadClient([page([]), page([video_event(1), video_event(2, videoId="v2")])],
                                     fail=bridge.BridgeError("NOT_FOUND", "x"))
        self.run_events([], sender, client)
        self.assertEqual(sender.sent, [self.CAPTION, self.CAPTION])
        self.assertEqual(self.cursor, 2)
        self.assertIn("BridgeError: NOT_FOUND", self.err)
        self.assert_state_clean()

    def test_send_video_false_falls_back_to_text(self):
        sender = VideoSender(result=False)
        self.run_events([video_event(1)], sender)
        self.assertEqual(sender.sent, [self.CAPTION])
        self.assertEqual(self.cursor, 1)
        self.assert_state_clean()

    def test_send_video_exception_falls_back_to_text(self):
        sender = VideoSender()
        sender.send_video = mock.Mock(side_effect=RuntimeError("boom"))
        self.run_events([video_event(1)], sender)
        self.assertEqual(sender.sent, [self.CAPTION])
        self.assert_state_clean()

    def test_failed_cancelled_and_bad_id_unchanged(self):
        sender = VideoSender()
        self.run_events([video_event(1, ok=False, error="Hết hạn"), video_event(2, ok=False, cancelled=True),
                         video_event(3, videoId="../x")], sender)
        self.assertEqual(sender.sent, ["⚠️ Video lỗi: Flash sale — Hết hạn", self.CAPTION])
        self.assertEqual(sender.videos, [])
        self.assertEqual(self.client.downloads, [])
        self.assertEqual(self.cursor, 3)

    def test_sender_without_video_support_keeps_text_only(self):
        sender = FakeSender()  # như PrintSender của --dry-run
        self.run_events([video_event(1)], sender)
        self.assertEqual(sender.sent, [self.CAPTION])
        self.assertEqual(self.client.downloads, [])


class ProtectedPageTests(unittest.TestCase):
    """External boundaries are fake; durable state and bridge decisions are real."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "protected.json")
        self.now = 1800000000
        self.agent = mock.Mock(return_value=(0, False))
        self.work = None
        self.claim = None
        self.cap = {"pageOperations": 1, "protectedWritesEnabled": True,
                    "principal": {"kind": "page_runner", "workspaceId": "ws",
                                  "assignments": [{"pageId": "page", "profileIds": ["p"]}]}}
        self.preparation = {"niche": "Training", "keywords": ["safe"], "groupIds": ["g"],
                            "tone": "friendly", "notes": "no ads", "time": "09:30", "draftsPerDay": 2}
        self.calls = []
        self.client = mock.Mock()
        self.client.call.side_effect = self.call
        self.client.describe.return_value = {"methods": []}

    def call(self, method, params=None, **kwargs):
        self.calls.append((method, params))
        if method == "system.capabilities":
            return self.cap
        if method == "pageWork.list":
            return {"items": [dict(self.work)] if self.work else []}
        if method == "pageWork.reconcile":
            return {"work": dict(self.work)}
        if method == "pageWork.claimDue":
            if self.claim:
                self.work = dict(self.claim)
            return {"work": dict(self.claim) if self.claim else None}
        if method == "pageWork.get":
            return {"work": dict(self.work or self.claim), "preparation": self.preparation}
        if method == "pageWork.fail":
            self.work["status"] = "needs_review"
            return {"work": dict(self.work)}
        raise AssertionError("Unexpected protected call: " + method)

    def item(self, **changes):
        item = {"id": "w", "workspaceId": "ws", "pageId": "page", "profileId": "p",
                "status": "running", "claimedAt": 123, "attempts": 1, "waitFor": None,
                "videoId": None, "draftIds": [], "nextCheckAt": None}
        item.update(changes)
        return item

    def tick(self):
        self.assertTrue(callable(getattr(bridge, "protected_brief_tick", None)), "missing protected tick")
        return bridge.protected_brief_tick(self.client, self.agent, lambda: self.now, self.path)

    def campaign_fixture(self):
        policy = {"startsAt": self.now * 1000, "expiresAt": (self.now + 7 * 86400) * 1000,
                  "maxPostsPerDay": 1, "maxPostsTotal": 7, "allowedMinutes": [570],
                  "timeZone": "Asia/Ho_Chi_Minh", "actions": ["schedulePost", "updateScheduledPost"]}
        proposal = {"id": "proposal", "workspaceId": "ws", "pageId": "page", "profileId": "p",
                    "workId": "pruned", "revision": 2, "status": "pending",
                    "input": {"name": "Pilot", "goal": "Giới thiệu dịch vụ", "policy": policy}}
        campaign = {"campaignId": "campaign", "workspaceId": "ws", "pageId": "page", "profileId": "p",
                    "revision": 1, "proposalId": "proposal", "managed": True, "deletedAt": None}
        grant = {"id": "grant", "campaignId": "campaign", "campaignRevision": 1, "revision": 1,
                 "workspaceId": "ws", "pageId": "page", "profileId": "p", "policy": policy, "status": "active"}
        report = {"campaignId": "campaign", "pageId": "page", "from": 0, "to": 1,
                  "published": 0, "eligible": 0, "measured": 0, "coverage": None,
                  "totalEngagement": None, "uniqueLeads": 0, "lastObservedAt": None,
                  "missingReasons": ["missing_publish_proof"], "observations": [],
                  "measurementWindow": {"milestoneMinutes": 4320, "minAgeHours": 72, "maxAgeHours": 96},
                  "finance": {"status": "unavailable", "reason": "missing_financial_source"}}
        action = {"kind": "grantCampaign", "pageId": "page", "proposalId": "proposal", "expectedProposalRevision": 2}
        ticket = {"id": "ticket", "action": action, "chatId": "12", "senderId": "34",
                  "expiresAt": int(time.time() * 1000) + 10000}
        methods = ["pageCampaigns." + name for name in ("list", "get", "propose", "schedule", "collect", "report", "optimize")]
        self.client.describe.return_value = {"methods": [{"name": name} for name in methods]}
        original = self.call
        def call(method, params=None, **kwargs):
            if not method.startswith(("pageCampaigns.", "pageApprovals.")) and method != "pageWork.events":
                return original(method, params, **kwargs)
            self.calls.append((method, params))
            if method == "pageCampaigns.list":
                return {"campaigns": [campaign], "proposals": [proposal]}
            if method == "pageCampaigns.get":
                return {"campaign": campaign, "grants": [grant]}
            if method == "pageCampaigns.report":
                return dict(report, **{k: params[k] for k in ("from", "to") if k in params})
            if method == "pageWork.events":
                return {"workspaceId": "ws", "events": [], "nextCursor": 4}
            if method == "pageApprovals.prepare":
                return {"ticket": dict(ticket, action=dict(params["action"]))}
            if method in ("pageApprovals.bindMessage", "pageApprovals.confirm"):
                return {"ok": True}
            raise AssertionError(method)
        self.client.call.side_effect = call
        return proposal, campaign, grant, report, ticket

    def test_campaign_proposal_requires_bound_owner_reply(self):
        proposal, _, _, _, ticket = self.campaign_fixture()
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        sender.send_once.return_value = {"chat": {"id": 12}, "message_id": 7}
        entry = bridge.ProtectedWatcher(self.client, sender, self.path).deliver(
            ["ws", "page", "proposal", 2], "not proof", ticket["action"], "pruned")
        text = sender.send_once.call_args.args[0]
        for expected in ("page", "Giới thiệu dịch vụ", "09:30", "Asia/Ho_Chi_Minh", "1 bài/ngày", "7 bài", "7 ngày", "thu hồi"):
            self.assertIn(expected, text)
        pending = entry["ticket"]
        update = {"update_id": 1, "message": {"message_id": 8, "chat": {"id": 12}, "from": {"id": 34},
                  "text": "ok", "reply_to_message": {"message_id": 7}}}
        for field, value in (("from", {"id": 99}), ("reply_to_message", {"message_id": 99}), ("text", '{"kind":"grantCampaign"}')):
            invalid = dict(update, message=dict(update["message"], **{field: value}))
            self.assertEqual(bridge.handle_owner_update(self.client, invalid, pending), {"intent": "clarify"})
        self.assertEqual(bridge.handle_owner_update(self.client, update, dict(pending, expiresAt=0)), {"intent": "clarify"})
        proposal["revision"] = 3
        self.assertEqual(bridge.handle_owner_update(self.client, update, pending), {"intent": "clarify"})
        self.assertNotIn("pageApprovals.confirm", [m for m, _ in self.calls])
        proposal["revision"] = 2
        self.assertEqual(bridge.handle_owner_update(self.client, update, pending), {"ok": True})

    def test_runner_uses_campaign_tools_without_owner_credentials(self):
        self.campaign_fixture()
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        self.tick()
        prompt = self.agent.call_args.args[0]
        for name in ("pageCampaigns.propose", "pageCampaigns.schedule", "pageCampaigns.collect", "pageCampaigns.report", "pageCampaigns.optimize"):
            self.assertIn(name, prompt)
        for forbidden in ("drafts.approve", "campaigns.create", "receiverKeyId", "confirmationRef"):
            self.assertNotIn(forbidden, prompt)
        tools = bridge.build_tools(self.client.describe())
        self.assertIn("pageCampaigns.schedule", [tool["_method"] for tool in tools])
        self.assertNotIn("drafts.approve", [tool["_method"] for tool in tools])
        with open(self.path) as handle:
            self.assertNotIn("grant", handle.read())

    def test_grant_does_not_add_agent_budget(self):
        self.campaign_fixture()
        for attempt in range(4):
            self.work = self.item(status="pending", attempts=40 + attempt)
            self.claim = self.item(attempts=41 + attempt) if attempt < 3 else None
            self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
            self.tick()
        self.assertEqual(self.agent.call_count, 3)
        self.assertEqual([m for m, _ in self.calls].count("pageWork.claimDue"), 4)

    def test_campaign_notifications_survive_lost_event(self):
        proposal, _, grant, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        sender.send_once.side_effect = TimeoutError("synthetic ambiguous send")
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 1)
        self.assertIn("pageCampaigns.report", [m for m, _ in self.calls])
        self.assertNotIn("pageWork.get", [m for m, _ in self.calls])
        keys = list(bridge._load_protected_state(self.path)["deliveries"])
        self.assertEqual(len(keys), 1)
        for value in ("ws", "page", "campaign", "grant"):
            self.assertIn(value, keys[0])
        grant["status"], grant["revision"] = "revoked", 2
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 2)
        self.assertIn("revoked", sender.send_once.call_args.args[0])
        self.agent.assert_not_called()

    def test_campaign_revoke_is_revision_bound_and_reports_policy(self):
        proposal, _, grant, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        sender.send_once.return_value = {"chat": {"id": 12}, "message_id": 7}
        action = {"kind": "revokeCampaignGrant", "pageId": "page", "grantId": "grant", "expectedGrantRevision": 1}
        entry = bridge.ProtectedWatcher(self.client, sender, self.path).deliver(["revoke"], "", action)
        self.assertEqual(entry["status"], "sent")
        self.assertIn("Thu hồi grant grant", sender.send_once.call_args.args[0])
        update = {"update_id": 1, "message": {"message_id": 8, "chat": {"id": 12}, "from": {"id": 34},
                  "text": "đồng ý", "reply_to_message": {"message_id": 7}}}
        grant["revision"] = 2
        self.assertEqual(bridge.handle_owner_update(self.client, update, entry["ticket"]), {"intent": "clarify"})
        self.assertNotIn("pageApprovals.confirm", [m for m, _ in self.calls])
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        for expected in ("schedulePost", "09:30", "1 bài/ngày", "7 bài/grant"):
            self.assertIn(expected, sender.send_once.call_args.args[0])

    def test_campaign_expiry_scope_and_prepare_mismatch_fail_closed(self):
        proposal, _, grant, _, ticket = self.campaign_fixture()
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        original = self.client.call.side_effect
        def changed(method, params=None, **kwargs):
            if method == "pageApprovals.prepare":
                return {"ticket": dict(ticket, action=dict(ticket["action"], expectedProposalRevision=3))}
            return original(method, params, **kwargs)
        self.client.call.side_effect = changed
        with self.assertRaises(bridge.BridgeError):
            bridge.ProtectedWatcher(self.client, sender, self.path).deliver(["mismatch"], "", ticket["action"])
        sender.send_once.assert_not_called()
        self.client.call.side_effect = original
        proposal["status"] = "accepted"
        with mock.patch.object(bridge.time, "time", return_value=self.now + 8 * 86400):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertIn('"expired"', sender.send_once.call_args.args[0])
        calls = sender.send_once.call_count
        grant["pageId"] = "other"
        with self.assertRaises(bridge.BridgeError):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, calls)

    def test_latest_decision_and_source_loss_change_same_period_delivery_key(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        latest = {"decision": {"id": "decision-keep", "campaignId": "campaign", "grantId": "grant",
                  "grantRevision": 1, "kind": "keep", "before": "A", "after": "A",
                  "observationRefs": ["controlled-scan"], "sampleSizes": {"variant:A": 5},
                  "coverage": {"variant:A": 1}, "reason": "insufficient_evidence", "createdAt": self.now * 1000},
                  "evidenceAvailable": True}
        original = self.client.call.side_effect
        def call(method, params=None, **kwargs):
            value = original(method, params, **kwargs)
            return dict(value, latestDecision=latest) if method == "pageCampaigns.get" else value
        self.client.call.side_effect = call
        sender = mock.Mock()
        sender.send_once.side_effect = TimeoutError("ambiguous synthetic delivery")
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            for kind in ("keep", "variant", "time"):
                latest["decision"].update(id="decision-" + kind, kind=kind, after=600 if kind == "time" else "B")
                before = sender.send_once.call_count
                bridge.ProtectedWatcher(self.client, sender, self.path).poll()
                bridge.ProtectedWatcher(self.client, sender, self.path).poll()
                self.assertEqual(sender.send_once.call_count, before + 1)
                text = sender.send_once.call_args.args[0]
                for value in ("decision-" + kind, "controlled-scan", "variant:A", "tại thời điểm quyết định", "không chứng minh quyền thực thi hiện tại"):
                    self.assertIn(value, text)
            latest["evidenceAvailable"] = False
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 4)
        self.assertIn("nguồn hiện không còn khả dụng", sender.send_once.call_args.args[0])
        state = bridge._load_protected_state(self.path)
        self.assertEqual(len(state["deliveries"]), 4)
        self.assertTrue(all(entry["status"] == "uncertain" for entry in state["deliveries"].values()))
        self.assertNotIn("pageWork.get", [m for m, _ in self.calls])
        self.assertFalse(any(m in ("pageCampaigns.optimize", "pageApprovals.confirm", "pageWork.claimDue") for m, _ in self.calls))
        self.agent.assert_not_called()

    def test_latest_decision_invalid_scope_or_availability_never_sends(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        sender = mock.Mock()
        for campaign_id, available in (("foreign", True), ("campaign", "true")):
            def call(method, params=None, **kwargs):
                value = original(method, params, **kwargs)
                latest = {"decision": {"campaignId": campaign_id, "kind": "keep"}, "evidenceAvailable": available}
                return dict(value, latestDecision=latest) if method == "pageCampaigns.get" else value
            self.client.call.side_effect = call
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.ProtectedWatcher(self.client, sender, self.path).poll()
            self.assertEqual(caught.exception.code, "CONFLICT")
        sender.send_once.assert_not_called()

    def test_latest_decision_absent_or_null_never_claims_a_change(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        original = self.client.call.side_effect
        for explicit_null in (False, True):
            def call(method, params=None, **kwargs):
                value = original(method, params, **kwargs)
                return dict(value, latestDecision=None) if method == "pageCampaigns.get" and explicit_null else value
            self.client.call.side_effect = call
            path = os.path.join(self.tmp.name, "latest-%s.json" % explicit_null)
            bridge.ProtectedWatcher(self.client, sender, path).poll()
            self.assertIn("chưa có quyết định được ghi nhận", sender.send_once.call_args.args[0])
            self.assertIn("không chứng minh quyền thực thi hiện tại", sender.send_once.call_args.args[0])

    def test_ineligible_campaign_proposal_does_not_block_reports_drafts_or_recovery(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        self.cap["principal"]["kind"] = "page_receiver"
        self.work = self.item(status="completed", draftIds=["legacy-draft"])
        original = self.client.call.side_effect
        eligible = [False]
        def call(method, params=None, **kwargs):
            if method == "pageApprovals.prepare" and params["action"]["proposalId"] == proposal["id"] and not eligible[0]:
                raise bridge.BridgeError("CONFLICT", "Synthetic paused Page")
            if method == "pageWork.draft":
                return {"draft": {"id": "legacy-draft", "revision": 1, "text": "Legacy draft survives"}}
            value = original(method, params, **kwargs)
            if method == "pageCampaigns.list":
                value = dict(value, proposals=value["proposals"] + [dict(proposal, id="other-proposal")])
            return value
        self.client.call.side_effect = call
        sender = mock.Mock()
        sender.send_once.return_value = {"chat": {"id": 12}, "message_id": 7}
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            for _ in range(2):
                try:
                    bridge.ProtectedWatcher(self.client, sender, self.path).poll()
                except bridge.BridgeError as err:
                    self.fail("Ineligible proposal blocked reconciliation: " + err.code)
            self.assertEqual(sender.send_once.call_count, 3)
            state = bridge._load_protected_state(self.path)
            refused_key = json.dumps(["ws", "page", "proposal", "proposal", 2], separators=(",", ":"))
            self.assertNotIn(refused_key, state["deliveries"])
            self.assertIn("pageCampaigns.report", [m for m, _ in self.calls])
            self.assertIn("pageWork.list", [m for m, _ in self.calls])
            self.assertTrue(any("Legacy draft survives" in c.args[0] for c in sender.send_once.call_args_list))
            eligible[0] = True
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 4)
        self.assertEqual(bridge._load_protected_state(self.path)["deliveries"][refused_key]["status"], "sent")
        self.agent.assert_not_called()

    def test_campaign_prepare_auth_transport_and_system_failures_still_abort(self):
        self.campaign_fixture()
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        sender = mock.Mock()
        for code in ("FORBIDDEN", "UNAUTHORIZED", "UNREACHABLE", "INTERNAL"):
            with self.subTest(code=code):
                def call(method, params=None, **kwargs):
                    if method == "pageApprovals.prepare":
                        raise bridge.BridgeError(code, "Synthetic refusal")
                    return original(method, params, **kwargs)
                self.client.call.side_effect = call
                with self.assertRaises(bridge.BridgeError) as caught:
                    bridge.ProtectedWatcher(self.client, sender, self.path).poll()
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(bridge._load_protected_state(self.path), {})
        sender.send_once.assert_not_called()

    def test_large_campaign_report_is_bounded_unicode_safe_and_restart_stable(self):
        proposal, _, grant, report, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        proposal["input"].update(name=chr(0x1F680) * 50, goal=chr(0x1F680) * 200)
        grant["policy"]["allowedMinutes"] = list(range(1440))
        self.cap["principal"]["kind"] = "page_receiver"
        report["missingReasons"] = ["missing_source_" + str(i) for i in range(100)]
        latest = {"decision": {"id": "large-decision", "campaignId": "campaign", "grantId": "grant", "grantRevision": 1,
                  "kind": "keep", "before": "A", "after": "A", "createdAt": self.now * 1000,
                  "reason": "insufficient_evidence", "observationRefs": ["controlled-source-" + str(i) for i in range(100)],
                  "sampleSizes": {"time:" + str(i): 0 for i in range(1440)},
                  "coverage": {"time:" + str(i): 0 for i in range(1440)}}, "evidenceAvailable": False}
        original = self.client.call.side_effect
        selected = [latest]
        def call(method, params=None, **kwargs):
            value = original(method, params, **kwargs)
            if method == "pageCampaigns.get":
                return dict(value, latestDecision=selected[0], grants=[dict(grant, id="history-" + str(i), status="revoked") for i in range(10)])
            return value
        self.client.call.side_effect = call
        for has_decision, uncertain in ((True, False), (False, False), (True, True)):
            with self.subTest(has_decision=has_decision, uncertain=uncertain):
                selected[0] = latest if has_decision else None
                sender = mock.Mock()
                def send(text):
                    self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096, "transport rejected oversize")
                    if uncertain:
                        raise TimeoutError("synthetic ambiguity")
                    return {"chat": {"id": 12}, "message_id": 7}
                sender.send_once.side_effect = send
                path = os.path.join(self.tmp.name, "large-report-%s-%s.json" % (has_decision, uncertain))
                with mock.patch.object(bridge.time, "time", return_value=self.now):
                    bridge.ProtectedWatcher(self.client, sender, path).poll()
                    bridge.ProtectedWatcher(self.client, sender, path).poll()
                self.assertEqual(sender.send_once.call_count, 1)
                entries = bridge._load_protected_state(path)["deliveries"]
                self.assertEqual(len(entries), 1)
                self.assertEqual(next(iter(entries.values()))["status"], "uncertain" if uncertain else "sent")
                text = sender.send_once.call_args.args[0]
                self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096)
                for value in ("page", "campaign", "10", "lược", "pageCampaigns.get", "pageCampaigns.report", "chưa đo được", "không chứng minh quyền thực thi hiện tại"):
                    self.assertIn(value, text)
                if has_decision:
                    for value in ("large-decision", "keep", "insufficient_evidence", "tại thời điểm quyết định", "nguồn hiện không còn khả dụng"):
                        self.assertIn(value, text)
                else:
                    self.assertIn("chưa có quyết định được ghi nhận", text)
        self.agent.assert_not_called()

    def test_oversize_campaign_consent_never_prepares_sends_or_persists_intent(self):
        proposal, _, grant, _, ticket = self.campaign_fixture()
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        sender.send_once.return_value = {"chat": {"id": 12}, "message_id": 7}
        for kind, minute_count in (("grantCampaign", 1440), ("revokeCampaignGrant", 1440), ("grantCampaign", 400)):
            with self.subTest(kind=kind, minute_count=minute_count):
                grant["policy"]["allowedMinutes"] = list(range(minute_count))
                # 500 supplementary characters fit the server's 1000 UTF-16-unit goal limit.
                proposal["input"]["goal"] = chr(0x1F680) * 500 if minute_count == 400 else "Pilot"
                action = ticket["action"] if kind == "grantCampaign" else {
                    "kind": kind, "pageId": "page", "grantId": "grant", "expectedGrantRevision": 1}
                before = len(self.calls)
                result = bridge.ProtectedWatcher(self.client, sender, self.path).deliver([kind, minute_count], "", action)
                self.assertEqual(result["status"], "oversize")
                self.assertNotIn("pageApprovals.prepare", [m for m, _ in self.calls[before:]])
                self.assertEqual(bridge._load_protected_state(self.path), {})
        sender.send_once.assert_not_called()

    def test_normal_campaign_report_stays_complete_and_sent_once(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock(return_value={"chat": {"id": 12}, "message_id": 7})
        with mock.patch.object(bridge.time, "time", return_value=self.now):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 1)
        text = sender.send_once.call_args.args[0]
        self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096)
        self.assertIn("09:30", text)
        self.assertIn("schedulePost", text)
        self.assertNotIn("lược", text)
        self.assertEqual(next(iter(bridge._load_protected_state(self.path)["deliveries"].values()))["status"], "sent")

    def test_public_poll_classifies_campaign_hints_and_recovers_missing_work(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        recovered = self.item(id="recovered", status="waiting", draftIds=["recovered-draft"])
        revision = [1]
        afters, lookups = [], []
        def call(method, params=None, **kwargs):
            if method == "pageWork.events":
                afters.append(params["after"])
                hints = [
                    {"seq": 1, "type": "pageCampaigns.proposalChanged", "pageId": "page", "proposalId": "proposal", "revision": 2, "status": "accepted", "createdAt": 1},
                    {"seq": 2, "type": "pageCampaigns.grantChanged", "pageId": "page", "campaignId": "campaign", "grantId": "grant", "revision": 1, "status": "active", "createdAt": 2},
                    {"seq": 3, "type": "pageWork.draftSaved", "pageId": "page", "workId": "recovered", "draftId": "recovered-draft", "revision": 1, "createdAt": 3}]
                return {"workspaceId": "ws", "events": [h for h in hints if h["seq"] > params["after"]], "nextCursor": 3}
            if method == "pageWork.get":
                lookups.append(params["workId"])
                self.assertEqual(params["workId"], "recovered", "campaign hints must not invent work ownership")
                return {"work": recovered}
            if method == "pageWork.draft":
                return {"draft": {"id": "recovered-draft", "revision": revision[0], "text": "Recovered draft"}}
            return original(method, params, **kwargs)
        self.client.call.side_effect = call
        for uncertain in (False, True):
            with self.subTest(uncertain=uncertain):
                revision[0] = 1
                afters.clear(); lookups.clear()
                path = os.path.join(self.tmp.name, "mixed-hints-%s.json" % uncertain)
                sender = mock.Mock()
                def send(text):
                    if uncertain and "Recovered draft" in text:
                        raise TimeoutError("synthetic unknown draft delivery")
                    return {"chat": {"id": 12}, "message_id": 7}
                sender.send_once.side_effect = send
                with mock.patch.object(bridge.time, "time", return_value=self.now):
                    self.assertEqual(bridge.ProtectedWatcher(self.client, sender, path).poll(), 3)
                    saved = bridge._load_protected_state(path)
                    self.assertEqual(saved["cursor"], 3)
                    self.assertEqual(saved["workIds"], ["recovered"])
                    self.assertEqual(sender.send_once.call_count, 2)
                    self.assertEqual(bridge.ProtectedWatcher(self.client, sender, path).poll(), 3)
                    self.assertEqual(sender.send_once.call_count, 2)
                    self.assertEqual(bridge._load_protected_state(path)["deliveries"], saved["deliveries"])
                    revision[0] = 2  # Known unfinished work remains recoverable even with no new events.
                    bridge.ProtectedWatcher(self.client, sender, path).poll()
                self.assertEqual(sender.send_once.call_count, 3)
                self.assertEqual(afters, [0, 3, 3])
                self.assertEqual(lookups, ["recovered"] * 3)
                statuses = [entry["status"] for entry in saved["deliveries"].values()]
                self.assertEqual(statuses.count("uncertain"), int(uncertain))
        self.agent.assert_not_called()

    def test_public_poll_does_not_ignore_malformed_work_hints(self):
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        sender = mock.Mock()
        for event_type in ("pageWork.changed", "pageWork.draftSaved", "pageWork.businessChanged", "unknown"):
            with self.subTest(event_type=event_type):
                def call(method, params=None, **kwargs):
                    if method == "pageWork.events":
                        return {"workspaceId": "ws", "events": [{"type": event_type, "pageId": "page"}], "nextCursor": 4}
                    return original(method, params, **kwargs)
                self.client.call.side_effect = call
                with self.assertRaises(KeyError):
                    bridge.ProtectedWatcher(self.client, sender, self.path).poll()
                self.assertNotIn("cursor", bridge._load_protected_state(self.path))
        sender.send_once.assert_not_called()

    def test_finance_unavailable_is_not_zero(self):
        proposal, _, _, _, _ = self.campaign_fixture()
        proposal["status"] = "accepted"
        self.cap["principal"]["kind"] = "page_receiver"
        sender = mock.Mock()
        bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 1)
        text = sender.send_once.call_args.args[0]
        for expected in ("chưa đo được", "chưa đủ dữ liệu để điều chỉnh", "missing_publish_proof", "không tự gia hạn"):
            self.assertIn(expected, text)
        self.assertNotIn("0%", text)
        self.assertNotIn("pageApprovals.confirm", [m for m, _ in self.calls])

    def test_protected_tick_rejects_legacy_key(self):
        self.cap["principal"]["kind"] = "legacy"
        self.assertTrue(callable(getattr(bridge, "protected_brief_tick", None)), "missing protected tick")
        with self.assertRaises(bridge.BridgeError) as caught:
            self.tick()
        self.assertEqual(caught.exception.code, "FORBIDDEN")
        self.agent.assert_not_called()
        self.assertEqual([m for m, _ in self.calls], ["system.capabilities"])

    def test_no_work_calls_no_agent(self):
        self.tick()
        self.agent.assert_not_called()

    def test_waiting_video_only_polls(self):
        self.work = self.item(status="waiting", videoId="v", waitFor="video")
        self.tick()
        self.agent.assert_not_called()
        self.assertIn("pageWork.reconcile", [m for m, _ in self.calls])
        self.assertNotIn("pageWork.claimDue", [m for m, _ in self.calls])

    def test_resume_after_media_expiry_does_not_render(self):
        self.work = self.item(status="pending", videoId="v")
        self.claim = self.item(videoId="v")
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        self.tick()
        self.assertEqual(self.agent.call_count, 1)
        self.assertIn('"videoId": "v"', self.agent.call_args[0][0])
        self.assertFalse(any("render" in m or "videos." in m for m, _ in self.calls))

    def test_three_invocations_across_steps(self):
        for attempt in range(1, 5):
            self.work = self.item(status="pending", attempts=attempt - 1)
            # Daily admission belongs to the server, not the lifetime work.attempts field.
            self.claim = self.item(attempts=attempt, claimedAt=attempt) if attempt <= 3 else None
            self.agent.side_effect = lambda *args: (self.work.update(status="waiting") or (0, False))
            self.tick()
        self.assertEqual(self.agent.call_count, 3)

    def test_server_admitted_fourth_lifetime_attempt_runs_once(self):
        self.work = self.item(status="pending", attempts=3)
        self.claim = self.item(attempts=4, claimedAt=456)
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        self.assertEqual(self.tick()["ran"], ["w"])
        self.assertEqual(self.agent.call_count, 1)
        self.assertEqual([m for m, _ in self.calls].count("pageWork.claimDue"), 1)

    def test_nonactionable_owner_reply_requires_new_proposal(self):
        pending = {"id": "ticket", "chatId": "12", "senderId": "34", "messageId": 7,
                   "expiresAt": int(time.time() * 1000) + 10000, "workId": "w",
                   "action": {"kind": "approveDraft", "pageId": "page", "draftId": "d",
                              "expectedRevision": 2, "timing": {"when": "now"}}}
        update = {"update_id": 1, "message": {"message_id": 8, "chat": {"id": 12}, "from": {"id": 34},
                  "text": "ok", "reply_to_message": {"message_id": 7}}}
        for status in ("promoted", "removed"):
            client = mock.Mock()
            client.call.side_effect = [{"pageOperations": 1, "principal": {"kind": "page_receiver"}},
                                       {"draft": {"id": "d", "status": status}}]
            self.assertEqual(bridge.handle_owner_update(client, update, pending), {"intent": "clarify"})
            self.assertNotIn("pageApprovals.confirm", [c.args[0] for c in client.call.call_args_list])
            sender = mock.Mock()
            client.call.side_effect = [{"pageOperations": 1, "principal": {"kind": "page_receiver"}},
                                       {"draft": {"id": "d", "status": status}}]
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.ProtectedWatcher(client, sender, self.path).deliver([status], "", pending["action"], "w")
            self.assertEqual(caught.exception.code, "CONFLICT")
            sender.send_once.assert_not_called()

    def test_prompt_separates_evidence_hypothesis_and_unknown(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        self.tick()
        prompt = self.agent.call_args[0][0]
        for value in ("observed", "hypothesis", "unknown", "ROI", "pageWork.saveDraft", "draftIndex",
                      "confirmed", "giá", "cam kết", "vùng phục vụ", "khả năng đáp ứng", "không tự xác nhận", "needs_review"):
            self.assertIn(value, prompt)
        for key, value in self.preparation.items():
            self.assertIn(json.dumps(value, ensure_ascii=False), prompt)

    def test_owner_reply_must_match_pending_revision(self):
        self.assertTrue(callable(getattr(bridge, "handle_owner_update", None)), "missing owner adapter")
        pending = {"id": "ticket", "chatId": "12", "senderId": "34", "messageId": 7,
                   "expiresAt": int(time.time() * 1000) + 10000, "workId": "w",
                   "action": {"kind": "approveDraft", "pageId": "page", "draftId": "d",
                              "expectedRevision": 2, "timing": {"when": "now"}}}
        update = {"update_id": 1, "message": {"message_id": 8, "chat": {"id": 12}, "from": {"id": 34},
                  "text": "ok", "reply_to_message": {"message_id": 7}}}
        client = mock.Mock()
        client.call.side_effect = [{"pageOperations": 1, "principal": {"kind": "page_receiver"}},
                                   {"draft": {"id": "d", "revision": 3}}]
        result = bridge.handle_owner_update(client, update, pending)
        self.assertEqual(result["intent"], "clarify")
        self.assertNotIn("pageApprovals.confirm", [c.args[0] for c in client.call.call_args_list])

    def test_install_rejects_shared_secret_access(self):
        self.assertTrue(callable(getattr(bridge, "check_protected_install", None)), "missing isolation check")
        account = mock.Mock(pw_uid=1001, pw_dir="/runner")
        receiver = mock.Mock(pw_uid=1001, pw_dir="/receiver")
        run = mock.Mock()
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install("/runner/.env", account, "runner", "/receiver/.env",
                                           receiver, run, self.tmp.name)
        run.assert_not_called()

    def test_send_timeout_is_not_blindly_retried(self):
        self.assertTrue(callable(getattr(bridge, "ProtectedWatcher", None)), "missing durable receiver")
        sender = mock.Mock()
        sender.send_once.side_effect = TimeoutError("unknown delivery")
        watcher = bridge.ProtectedWatcher(self.client, sender, self.path)
        key = ["ws", "w", "d", 2]
        watcher.deliver(key, "Draft d revision 2")
        restarted = bridge.ProtectedWatcher(self.client, sender, self.path)
        restarted.deliver(key, "Draft d revision 2")
        self.assertEqual(sender.send_once.call_count, 1)
        with open(self.path) as handle:
            self.assertIn("uncertain", handle.read())


class ProtectedBoundaryTests(unittest.TestCase):
    setUp = ProtectedPageTests.setUp
    call = ProtectedPageTests.call
    item = ProtectedPageTests.item
    tick = ProtectedPageTests.tick

    def test_missing_receiver_os_user_is_config_error_not_traceback(self):
        with open(self.path, "w") as handle:
            handle.write("# fake runner config\n")
        def account(name):
            if name == "runner":
                return mock.Mock(pw_uid=1001, pw_gid=1001, pw_dir=self.tmp.name)
            raise KeyError(name)
        with self.assertRaises(bridge.BridgeError):
            bridge.install_brief(self.path, "runner", "test", None, mock.Mock(), self.tmp.name, account,
                                 protected=True, receiver_env="/receiver/.env", receiver_user="missing")

    def test_kill_after_intent_before_send_return_suppresses_restart_retry(self):
        sender = mock.Mock()
        sender.send_once.side_effect = SystemExit("simulated process death")
        with self.assertRaises(SystemExit):
            bridge.ProtectedWatcher(self.client, sender, self.path).deliver(["ws", "w", "d", 2], "draft")
        bridge.ProtectedWatcher(self.client, sender, self.path).deliver(["ws", "w", "d", 2], "draft")
        self.assertEqual(sender.send_once.call_count, 1)

    def test_protected_dry_run_uses_capabilities_and_never_invokes_or_writes_state(self):
        env_file = os.path.join(self.tmp.name, ".env")
        with open(env_file, "w") as handle:
            handle.write("MAIHUB_URL=https://invalid.test:7443\nMAIHUB_API_KEY=" + API_KEY +
                         "\nMAIHUB_CERT_SHA256=" + PIN + "\n")
        for enabled in (False, True):
            self.cap["protectedWritesEnabled"] = enabled
            with mock.patch.object(bridge, "MaiHubClient", return_value=self.client), \
                    mock.patch.object(bridge.shutil, "which", return_value="/usr/bin/claude"), \
                    mock.patch.object(bridge, "run_protected_agent") as agent, \
                    mock.patch("sys.stdout", io.StringIO()), mock.patch("sys.stderr", io.StringIO()):
                code = bridge.main(["brief-tick", "--protected", "--env-file", env_file,
                                    "--state", self.path, "--dry-run"])
            self.assertEqual(code == 0, enabled)
            agent.assert_not_called()
            self.assertFalse(os.path.exists(self.path))
        self.assertEqual([m for m, _ in self.calls], ["system.capabilities", "system.capabilities"])

    def test_pending_backoff_is_not_claimed_before_next_check(self):
        self.work = self.item(status="pending", nextCheckAt=self.now * 1000 + 60000)
        self.claim = self.item()
        self.tick()
        self.agent.assert_not_called()
        self.assertNotIn("pageWork.claimDue", [m for m, _ in self.calls])

    def test_budget_exhaustion_and_slow_claim_preserve_headroom(self):
        with mock.patch.object(bridge.time, "monotonic", side_effect=[0, 3301]):
            self.tick()
        self.assertNotIn("pageWork.claimDue", [m for m, _ in self.calls])
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        with mock.patch.object(bridge.time, "monotonic", side_effect=[0, 2000, 2001]):
            self.tick()
        self.assertEqual(self.agent.call_args.args[1], 1119)

    def test_budget_consumed_during_claim_releases_owned_lease_without_agent(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        with mock.patch.object(bridge.time, "monotonic", side_effect=[0, 0, 3121]):
            self.tick()
        self.agent.assert_not_called()
        failures = [params for method, params in self.calls if method == "pageWork.fail"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["code"], "busy")
        self.assertEqual(failures[0]["claimedAt"], 123)

    def test_receiver_revoked_403_does_not_send_or_advance(self):
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        def revoked(method, params=None, **kw):
            if method == "pageWork.events":
                raise bridge.BridgeError("FORBIDDEN", "HTTP 403 revoked")
            return original(method, params, **kw)
        self.client.call.side_effect = revoked
        sender = mock.Mock()
        with self.assertRaises(bridge.BridgeError):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        sender.send_once.assert_not_called()
        self.assertFalse(os.path.exists(self.path))

    def test_restart_after_claim_save_failure_reconciles_without_duplicate_invoke(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        save = bridge._save_protected_state
        count = [0]
        def disk_full(path, state):
            count[0] += 1
            if count[0] == 2:
                raise OSError("claim persisted remotely, local disk full")
            save(path, state)
        with mock.patch.object(bridge, "_save_protected_state", side_effect=disk_full):
            with self.assertRaises(OSError):
                self.tick()
        self.assertEqual(self.work["status"], "running")
        self.agent.assert_not_called()
        self.tick()
        self.agent.assert_not_called()
        self.assertEqual(sum(m == "pageWork.claimDue" for m, _ in self.calls), 1)

    def test_killed_agent_restart_does_not_invoke_live_lease_again(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.side_effect = SystemExit("simulated runner death during agent")
        with self.assertRaises(SystemExit):
            self.tick()
        self.tick()
        self.assertEqual(self.agent.call_count, 1)

    def test_protected_lock_prevents_overlapping_claims(self):
        with open(self.path + ".lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.tick(), {"skipped": "locked"})
        self.agent.assert_not_called()
        self.assertEqual([m for m, _ in self.calls], ["system.capabilities"])

    def test_fresh_empty_receiver_persists_cursor_without_sending(self):
        self.path = os.path.join(self.tmp.name, "new", "receiver.json")
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        self.client.call.side_effect = lambda method, params=None, **kw: (
            {"workspaceId": "ws", "events": [], "nextCursor": 2} if method == "pageWork.events"
            else original(method, params, **kw))
        sender = mock.Mock()
        self.assertEqual(bridge.ProtectedWatcher(self.client, sender, self.path).poll(), 2)
        sender.send_once.assert_not_called()

    def test_proposal_changed_revision_is_not_prepared_or_sent(self):
        self.cap["principal"]["kind"] = "page_receiver"
        original = self.client.call.side_effect
        self.client.call.side_effect = lambda method, params=None, **kw: (
            {"draft": {"revision": 3, "text": "new revision"}} if method == "pageWork.draft"
            else original(method, params, **kw))
        action = {"kind": "approveDraft", "pageId": "page", "draftId": "d", "expectedRevision": 2,
                  "timing": {"when": "now"}}
        sender = mock.Mock()
        with self.assertRaises(bridge.BridgeError):
            bridge.ProtectedWatcher(self.client, sender, self.path).deliver(
                ["ws", "w", "d", 2, "approval"], "summary", action, "w")
        sender.send_once.assert_not_called()
        self.assertNotIn("pageApprovals.prepare", [m for m, _ in self.calls])

    def test_live_running_lease_and_needs_review_never_claim(self):
        for status in ("running", "needs_review", "cancelled"):
            self.work = self.item(status=status)
            self.claim = None
            self.tick()
        self.agent.assert_not_called()
        self.assertEqual(sum(m == "pageWork.claimDue" for m, _ in self.calls), 1)

    def test_agent_timeout_marks_uncertain_and_never_calls_finish(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.return_value = (-15, True)
        self.tick()
        self.assertEqual(self.work["status"], "needs_review")
        self.assertNotIn("pageWork.finish", [m for m, _ in self.calls])
        self.tick()
        self.assertEqual(self.agent.call_count, 1)

    def test_deleted_event_history_and_known_work_recover_without_duplicate(self):
        self.cap["principal"]["kind"] = "page_receiver"
        bridge._save_protected_state(self.path, {"workspaceId": "ws", "workIds": ["w"], "cursor": 900})
        self.work = self.item(status="completed", draftIds=["d"])
        original = self.client.call.side_effect
        def receiver(method, params=None, **kw):
            if method == "pageWork.list":
                return {"items": []}
            if method == "pageWork.events":
                return {"events": [], "nextCursor": 901, "workspaceId": "ws"}
            if method == "pageWork.draft":
                return {"draft": {"id": "d", "revision": 2, "text": "draft"}}
            return original(method, params, **kw)
        self.client.call.side_effect = receiver
        sender = mock.Mock()
        for _ in range(2):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 1)

    def test_fact_proposal_includes_current_fact_and_rejects_stale_business(self):
        action = {"kind": "confirmFact", "pageId": "page", "factId": "f", "expectedRevision": 2}
        client = mock.Mock()
        revision = [2]
        def call(method, params=None, **kw):
            if method == "system.capabilities":
                return {"pageOperations": 1, "principal": {"kind": "page_receiver"}}
            if method == "pageBusiness.get":
                return {"business": {"revision": revision[0], "facts": [
                    {"id": "f", "topic": "location", "value": "Verified owner location", "reason": "owner review"}]}}
            if method == "pageApprovals.prepare":
                return {"ticket": {"id": "t", "action": action, "chatId": "12", "senderId": "34"}}
            if method == "pageApprovals.bindMessage":
                return {"bound": True}
            raise AssertionError(method)
        client.call.side_effect = call
        sender = mock.Mock()
        sender.send_once.return_value = {"message_id": 7, "chat": {"id": 12}}
        watcher = bridge.ProtectedWatcher(client, sender, self.path)
        watcher.deliver(["ws", "w", "fact", 2], "vague NL", action, "w")
        self.assertIn("Verified owner location", sender.send_once.call_args.args[0])
        revision[0] = 3
        with self.assertRaises(bridge.BridgeError):
            watcher.deliver(["ws", "w", "fact", 3], "vague NL", action, "w")
        self.assertEqual(sender.send_once.call_count, 1)

    def test_corrupt_receiver_state_does_not_resend(self):
        with open(self.path, "w") as handle:
            handle.write("broken-json")
        sender = mock.Mock()
        with self.assertRaises(bridge.BridgeError):
            bridge.ProtectedWatcher(self.client, sender, self.path).deliver(["ws", "w", "d", 2], "draft")
        sender.send_once.assert_not_called()

    def test_protected_install_candidate_checks_before_units_and_gate_failure_writes_nothing(self):
        home = os.path.join(self.tmp.name, "runner")
        receiver_home = os.path.join(self.tmp.name, "receiver")
        units = os.path.join(self.tmp.name, "units")
        for path in (home, receiver_home, units):
            os.mkdir(path)
        env_file = os.path.join(home, ".env")
        with open(env_file, "w") as handle:
            handle.write("MAIHUB_API_KEY=mh_fake_scoped\n")
        with open(os.path.join(receiver_home, ".env"), "w") as handle:
            handle.write("# fake receiver config\n")
        accounts = {"runner": mock.Mock(pw_uid=1001, pw_gid=1001, pw_dir=home),
                    "receiver": mock.Mock(pw_uid=1002, pw_gid=1002, pw_dir=receiver_home)}
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            self.assertFalse(os.path.exists(os.path.join(units, "maihub-brief-test.service")))
            if "brief-tick" in command:
                self.assertIn("--protected", command)
                self.assertIn("--dry-run", command)
                self.assertEqual(command[2], "runner")
                return mock.Mock(returncode=2, stderr="gate false")
            return mock.Mock(returncode=0, stdout="[]")
        with mock.patch.object(bridge, "_require_safe_dir"):
            with self.assertRaises(bridge.BridgeError):
                bridge.install_brief(env_file, "runner", "test", None, run, units, accounts.__getitem__,
                                     protected=True, receiver_env=os.path.join(receiver_home, ".env"),
                                     receiver_user="receiver")
        self.assertEqual(len(calls), 4)
        self.assertEqual(os.listdir(units), [])
        self.assertFalse(os.path.exists(os.path.join(home, "state")))

    def test_unavailable_capability_gate_and_revocation_stop_before_agent(self):
        for change in ({"pageOperations": 0}, {"protectedWritesEnabled": False}):
            with self.subTest(change=change):
                previous = dict(self.cap)
                self.cap.update(change)
                with self.assertRaises(bridge.BridgeError):
                    self.tick()
                self.agent.assert_not_called()
                self.cap = previous
        self.work = self.item(status="pending")
        original = self.client.call.side_effect
        def revoked(method, params=None, **kwargs):
            if method == "pageWork.reconcile":
                raise bridge.BridgeError("FORBIDDEN", "revoked")
            return original(method, params, **kwargs)
        self.client.call.side_effect = revoked
        with self.assertRaises(bridge.BridgeError):
            self.tick()
        self.agent.assert_not_called()

    def test_long_video_across_days_and_restart_never_invokes(self):
        self.work = self.item(status="waiting", videoId="v", waitFor="video")
        for days in (0, 1, 7):
            self.now += days * 86400
            self.tick()
        self.agent.assert_not_called()

    def test_disk_full_before_invoke_keeps_claim_for_reconciliation(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        with mock.patch.object(bridge.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.tick()
        self.agent.assert_not_called()
        self.assertFalse(os.path.exists(self.path))

    def test_sender_one_attempt_returns_real_message_or_rejects(self):
        sender = bridge.TelegramSender({"token": "test-only", "chat_id": "12"},
                                      {"api_base": "https://invalid.test"})
        response = mock.Mock()
        response.read.return_value = b'{"ok":true,"result":{"message_id":9,"chat":{"id":12}}}'
        sender.opener = mock.Mock()
        sender.opener.open.return_value = response
        self.assertEqual(sender.send_once("hello")["message_id"], 9)
        response.read.return_value = b'{"ok":true}'
        with self.assertRaises(bridge.BridgeError):
            sender.send_once("hello")
        sender.opener.open.side_effect = TimeoutError("test timeout")
        with self.assertRaises(TimeoutError):
            sender.send_once("hello")
        self.assertEqual(sender.opener.open.call_count, 3)

    def test_protected_cli_defaults_and_child_environment_are_isolated(self):
        args = bridge.build_parser().parse_args(["brief-tick", "--protected", "--state", self.path])
        self.assertTrue(args.protected)
        self.assertFalse(bridge.build_parser().parse_args(["brief-tick"]).protected)
        self.assertTrue(callable(getattr(bridge, "run_protected_agent", None)), "missing isolated process")
        env = {"MAIHUB_URL": "https://invalid.test", "MAIHUB_API_KEY": "mh_scoped_test",
               "MAIHUB_CERT_SHA256": "a" * 64}
        with mock.patch.dict(os.environ, {"TG_TOKEN": "receiver-only-test", "OWNER_KEY": "owner-test"}):
            with mock.patch.object(bridge, "run_agent", return_value=(0, False)) as run:
                bridge.run_protected_agent(env, "hello", 50)
        child = run.call_args.kwargs["env"]
        self.assertNotIn("TG_TOKEN", child)
        self.assertNotIn("OWNER_KEY", child)
        self.assertNotEqual(child["HOME"], os.path.expanduser("~"))
        self.assertIn("--strict-mcp-config", run.call_args.args[0])
        with self.assertRaises(bridge.BridgeError):
            bridge.run_protected_agent(dict(env, TG_TOKEN="forbidden-test"), "hello", 50)

    def test_install_probe_denies_read_or_write_and_legacy_timer(self):
        self.assertTrue(callable(getattr(bridge, "check_protected_install", None)), "missing isolation check")
        runner_home, receiver_home = [os.path.join(self.tmp.name, value) for value in ("runner", "receiver")]
        os.mkdir(runner_home)
        os.mkdir(receiver_home)
        receiver_env = os.path.join(receiver_home, ".env")
        with open(receiver_env, "w") as handle:
            handle.write("# fake receiver path; no secret bytes read\n")
        account = mock.Mock(pw_uid=1001, pw_dir=runner_home)
        receiver = mock.Mock(pw_uid=1002, pw_dir=receiver_home)
        run = mock.Mock(return_value=mock.Mock(returncode=1, stdout="[]"))
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(runner_home, ".env"), account, "runner", receiver_env,
                                           receiver, run, self.tmp.name)
        self.assertIn("runner", run.call_args.args[0])
        run.return_value.returncode = 0
        legacy = os.path.join(self.tmp.name, "maihub-brief-old.service")
        with open(legacy, "w") as handle:
            handle.write("ExecStart=python3 bridge.py brief-tick --env-file /old/.env\n")
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(runner_home, ".env"), account, "runner", receiver_env,
                                           receiver, run, self.tmp.name)
        os.unlink(legacy)
        run.return_value.stdout = '[{"unit":"maihub-brief-transient.timer"}]'
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(runner_home, ".env"), account, "runner", receiver_env,
                                           receiver, run, self.tmp.name)

    def test_install_missing_receiver_file_is_not_isolation_proof(self):
        account = mock.Mock(pw_uid=1001, pw_dir="/runner")
        receiver = mock.Mock(pw_uid=1002, pw_dir="/receiver")
        run = mock.Mock(return_value=mock.Mock(returncode=0, stdout="[]"))
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install("/runner/.env", account, "runner", "/receiver/missing.env",
                                           receiver, run, self.tmp.name)
        run.assert_not_called()

    def test_protected_units_use_same_timer_and_protected_candidate(self):
        self.assertTrue(callable(getattr(bridge, "render_brief_units", None)))
        service, timer = bridge.render_brief_units("one", "runner", "/o/bridge.py", "/r/.env", "/r/state", protected=True)
        self.assertIn("--protected", service)
        self.assertIn("OnCalendar=*:0/15", timer)
        self.assertIn("NoNewPrivileges=yes", service)

    def test_missed_events_recover_draft_revision_and_advance_hidden_cursor(self):
        self.assertTrue(callable(getattr(bridge, "ProtectedWatcher", None)))
        self.cap["principal"]["kind"] = "page_receiver"
        self.work = self.item(status="completed", draftIds=["d"])
        original = self.client.call.side_effect
        def receiver(method, params=None, **kwargs):
            if method == "pageWork.events":
                return {"events": [], "nextCursor": 700, "workspaceId": "ws"}
            if method == "pageWork.draft":
                return {"draft": {"id": "d", "revision": 2, "text": "safe draft"}}
            return original(method, params, **kwargs)
        self.client.call.side_effect = receiver
        sender = mock.Mock()
        sender.send_once.return_value = {"message_id": 9, "chat": {"id": 12}}
        for _ in range(2):
            bridge.ProtectedWatcher(self.client, sender, self.path).poll()
        self.assertEqual(sender.send_once.call_count, 1)
        with open(self.path) as handle:
            self.assertEqual(json.load(handle)["cursor"], 700)
        self.assertNotIn("pageWork.reconcile", [m for m, _ in self.calls])

    def test_restart_before_and_after_send_state_and_disk_full(self):
        self.assertTrue(callable(getattr(bridge, "ProtectedWatcher", None)))
        sender = mock.Mock()
        sender.send_once.return_value = {"message_id": 9, "chat": {"id": 12}}
        watcher = bridge.ProtectedWatcher(self.client, sender, self.path)
        key = ["ws", "w", "d", 2]
        with mock.patch.object(bridge.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                watcher.deliver(key, "draft")
        sender.send_once.assert_not_called()
        save = bridge._save_protected_state
        count = [0]
        def crash_after_send(path, state):
            count[0] += 1
            if count[0] == 2:
                raise OSError("disk full after send")
            save(path, state)
        with mock.patch.object(bridge, "_save_protected_state", side_effect=crash_after_send):
            with self.assertRaises(OSError):
                watcher.deliver(key, "draft")
        bridge.ProtectedWatcher(self.client, sender, self.path).deliver(key, "draft")
        self.assertEqual(sender.send_once.call_count, 1)

    def test_proposal_summary_actual_id_bind_and_expired_ungrounded_reply(self):
        self.assertTrue(callable(getattr(bridge, "ProtectedWatcher", None)))
        action = {"kind": "approveDraft", "pageId": "page", "draftId": "d", "expectedRevision": 2,
                  "timing": {"when": "now"}}
        ticket = {"id": "t", "action": action, "chatId": "12", "senderId": "34", "messageId": None,
                  "expiresAt": int(time.time() * 1000) + 10000}
        client = mock.Mock()
        def call(method, params=None, **kwargs):
            if method == "system.capabilities":
                return {"pageOperations": 1, "principal": {"kind": "page_receiver"}}
            if method == "pageApprovals.prepare":
                return {"ticket": dict(ticket)}
            if method == "pageApprovals.bindMessage":
                self.assertEqual(params["messageId"], 99)
                return {"bound": True}
            if method == "pageWork.draft":
                return {"draft": {"revision": 2, "text": "The exact proposed draft"}}
            if method == "pageApprovals.confirm":
                return {"resourceId": "d", "replayed": False}
            raise AssertionError(method)
        client.call.side_effect = call
        sender = mock.Mock()
        sender.send_once.return_value = {"message_id": 99, "chat": {"id": 12}}
        entry = bridge.ProtectedWatcher(client, sender, self.path).deliver(
            ["ws", "w", "d", 2, "approval"], "untrusted NL summary", action, "w")
        self.assertEqual(entry["status"], "sent")
        self.assertIn('"expectedRevision": 2', sender.send_once.call_args.args[0])
        update = {"update_id": 10, "message": {"message_id": 100, "chat": {"id": 12},
                  "from": {"id": 34}, "text": "ok", "reply_to_message": {"message_id": 99}}}
        pending = entry["ticket"]
        self.assertEqual(bridge.handle_owner_update(client, update, pending)["resourceId"], "d")
        for bad in ({"chat": {"id": 13}}, {"from": {"id": 35}}, {"reply_to_message": {}},
                    {"message_id": True}, {"text": "approve everything"}):
            changed = dict(update, message=dict(update["message"], **bad))
            self.assertEqual(bridge.handle_owner_update(client, changed, pending)["intent"], "clarify")
        pending["expiresAt"] = 0
        self.assertEqual(bridge.handle_owner_update(client, update, pending)["intent"], "clarify")


class ProtectedReviewRegressionTests(unittest.TestCase):
    setUp = ProtectedPageTests.setUp
    call = ProtectedPageTests.call
    item = ProtectedPageTests.item

    def approval_fixture(self, action, canonical):
        client, sender = mock.Mock(), mock.Mock()
        calls = []
        def call(method, params=None, **kwargs):
            calls.append((method, params))
            if method == "system.capabilities":
                return {"pageOperations": 1, "principal": {"kind": "page_receiver"}}
            if method == "pageWork.draft":
                return {"draft": {"revision": 2, "text": "Review this exact draft"}}
            if method == "pageApprovals.prepare":
                self.assertEqual(params["action"], action)
                return {"ticket": {"id": "t", "action": canonical, "chatId": "12", "senderId": "34",
                                   "expiresAt": int(time.time() * 1000) + 60000}}
            if method == "pageApprovals.bindMessage":
                return {"bound": True}
            if method == "pageApprovals.confirm":
                return {"resourceId": "d", "replayed": False}
            raise AssertionError(method)
        client.call.side_effect = call
        sender.send_once.return_value = {"message_id": 7, "chat": {"id": 12}}
        return client, sender, calls

    def test_recurring_day_normalization_uses_one_canonical_action_for_summary_state_and_confirm(self):
        for days in ([5, 1, 5], [5, 1], [1, 5]):
            with self.subTest(days=days):
                action = {"kind": "approveDraft", "pageId": "page", "draftId": "d", "expectedRevision": 2,
                          "timing": {"when": "schedule", "kind": "recurring", "days": days, "time": "09:30"}}
                canonical = dict(action, timing={"when": "schedule", "kind": "recurring", "days": [1, 5], "time": "09:30"})
                original = json.dumps(action, sort_keys=True)
                client, sender, calls = self.approval_fixture(action, canonical)
                path = os.path.join(self.tmp.name, str(len(days)) + str(days[0]) + ".json")
                try:
                    entry = bridge.ProtectedWatcher(client, sender, path).deliver(
                        ["ws", "w", "d", 2, "owner-request"], "untrusted NL", action, "w")
                except bridge.BridgeError as err:
                    self.fail("Valid server day normalization was rejected: " + err.code)
                self.assertEqual(entry["status"], "sent")
                self.assertIn(json.dumps(canonical, ensure_ascii=False), sender.send_once.call_args.args[0])
                pending = entry["ticket"]
                self.assertEqual(pending["action"], canonical)
                saved = next(iter(bridge._load_protected_state(path)["deliveries"].values()))
                self.assertEqual(saved["ticket"]["action"], canonical)
                update = {"update_id": 10, "message": {"message_id": 8, "chat": {"id": 12}, "from": {"id": 34},
                          "text": "ok", "reply_to_message": {"message_id": 7}}}
                self.assertEqual(bridge.handle_owner_update(client, update, pending)["resourceId"], "d")
                self.assertEqual(json.dumps(action, sort_keys=True), original)
                self.assertEqual(sum(method == "pageApprovals.confirm" for method, _ in calls), 1)

    def test_now_once_approvals_remain_supported_and_changed_action_identity_or_timing_is_rejected(self):
        base = {"kind": "approveDraft", "pageId": "page", "draftId": "d", "expectedRevision": 2}
        for index, timing in enumerate(({"when": "now"}, {"when": "schedule", "kind": "once", "runAt": 1800000060000})):
            action = dict(base, timing=timing)
            client, sender, _ = self.approval_fixture(action, action)
            path = os.path.join(self.tmp.name, "valid-%s.json" % index)
            entry = bridge.ProtectedWatcher(client, sender, path).deliver(["ws", "w", "d", 2], "", action, "w")
            self.assertEqual(entry["status"], "sent")
            self.assertEqual(sender.send_once.call_count, 1)
        action = dict(base, timing={"when": "schedule", "kind": "recurring", "days": [5, 1, 5], "time": "09:30"})
        canonical = dict(base, timing={"when": "schedule", "kind": "recurring", "days": [1, 5], "time": "09:30"})
        changes = [{"pageId": "foreign"}, {"draftId": "foreign"}, {"expectedRevision": 3}, {"kind": "resolveWork"},
                   {"timing": dict(canonical["timing"], time="10:00")},
                   {"timing": dict(canonical["timing"], days=[1, 4])}]
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                client, sender, calls = self.approval_fixture(action, dict(canonical, **change))
                with self.assertRaises(bridge.BridgeError) as caught:
                    bridge.ProtectedWatcher(client, sender, os.path.join(self.tmp.name, "bad-%s.json" % index)).deliver(
                        ["ws", "w", "d", 2], "", action, "w")
                self.assertEqual(caught.exception.code, "CONFLICT")
                sender.send_once.assert_not_called()
                self.assertNotIn("pageApprovals.bindMessage", [m for m, _ in calls])

    def run_consumer(self, role, client, agent, sender, path):
        client.describe.return_value = {"methods": []}
        if role == "page_runner":
            return bridge.protected_brief_tick(client, agent, lambda: self.now, path)
        return bridge.ProtectedWatcher(client, sender, path).poll()

    def test_terminal_retention_allows_new_work_across_both_consumer_restarts(self):
        for role in ("page_runner", "page_receiver"):
            for terminal_status in ("completed", "failed", "cancelled"):
                with self.subTest(role=role, terminal=terminal_status):
                    path = os.path.join(self.tmp.name, role + terminal_status + ".json")
                    phase = [0]
                    old = self.item(id="old", status=terminal_status, draftIds=["old-draft"])
                    new = self.item(id="new", status="pending" if role == "page_runner" else "completed",
                                    draftIds=["new-draft"])
                    calls = []
                    def call(method, params=None, **kwargs):
                        calls.append((method, params))
                        if method == "system.capabilities":
                            return {"pageOperations": 1, "protectedWritesEnabled": True,
                                    "principal": dict(self.cap["principal"], kind=role)}
                        if method == "pageWork.list":
                            return {"items": [old if phase[0] == 0 else new]}
                        if method == "pageWork.events":
                            return {"workspaceId": "ws", "events": [], "nextCursor": phase[0] + 1}
                        if method == "pageWork.get":
                            if params["workId"] == "old":
                                raise bridge.BridgeError("FORBIDDEN", "non-disclosing pruned work")
                            return {"work": dict(new), "preparation": self.preparation}
                        if method == "pageWork.reconcile":
                            return {"work": dict(new)}
                        if method == "pageWork.claimDue":
                            if phase[0] and new["status"] == "pending":
                                new["status"] = "running"
                                return {"work": dict(new)}
                            return {"work": None}
                        if method == "pageWork.draft":
                            return {"draft": {"id": params["draftId"], "revision": 2, "text": "draft"}}
                        raise AssertionError(method)
                    client = mock.Mock()
                    client.call.side_effect = call
                    agent = mock.Mock(side_effect=lambda *args: (new.update(status="completed") or (0, False)))
                    sender = mock.Mock()
                    self.run_consumer(role, client, agent, sender, path)
                    deliveries = bridge._load_protected_state(path).get("deliveries", {})
                    phase[0] = 1  # Fake normal terminal-journal pruning, without waiting 30 real days.
                    for _ in range(2):
                        try:
                            self.run_consumer(role, client, agent, sender, path)
                        except bridge.BridgeError as err:
                            self.fail("Routine terminal prune blocked valid work: " + err.code)
                    self.assertFalse(any(m == "pageWork.get" and p["workId"] == "old" for m, p in calls))
                    if role == "page_runner":
                        self.assertEqual(agent.call_count, 1)
                    else:
                        self.assertEqual(sender.send_once.call_count, 2)
                        final = bridge._load_protected_state(path)["deliveries"]
                        for key, entry in deliveries.items():
                            self.assertEqual(final[key], entry)

    def test_runner_completed_invocation_is_not_probed_after_pruning(self):
        self.work, self.claim = self.item(status="pending"), self.item()
        self.agent.side_effect = lambda *args: (self.work.update(status="completed") or (0, False))
        self.run_consumer("page_runner", self.client, self.agent, mock.Mock(), self.path)
        self.work, self.claim = None, None
        original = self.client.call.side_effect
        def pruned(method, params=None, **kwargs):
            if method == "pageWork.get":
                raise bridge.BridgeError("FORBIDDEN", "pruned terminal")
            return original(method, params, **kwargs)
        self.client.call.side_effect = pruned
        try:
            self.run_consumer("page_runner", self.client, self.agent, mock.Mock(), self.path)
        except bridge.BridgeError as err:
            self.fail("Successful invocation left a poisoned terminal ID: " + err.code)
        self.assertEqual(self.agent.call_count, 1)

    def test_known_active_ids_recover_but_forbidden_unknown_ids_still_stop_both_consumers(self):
        for role in ("page_runner", "page_receiver"):
            with self.subTest(role=role):
                path = os.path.join(self.tmp.name, role + "-active.json")
                bridge._save_protected_state(path, {"workspaceId": "ws", "workIds": ["active"],
                    "deliveries": {"old-uncertain": {"status": "uncertain"}}})
                revoked = [False]
                seen = []
                def call(method, params=None, **kwargs):
                    seen.append(method)
                    if method == "system.capabilities":
                        return {"pageOperations": 1, "protectedWritesEnabled": True,
                                "principal": dict(self.cap["principal"], kind=role)}
                    if method == "pageWork.list":
                        return {"items": []}
                    if method == "pageWork.events":
                        return {"workspaceId": "ws", "events": [], "nextCursor": 1}
                    if method in ("pageWork.get", "pageWork.reconcile"):
                        if revoked[0]:
                            raise bridge.BridgeError("FORBIDDEN", "revoked/unknown active ID")
                        return {"work": self.item(id="active", status="waiting")}
                    raise AssertionError(method)
                client = mock.Mock()
                client.call.side_effect = call
                agent, sender = mock.Mock(), mock.Mock()
                self.run_consumer(role, client, agent, sender, path)
                self.assertIn("pageWork.get", seen)
                before = bridge._load_protected_state(path)
                self.assertIn("active", before["workIds"])
                self.assertEqual(before["deliveries"]["old-uncertain"]["status"], "uncertain")
                revoked[0] = True
                with self.assertRaises(bridge.BridgeError) as caught:
                    self.run_consumer(role, client, agent, sender, path)
                self.assertEqual(caught.exception.code, "FORBIDDEN")
                self.assertEqual(bridge._load_protected_state(path), before)
                agent.assert_not_called()
                sender.send_once.assert_not_called()

    def isolated_layout(self, nested=False):
        runner_home = os.path.join(self.tmp.name, "runner")
        receiver_home = os.path.join(runner_home if nested else self.tmp.name, "receiver")
        os.makedirs(receiver_home)
        os.makedirs(runner_home, exist_ok=True)
        receiver_env = os.path.join(receiver_home, "receiver.env")
        with open(receiver_env, "w") as handle:
            handle.write("# temporary fake receiver config\n")
        runner = mock.Mock(pw_uid=1001, pw_dir=runner_home)
        receiver = mock.Mock(pw_uid=1002, pw_dir=receiver_home)
        return runner, receiver, receiver_env

    def permission_probe(self, receiver_home, writable=()):
        executions = []
        def run(command, **kwargs):
            if command[0] != "sudo":
                return subprocess.CompletedProcess(command, 0, "[]", "")
            self.assertEqual(command[2], "runner")
            executions.append(command)
            fake_os = mock.Mock()
            fake_os.path = os.path
            fake_os.R_OK, fake_os.W_OK, fake_os.X_OK = os.R_OK, os.W_OK, os.X_OK
            def access(path, mode):
                if os.path.commonpath([path, receiver_home]) == receiver_home:
                    return False  # Leaves are inaccessible; ancestor replacement is independent.
                return not (mode & os.W_OK) or path in writable
            fake_os.access = access
            fake_sys = mock.Mock()
            fake_sys.argv = ["-c"] + command[8:]
            fake_sys.exit.side_effect = lambda code: (_ for _ in ()).throw(SystemExit(code))
            # Execute the installer-generated code under fake target-user permissions, never sudo/chmod.
            with mock.patch.dict(sys.modules, {"os": fake_os, "sys": fake_sys}):
                try:
                    exec(command[7], {})
                except SystemExit as stopped:
                    return subprocess.CompletedProcess(command, stopped.code, "[]", "")
            self.fail("probe did not terminate")
        return run, executions

    def test_isolation_rejects_inaccessible_receiver_beneath_runner_home(self):
        runner, receiver, receiver_env = self.isolated_layout(nested=True)
        run, _ = self.permission_probe(receiver.pw_dir, writable=[runner.pw_dir])
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(runner.pw_dir, ".env"), runner, "runner", receiver_env,
                                           receiver, run, self.tmp.name)

    def test_isolation_probe_rejects_writable_shared_ancestor(self):
        runner, receiver, receiver_env = self.isolated_layout()
        run, executed = self.permission_probe(receiver.pw_dir, writable=[self.tmp.name])
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(runner.pw_dir, ".env"), runner, "runner", receiver_env,
                                           receiver, run, self.tmp.name)
        self.assertEqual(len(executed), 1)

    def test_isolation_probe_allows_readable_traversable_but_not_writable_ancestors(self):
        runner, receiver, receiver_env = self.isolated_layout()
        run, executed = self.permission_probe(receiver.pw_dir)
        bridge.check_protected_install(os.path.join(runner.pw_dir, ".env"), runner, "runner", receiver_env,
                                       receiver, run, self.tmp.name)
        self.assertEqual(len(executed), 1)

    def test_isolation_rejects_symlink_hidden_home_overlap(self):
        runner, receiver, receiver_env = self.isolated_layout()
        alias = os.path.join(self.tmp.name, "alias")
        os.symlink(receiver.pw_dir, alias)
        runner.pw_dir = alias
        run, _ = self.permission_probe(receiver.pw_dir)
        with self.assertRaises(bridge.BridgeError):
            bridge.check_protected_install(os.path.join(alias, ".env"), runner, "runner", receiver_env,
                                           receiver, run, self.tmp.name)


class BriefTickTests(unittest.TestCase):
    """Không mở socket hay gọi AI; chỉ test timeout dùng process group thật."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = os.path.join(self.tmp.name, "state", "brief-state.json")
        self.clock = FakeClock(now=1800000000.0)
        self.agent_calls = []
        self.calls = []
        self.claim_keys = []
        self.identities = [{"profileId": "p1", "kind": "page", "pageName": "Học lái xe",
                            "learnedAt": int(self.clock() * 1000)}]
        self.due = []
        self.auto_finish = set()
        self.briefs = {"p1": {"profileId": "p1", "status": "idle", "attempts": 0, "claimedAt": None}}
        self.errors = {}
        self.agent_result = (0, False)
        self.client = mock.Mock(call=self.call)

    def call(self, method, params=None, idempotency_key=None):
        self.calls.append((method, params))
        if method in self.errors:
            raise self.errors[method]
        if method == "system.status":
            return {"workspace": {"id": "ws1"}}
        if method == "pages.list":
            return {"identities": self.identities}
        if method == "briefs.list":
            return {"briefs": self.due}
        if method == "briefs.claimDue":
            self.claim_keys.append(idempotency_key)
            claims = [b for b in self.due if not params or b["profileId"] == params["profileId"]]
            for brief in claims:
                current = self.briefs[brief['profileId']]
                if current.get('claimedAt') == brief['claimedAt']:
                    current['status'] = 'running'
            return {"briefs": claims}
        if method == "briefs.get":
            profile_id = params["profileId"]
            if profile_id not in self.briefs:
                raise bridge.BridgeError("NOT_FOUND", "Chưa có brief")
            return {"brief": self.briefs[profile_id]}
        if method == "briefs.finish":
            current = self.briefs[params["profileId"]]
            if current["status"] != "running" or params.get("claimedAt") != current["claimedAt"]:
                raise bridge.BridgeError("INVALID_PARAMS", "Claim không khớp")
            current["status"] = "idle"
            return {}
        raise AssertionError("Unexpected method: %s" % method)

    def run_agent(self, cmd, prompt, timeout_sec):
        self.agent_calls.append((cmd, prompt, timeout_sec))
        # The default fake agent completes its own claim, like the real prompt.
        if self.agent_result == (0, False):
            for brief in self.due:
                if ('"profileId": "%s"' % brief['profileId']) in prompt and brief['profileId'] in self.auto_finish:
                    self.briefs[brief['profileId']]['status'] = 'idle'
        return self.agent_result

    def tick(self, env=None, runner=None):
        # Lỗi thiếu API phải hiện thành FAIL rõ ràng trong vòng RED.
        self.assertTrue(callable(getattr(bridge, "brief_tick", None)), "brief_tick chưa được triển khai")
        with mock.patch.object(time, "monotonic", self.clock):
            return bridge.brief_tick(self.client, env or {}, self.state_path,
                                     run_agent=runner or self.run_agent, clock=self.clock)

    def set_due(self, count=1, status="idle"):
        self.due = [{"profileId": "p%d" % i, "pageName": "Page %d" % i, "niche": "Dạy lái xe",
                     "keywords": ["lái xe", "an toàn"], "groupIds": ["g1"], "tone": "Thân thiện",
                     "notes": "Không quảng cáo", "draftsPerDay": 1, "claimedAt": 1800000000000 + i}
                    for i in range(1, count + 1)]
        for brief in self.due:
            if status == 'idle':
                self.auto_finish.add(brief['profileId'])
            self.briefs[brief["profileId"]] = dict(brief, status=status, attempts=0)

    def finishes(self):
        return [params for method, params in self.calls if method == "briefs.finish"]

    def test_connection_failure_returns_without_agent(self):
        self.errors["system.status"] = bridge.BridgeError("UNREACHABLE", "offline")
        result = self.tick()
        self.assertEqual(result["ran"], [])
        self.assertFalse(result["onboarded"])
        self.assertEqual(self.agent_calls, [])
        self.assertEqual([m for m, _ in self.calls], ["system.status"])

    def test_nothing_due_uses_no_agent(self):
        self.assertEqual(self.tick(), {"onboarded": False, "ran": [], "warnings": []})
        self.assertEqual(self.agent_calls, [])
        self.assertIn(("briefs.list", None), self.calls)
        self.assertFalse(any(m == 'briefs.claimDue' for m, _ in self.calls))

    def test_empty_pages_onboard_once_per_six_hours_and_save_ms(self):
        self.identities = []
        result = self.tick()
        self.assertTrue(result["onboarded"])
        self.assertEqual(len(self.agent_calls), 1)
        self.assertEqual(self.agent_calls[0][1], bridge.ONBOARD_PROMPT)
        with open(self.state_path) as handle:
            self.assertEqual(json.load(handle), {"lastOnboardAt": 1800000000000})
        self.clock.now += 21599
        self.assertFalse(self.tick()["onboarded"])
        self.assertEqual(len(self.agent_calls), 1)
        self.clock.now += 1
        self.assertTrue(self.tick()["onboarded"])
        self.assertEqual(len(self.agent_calls), 2)
        self.assertEqual(sorted(os.listdir(os.path.dirname(self.state_path))),
                         ["brief-state.json", "brief-state.json.lock"])

    def test_failed_onboarding_is_also_throttled(self):
        self.identities = []
        self.agent_result = (1, False)
        self.tick()
        self.tick()
        self.assertEqual(len(self.agent_calls), 1)

    def test_all_identities_older_than_seven_days_onboard(self):
        self.identities[0]["learnedAt"] -= 7 * 86400 * 1000 + 1
        self.assertTrue(self.tick()["onboarded"])

    def test_one_recent_identity_prevents_age_only_onboarding(self):
        self.identities.append({"profileId": "person1", "kind": "person", "pageName": "",
                                "learnedAt": int((self.clock() - 8 * 86400) * 1000)})
        self.assertFalse(self.tick()["onboarded"])
        self.assertEqual(self.agent_calls, [])

    def test_exactly_seven_days_is_not_older(self):
        self.identities[0]["learnedAt"] -= 7 * 86400 * 1000
        self.assertFalse(self.tick()["onboarded"])

    def test_new_page_without_brief_onboards(self):
        self.identities.append({"profileId": "p2", "kind": "page", "pageName": "Quần áo",
                                "learnedAt": int(self.clock() * 1000)})
        self.assertTrue(self.tick()["onboarded"])
        self.assertIn(("briefs.get", {"profileId": "p2"}), self.calls)

    def test_person_without_brief_does_not_onboard(self):
        self.identities[0]["kind"] = "person"
        self.briefs.clear()
        self.assertFalse(self.tick()["onboarded"])
        self.assertFalse(any(m == "briefs.get" for m, _ in self.calls))

    def test_onboarding_then_claims_new_briefs(self):
        self.identities = []

        def onboard_and_suggest(cmd, prompt, timeout_sec):
            if prompt == bridge.ONBOARD_PROMPT:
                self.set_due()
            return self.run_agent(cmd, prompt, timeout_sec)

        result = self.tick(runner=onboard_and_suggest)
        self.assertEqual(result, {"onboarded": True, "ran": ["p1"], "warnings": []})
        self.assertEqual(len(self.agent_calls), 2)

    def test_due_briefs_run_in_order_with_complete_json(self):
        self.set_due(2)
        result = self.tick()
        self.assertEqual(result, {"onboarded": False, "ran": ["p1", "p2"], "warnings": []})
        self.assertEqual(len(self.agent_calls), 2)
        for brief, (cmd, prompt, timeout_sec) in zip(self.due, self.agent_calls):
            start = prompt.index("{\n")
            embedded, _ = json.JSONDecoder().raw_decode(prompt[start:])
            self.assertEqual(embedded, brief)
            self.assertIn(brief["profileId"], prompt)
            self.assertEqual(cmd, ["claude", "-p", "--allowedTools", "mcp__maihub"])
            self.assertEqual(timeout_sec, 2700)
        self.assertEqual(self.finishes(), [])  # agent đã finish, không finish lần hai

    def test_agent_exit_one_releases_running_brief(self):
        self.set_due(status="running")
        self.agent_result = (1, False)
        self.tick()
        self.assertEqual(self.finishes(), [{"profileId": "p1", "claimedAt": 1800000000001,
                                           "ok": False, "error": "agent thoát mã 1"}])

    def test_agent_exit_zero_without_finish_is_failure(self):
        self.set_due(status="running")
        self.tick()
        self.assertEqual(self.finishes(), [{"profileId": "p1", "claimedAt": 1800000000001,
                                           "ok": False, "error": "agent thoát mã 0"}])

    def test_timeout_releases_running_brief(self):
        self.set_due(status="running")
        self.agent_result = (None, True)
        self.tick()
        self.assertEqual(self.finishes(), [{"profileId": "p1", "claimedAt": 1800000000001,
                                           "ok": False, "error": "agent quá giờ"}])

    def test_replaced_running_claim_warns_without_finishing(self):
        self.set_due(status="running")
        for agent_result in ((1, False), (None, True)):
            with self.subTest(agent_result=agent_result):
                self.agent_result = agent_result
                self.briefs['p1']['claimedAt'] = self.due[0]['claimedAt']
                def replace_after_launch(cmd, prompt, timeout_sec):
                    self.briefs['p1']['claimedAt'] = 1800003600002
                    return self.run_agent(cmd, prompt, timeout_sec)
                result = self.tick(runner=replace_after_launch)
                self.assertEqual(result["ran"], ["p1"])
                self.assertEqual(self.finishes(), [])
                self.assertEqual(len(result["warnings"]), 1)
                self.assertIn("p1", result["warnings"][0])
                self.assertIn("claimedAt", result["warnings"][0])
                self.assertEqual(self.briefs["p1"]["status"], "running")
                self.assertEqual(self.briefs["p1"]["claimedAt"], 1800003600002)

    def test_already_finished_brief_is_not_finished_twice(self):
        self.set_due()
        def finished(cmd, prompt, timeout_sec):
            self.briefs['p1']['status'] = 'idle'
            return (1, False)
        self.tick(runner=finished)
        self.assertEqual(self.finishes(), [])

    def test_invalid_params_from_finish_warns_and_runs_next_brief(self):
        self.set_due(2, status="running")
        self.agent_result = (1, False)
        self.errors["briefs.finish"] = bridge.BridgeError("INVALID_PARAMS", "Đã kết thúc")
        result = self.tick()
        self.assertEqual(result["ran"], ["p1", "p2"])
        self.assertEqual(len(self.agent_calls), 2)
        self.assertEqual([p["profileId"] for p in self.finishes()], ["p1", "p2"])
        self.assertEqual([p["claimedAt"] for p in self.finishes()], [1800000000001, 1800000000002])
        self.assertTrue(any("INVALID_PARAMS" in w for w in result["warnings"]))

    def test_get_failure_warns_and_runs_next_brief(self):
        self.set_due(2)

        def run_then_disconnect(cmd, prompt, timeout_sec):
            self.errors["briefs.get"] = bridge.BridgeError("UNREACHABLE", "offline")
            return self.run_agent(cmd, prompt, timeout_sec)

        result = self.tick(runner=run_then_disconnect)
        self.assertEqual(result["ran"], ["p1"])
        self.assertEqual(len(self.agent_calls), 1)
        self.assertEqual(len(result["warnings"]), 2)

    def test_old_maihub_warns_once_without_agent(self):
        self.errors["pages.list"] = bridge.BridgeError("UNKNOWN_METHOD", "pages.list")
        self.assertEqual(self.tick(), {"onboarded": False, "ran": [], "warnings": ["MaiHub cần ≥ 26.32.0"]})
        self.assertEqual(self.agent_calls, [])
        self.assertEqual([m for m, _ in self.calls], ["system.status", "pages.list"])

    def test_held_lock_skips_without_api_or_agent(self):
        os.makedirs(os.path.dirname(self.state_path))
        with open(self.state_path + ".lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.tick(), {"skipped": "locked"})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.agent_calls, [])
        self.assertEqual(self.tick()["ran"], [])  # khoá được nhả

    def test_lock_is_held_while_agent_runs(self):
        self.set_due()

        def check_lock(cmd, prompt, timeout_sec):
            self.assertEqual(self.tick(), {"skipped": "locked"})
            return self.run_agent(cmd, prompt, timeout_sec)

        self.assertEqual(self.tick(runner=check_lock)["ran"], ["p1"])

    def test_agent_command_default_and_shell_quoting(self):
        self.assertTrue(callable(getattr(bridge, "agent_command", None)), "agent_command chưa được triển khai")
        self.assertEqual(bridge.agent_command({}), ["claude", "-p", "--allowedTools", "mcp__maihub"])
        self.assertEqual(bridge.agent_command({"MAIHUB_AGENT_CMD": "codex exec -"}), ["codex", "exec", "-"])
        self.assertEqual(bridge.agent_command({"MAIHUB_AGENT_CMD": "'/opt/AI CLI/claude' -p"}),
                         ["/opt/AI CLI/claude", "-p"])

    def test_custom_command_and_timeout_reach_agent(self):
        self.set_due()
        self.tick({"MAIHUB_AGENT_CMD": "codex exec -", "MAIHUB_AGENT_TIMEOUT_SEC": "123"})
        self.assertEqual(self.agent_calls[0][0], ["codex", "exec", "-"])
        self.assertEqual(self.agent_calls[0][2], 123)

    def test_invalid_agent_config_does_not_claim_work(self):
        for env in ({"MAIHUB_AGENT_CMD": "   "}, {"MAIHUB_AGENT_CMD": "'unclosed"},
                    {"MAIHUB_AGENT_TIMEOUT_SEC": "no"}, {"MAIHUB_AGENT_TIMEOUT_SEC": "0"},
                    {"MAIHUB_AGENT_TIMEOUT_SEC": "-1"}):
            with self.subTest(env=env):
                self.assertTrue(callable(getattr(bridge, "brief_tick", None)), "brief_tick chưa được triển khai")
                with self.assertRaises(bridge.BridgeError) as ctx:
                    bridge.brief_tick(self.client, env, self.state_path, self.run_agent, self.clock)
                self.assertEqual(ctx.exception.code, "CONFIG")
                self.assertFalse(any(m == "briefs.claimDue" for m, _ in self.calls))

    def test_replacement_running_idle_or_missing_prevents_launch_and_finish(self):
        for state in ('running', 'idle', 'missing'):
            with self.subTest(state=state):
                self.set_due(status='running')
                self.agent_calls[:] = []
                self.calls[:] = []
                self.briefs['p1']['claimedAt'] += 3600001
                self.briefs['p1']['status'] = state
                if state == 'missing':
                    # Avoid the onboarding lookup; deletion occurs after the claim.
                    self.identities[0]['kind'] = 'person'
                    del self.briefs['p1']
                def call(method, params=None, idempotency_key=None):
                    if method == 'briefs.claimDue':
                        self.calls.append((method, params))
                        return {'briefs': self.due}
                    return self.call(method, params, idempotency_key)
                self.client.call = call
                result = self.tick()
                self.assertEqual(result['ran'], [])
                self.assertEqual(self.agent_calls, [])
                self.assertEqual(self.finishes(), [])

    def test_jit_claims_never_reserve_waiting_pages_and_failures_are_not_retried(self):
        self.set_due(3, status='running')
        for brief in self.briefs.values():
            brief['status'], brief['claimedAt'] = 'idle', None
        def call(method, params=None, idempotency_key=None):
            if method == 'briefs.claimDue' and params:
                item = next(b for b in self.due if b['profileId'] == params['profileId'])
                self.briefs[item['profileId']] = dict(item, status='running')
            return self.call(method, params, idempotency_key)
        self.client.call = call
        def slow(cmd, prompt, timeout_sec):
            active = [p for p, b in self.briefs.items() if b['status'] == 'running']
            self.assertEqual(len(active), 1)
            self.clock.now += timeout_sec + bridge.AGENT_TERM_GRACE_SEC
            self.agent_calls.append((cmd, prompt, timeout_sec))
            return (1, True)
        result = self.tick(runner=slow)
        self.assertEqual(result['ran'], ['p1', 'p2'])
        self.assertLess(sum(c[2] for c in self.agent_calls), 3300)
        self.assertLess(self.clock() - 1800000000, 3300)
        self.assertEqual(self.briefs['p3']['status'], 'idle')
        claims = [p['profileId'] for m, p in self.calls if m == 'briefs.claimDue']
        self.assertEqual(claims, ['p1', 'p2'])
        self.assertEqual(len(set(self.claim_keys)), len(self.claim_keys))
        self.assertTrue(all(self.claim_keys))

    def test_onboarding_and_oversized_timeout_share_a_monotonic_tick_budget(self):
        self.identities = []
        self.set_due(2)
        def slow(cmd, prompt, timeout_sec):
            self.agent_calls.append((cmd, prompt, timeout_sec))
            self.assertLess(timeout_sec + bridge.AGENT_TERM_GRACE_SEC, 3600)
            self.clock.now += timeout_sec + bridge.AGENT_TERM_GRACE_SEC
            return (1, True)
        result = self.tick({'MAIHUB_AGENT_TIMEOUT_SEC': '99999'}, runner=slow)
        self.assertTrue(result['onboarded'])
        self.assertEqual(result['ran'], [])
        self.assertEqual(len(self.agent_calls), 1)
        self.assertFalse(any(m == 'briefs.claimDue' for m, _ in self.calls))
        self.assertLess(self.clock() - 1800000000, 3300)

    def test_budget_exhausted_during_claim_finishes_owned_claim_without_agent(self):
        self.set_due(status='running')
        def call(method, params=None, idempotency_key=None):
            response = self.call(method, params, idempotency_key)
            if method == 'briefs.claimDue':
                self.clock.now += 3300
            return response
        self.client.call = call
        result = self.tick()
        self.assertEqual(result['ran'], [])
        self.assertEqual(self.agent_calls, [])
        self.assertEqual(self.briefs['p1']['status'], 'idle')
        self.assertEqual(len(self.finishes()), 1)
        self.assertIn('budget', self.finishes()[0]['error'])

    def test_candidate_failure_is_attempted_once_and_next_page_still_runs(self):
        self.set_due(2)
        self.due.append(dict(self.due[0]))  # A repeated candidate cannot retry its failed claim.
        def call(method, params=None, idempotency_key=None):
            if method == 'briefs.claimDue' and params == {'profileId': 'p1'}:
                self.calls.append((method, params))
                raise bridge.BridgeError('UNREACHABLE', 'offline')
            return self.call(method, params, idempotency_key)
        self.client.call = call
        self.assertEqual(self.tick()['ran'], ['p2'])
        self.assertEqual([p['profileId'] for m, p in self.calls if m == 'briefs.claimDue'], ['p1', 'p2'])
        self.assertEqual(sum(m == 'briefs.list' for m, _ in self.calls), 1)

    def test_default_onboarding_and_jobs_share_budget_despite_wall_clock_jump(self):
        self.identities = []
        self.set_due(2, status='running')
        monotonic = FakeClock(now=0)
        def slow(cmd, prompt, timeout_sec):
            self.agent_calls.append((cmd, prompt, timeout_sec))
            monotonic.now += timeout_sec + bridge.AGENT_TERM_GRACE_SEC
            self.clock.now -= 86400  # Lease safety never compares machine wall clocks.
            return (1, True)
        with mock.patch.object(time, 'monotonic', monotonic):
            result = bridge.brief_tick(self.client, {}, self.state_path, run_agent=slow, clock=self.clock)
        self.assertEqual([c[2] for c in self.agent_calls], [2700, 410])
        self.assertEqual(result['ran'], ['p1'])
        self.assertLess(monotonic(), 3300)
        self.assertFalse(any(m == 'briefs.claimDue' and p == {'profileId': 'p2'} for m, p in self.calls))

    def test_unknown_claim_method_warns_once_and_stops_candidates_without_agent(self):
        self.set_due(2)
        self.errors['briefs.claimDue'] = bridge.BridgeError('UNKNOWN_METHOD', 'briefs.claimDue')
        result = self.tick()
        self.assertEqual(result['ran'], [])
        self.assertEqual(result['warnings'], ['MaiHub cần ≥ 26.32.0'])
        self.assertEqual(sum(m == 'briefs.claimDue' for m, _ in self.calls), 1)
        self.assertEqual(self.agent_calls, [])

    def test_resistant_child_guard_cannot_skip_permission_denial(self):
        import inspect
        source = inspect.getsource(self.test_run_agent_kills_resistant_child_after_parent_exits)
        self.assertNotIn('skipTest', source)

    def test_prompts_include_required_steps_and_safety(self):
        self.assertTrue(hasattr(bridge, "ONBOARD_PROMPT"), "ONBOARD_PROMPT chưa được triển khai")
        for text in ("maihub_pages_learn", "pages.learnFinished", "maihub_wait_for", "maihub_pages_list",
                     "maihub_posts_bestTimes", "maihub_briefs_save", "niche", "keywords", "tone", "07:00", "draftsPerDay"):
            self.assertIn(text, bridge.ONBOARD_PROMPT)
        self.set_due()
        self.tick()
        prompt = self.agent_calls[0][1]
        for text in ("maihub_research_search", "30", "research.finished", "maihub_wait_for",
                     "maihub_research_trending", "groupIds", "niche", "notes", "draftsPerDay",
                     "maihub_drafts_create", "plannedAt", "maihub_briefs_finish", "draftIds",
                     "Không gọi maihub_drafts_approve", "Không chép nguyên văn bài nguồn"):
            self.assertIn(text, prompt)
        self.assertTrue(prompt.rstrip().endswith("maihub_briefs_finish"))
        finish_step = next(line for line in prompt.splitlines() if line.startswith("5."))
        for outcome in finish_step.split("Nếu lỗi:"):
            self.assertIn("profileId", outcome)
            self.assertIn("claimedAt", outcome)

    def test_run_agent_sends_prompt_only_via_stdin_in_new_session(self):
        self.assertTrue(callable(getattr(bridge, "run_agent", None)), "run_agent chưa được triển khai")
        process = mock.Mock(returncode=0)
        popen = mock.Mock(return_value=process)
        result = bridge.run_agent(["claude", "-p"], "Lời nhắc bí mật", 123, popen=popen)
        self.assertEqual(result, (0, False))
        self.assertEqual(popen.call_args[0], (["claude", "-p"],))
        self.assertEqual(popen.call_args[1]["stdin"], subprocess.PIPE)
        self.assertTrue(popen.call_args[1]["start_new_session"])
        self.assertEqual(process.communicate.call_args[1],
                         {"input": "Lời nhắc bí mật".encode("utf-8"), "timeout": 123})

    def test_run_agent_escalates_to_sigkill_after_ten_seconds(self):
        self.assertTrue(callable(getattr(bridge, "run_agent", None)), "run_agent chưa được triển khai")
        process = mock.Mock(pid=87654321, returncode=-signal.SIGKILL)
        process.communicate.side_effect = [subprocess.TimeoutExpired("fake", 1), (None, None)]
        clock = FakeClock(now=0)
        with mock.patch.object(os, "killpg") as killpg, \
                mock.patch.object(time, "monotonic", clock), mock.patch.object(time, "sleep", clock.sleep):
            self.assertEqual(bridge.run_agent(["fake"], "prompt", 1, popen=lambda *a, **k: process),
                             (-signal.SIGKILL, True))
        self.assertEqual(killpg.call_args_list[0], mock.call(87654321, signal.SIGTERM))
        self.assertIn(mock.call(87654321, 0), killpg.call_args_list)
        self.assertEqual(killpg.call_args_list[-1], mock.call(87654321, signal.SIGKILL))
        self.assertAlmostEqual(clock(), 10)
        self.assertEqual(process.communicate.call_count, 2)  # vẫn thu hồi cha sau khi dọn group

    def test_run_agent_waits_through_transient_probe_denial_until_group_is_gone(self):
        process = mock.Mock(pid=87654321, returncode=-signal.SIGTERM)
        process.communicate.side_effect = [subprocess.TimeoutExpired("fake", 1), (None, None)]
        process.poll.side_effect = [None, None, -signal.SIGTERM]
        clock = FakeClock(now=0)
        with mock.patch.object(os, "killpg", side_effect=[None, PermissionError(1, "exit pending"),
                                                        PermissionError(1, "exit pending"), ProcessLookupError()]) as killpg, \
                mock.patch.object(time, "monotonic", clock), mock.patch.object(time, "sleep", clock.sleep):
            try:
                result = bridge.run_agent(["fake"], "prompt", 1, popen=lambda *a, **k: process)
            except PermissionError as err:
                self.fail("Transient signal-0 denial escaped before reap: %s" % err)
        self.assertEqual(result, (-signal.SIGTERM, True))
        self.assertEqual(killpg.call_args_list, [mock.call(process.pid, signal.SIGTERM)] + [mock.call(process.pid, 0)] * 3)
        self.assertAlmostEqual(clock(), 0.2)
        self.assertEqual(process.poll.call_count, 3)
        self.assertEqual(process.communicate.call_count, 2)

    def test_run_agent_persistent_probe_denial_reaches_bounded_sigkill(self):
        for deny_kill in (False, True):
            with self.subTest(deny_kill=deny_kill):
                process = mock.Mock(pid=87654321, returncode=-signal.SIGKILL)
                process.communicate.side_effect = [subprocess.TimeoutExpired("fake", 1), (None, None)]
                clock = FakeClock(now=0)
                denied = PermissionError(1, "real KILL denied")
                def killpg(pid, sig):
                    if sig == 0:
                        raise PermissionError(1, "probe denied")
                    if sig == signal.SIGKILL and deny_kill:
                        raise denied
                with mock.patch.object(os, "killpg", side_effect=killpg) as signals, \
                        mock.patch.object(time, "monotonic", clock), mock.patch.object(time, "sleep", clock.sleep):
                    if deny_kill:
                        with self.assertRaises(PermissionError) as caught:
                            bridge.run_agent(["fake"], "prompt", 1, popen=lambda *a, **k: process, term_grace_sec=0.25)
                        self.assertIs(caught.exception, denied)
                    else:
                        try:
                            result = bridge.run_agent(["fake"], "prompt", 1, popen=lambda *a, **k: process, term_grace_sec=0.25)
                        except PermissionError as err:
                            self.fail("Probe denial escaped before bounded escalation: %s" % err)
                        self.assertEqual(result, (-signal.SIGKILL, True))
                self.assertAlmostEqual(clock(), 0.25)
                self.assertEqual(signals.call_args_list, [mock.call(process.pid, signal.SIGTERM)]
                                 + [mock.call(process.pid, 0)] * 4 + [mock.call(process.pid, signal.SIGKILL)])
                self.assertEqual(process.poll.call_count, 4)
                self.assertEqual(process.communicate.call_count, 2)

    def test_run_agent_real_term_denial_propagates_without_probe_or_retry(self):
        process = mock.Mock(pid=87654321)
        process.communicate.side_effect = [subprocess.TimeoutExpired("fake", 1), (None, None)]
        denied = PermissionError(1, "real TERM denied")
        with mock.patch.object(os, "killpg", side_effect=denied) as signals:
            with self.assertRaises(PermissionError) as caught:
                bridge.run_agent(["fake"], "prompt", 1, popen=lambda *a, **k: process)
        self.assertIs(caught.exception, denied)
        signals.assert_called_once_with(process.pid, signal.SIGTERM)
        process.poll.assert_not_called()
        self.assertEqual(process.communicate.call_count, 2)

    def test_run_agent_kills_resistant_child_after_parent_exits(self):
        processes = []

        def cleanup():
            for process in processes:
                try:
                    deadline = time.monotonic() + 5
                    while True:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                            break
                        except ProcessLookupError:
                            break
                        except PermissionError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.01)
                finally:
                    process.kill()
                    process.communicate(timeout=5)

        self.addCleanup(cleanup)  # đăng ký trước khi sinh group, kể cả khi test thất bại
        ready_path = os.path.join(self.tmp.name, "agent-ready")

        def popen(*args, **kwargs):
            self.assertTrue(kwargs.get("start_new_session"))
            process = subprocess.Popen(*args, **kwargs)
            processes.append(process)
            deadline = time.monotonic() + 5
            while not os.path.exists(ready_path):
                self.assertLess(time.monotonic(), deadline, "Child did not install SIGTERM trap")
                time.sleep(0.01)
            return process

        cmd = ["/bin/sh", "-c", '(trap "" TERM; : > "$1"; exec sleep 30) & wait', "agent", ready_path]
        started = time.monotonic()
        _, timed_out = bridge.run_agent(cmd, "", 0.1, popen=popen, term_grace_sec=0.1)
        self.assertTrue(timed_out)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(processes[0].returncode)
        # SIGKILL bất đồng bộ: cho init thu hồi tiến trình con đã dừng.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.killpg(processes[0].pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                pass  # Darwin có thể trả EPERM trong lúc group vừa SIGKILL đang được thu hồi.
            time.sleep(0.01)
        with self.assertRaises(ProcessLookupError):
            os.killpg(processes[0].pid, 0)

    def test_run_agent_timeout_kills_real_process_group(self):
        self.assertTrue(callable(getattr(bridge, "run_agent", None)), "run_agent chưa được triển khai")
        processes = []

        def cleanup():
            for process in processes:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    process.wait(timeout=5)

        self.addCleanup(cleanup)  # đăng ký trước khi sinh group, kể cả khi test thất bại

        def popen(*args, **kwargs):
            # Không sinh sleep nếu code làm mất session riêng (sẽ không dọn được bằng pid).
            self.assertTrue(kwargs.get("start_new_session"))
            process = subprocess.Popen(*args, **kwargs)
            processes.append(process)
            return process

        started = time.monotonic()
        try:
            _, timed_out = bridge.run_agent(["/bin/sh", "-c", "sleep 30 & sleep 30"], "", 1, popen=popen)
            self.assertTrue(timed_out)
            # Cho init thời gian thu hồi các tiến trình con vừa bị dừng.
            while time.monotonic() - started < 14:
                try:
                    os.killpg(processes[0].pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            self.assertLess(time.monotonic() - started, 15)
            with self.assertRaises(ProcessLookupError):
                os.killpg(processes[0].pid, 0)
        except PermissionError as err:
            self.fail("Cannot create or signal the real agent process group: %s" % err)

    def test_cli_dispatch_loads_env_command_timeout_and_state(self):
        self.set_due()
        env_path = os.path.join(self.tmp.name, ".env")
        with open(env_path, "w") as handle:
            handle.write("MAIHUB_URL=https://hub:7443\nMAIHUB_API_KEY=test\nMAIHUB_CERT_SHA256=" + PIN +
                         "\nMAIHUB_AGENT_CMD=codex exec -\nMAIHUB_AGENT_TIMEOUT_SEC=123\n")
        output = io.StringIO()
        with mock.patch.object(bridge, "MaiHubClient", return_value=self.client), \
                mock.patch.object(bridge, "run_agent", self.run_agent, create=True), \
                mock.patch.dict(os.environ, {}, clear=True), mock.patch("sys.stdout", output):
            code = bridge.main(["brief-tick", "--env-file", env_path, "--state", self.state_path])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["ran"], ["p1"])
        self.assertEqual(self.agent_calls[0][0], ["codex", "exec", "-"])
        self.assertEqual(self.agent_calls[0][2], 123)
        self.assertTrue(os.path.isfile(self.state_path + ".lock"))

    def test_cli_default_state_and_disconnected_exit_zero(self):
        self.errors["system.status"] = bridge.BridgeError("UNREACHABLE", "offline")
        env_path = os.path.join(self.tmp.name, ".env")
        with open(env_path, "w") as handle:
            handle.write("MAIHUB_URL=https://hub:7443\nMAIHUB_API_KEY=test\nMAIHUB_CERT_SHA256=" + PIN + "\n")
        with mock.patch.object(bridge, "MaiHubClient", return_value=self.client), \
                mock.patch("sys.stdout", io.StringIO()), mock.patch("sys.stderr", io.StringIO()):
            code = bridge.main(["--env-file", env_path, "brief-tick"])
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(self.state_path + ".lock"))
        self.assertEqual(self.agent_calls, [])


if __name__ == "__main__":
    unittest.main()
