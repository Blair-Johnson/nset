"""Local, deterministic bounds tests; no SDK or external backend required."""
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import ssl
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from nset_client.transport import APIError
from nset_compat import CompatContext, ProtocolError, make_server
from nset_compat.upstream import NativeTransport

TOKEN = "native-secret"


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.calls.append((self.command, self.path, dict(self.headers), body))
        self.server.entered.set()
        path = self.path.split("?")[0]
        if path == "/headers":
            for byte in b"HTTP/1.1 200 OK\r\nX-Trickle: " + b"a" * 100:
                self.connection.sendall(bytes([byte]))
                if self.server.stop.wait(0.02):
                    return
            return
        if path == "/body":
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            for _ in range(100):
                self.wfile.write(b" ")
                self.wfile.flush()
                if self.server.stop.wait(0.02):
                    return
            return
        if path == "/stall":
            self.server.stop.wait(5)
            return
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", self.server.redirect)
            self.end_headers()
            return
        if path.startswith("/large"):
            data = b"x" * 256
            self.send_response(500 if "error" in path else 200)
            if "chunked" in path:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                self.wfile.write(b"100\r\n" + data + b"\r\n0\r\n\r\n")
                return
            if "unframed" not in path:
                self.send_header("Content-Length", str(len(data)))
        elif path == "/bad-head":
            data = b""
            self.send_response(200)
            self.send_header("Content-Length", "-1")
        elif path == "/error":
            data = b'{"error":"nope"}'
            self.send_response(409)
            self.send_header("Content-Length", str(len(data)))
        elif path == "/file":
            data = b"nonempty-file"
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
        else:
            data = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        try:
            self.handle_request()
        except (OSError, ConnectionError):
            pass

    do_HEAD = do_POST = do_PUT = do_GET


class UpstreamTests(unittest.TestCase):
    def setUp(self):
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        self.backend.calls = []
        self.backend.entered = threading.Event()
        self.backend.stop = threading.Event()
        self.backend.redirect = "http://127.0.0.1:1/stolen"
        self.thread = threading.Thread(target=self.backend.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.url = "http://localhost:" + str(self.backend.server_port)
        self.addCleanup(self.stop_backend)
        self.native = NativeTransport(self.url, TOKEN, timeout=0.3, max_response_bytes=128)
        self.addCleanup(self.native.close)

    def stop_backend(self):
        self.backend.stop.set()
        self.backend.shutdown()
        self.backend.server_close()
        self.thread.join(2)

    def test_origin_validation(self):
        for suffix in ("/api", "/api/", "?x=1", "?", "#frag", "#", "/%2fapi", "/\\api"):
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                NativeTransport(self.url + suffix, TOKEN)
        for url in ("http://user@localhost", "http://@localhost", "file:///tmp", "http://localhost\n", "http://localhost:0"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                NativeTransport(url, TOKEN)
        with self.assertRaises(ValueError):
            self.native.raw_request("GET", "http://elsewhere/stolen")

    def test_method_query_auth_json_binary_and_dns_only_at_startup(self):
        with patch("nset_compat.upstream.socket.getaddrinfo", side_effect=AssertionError("worker DNS")):
            result = self.native.request("PUT", "/record", {"x": 1}, query={"q": "a b", "empty": ""})
            self.assertEqual(result, {"ok": True})
            method, path, headers, body = self.backend.calls[-1]
            self.assertEqual((method, path), ("PUT", "/record?q=a+b&empty="))
            self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
            self.assertEqual(headers["Host"], "localhost:" + str(self.backend.server_port))
            self.assertEqual(json.loads(body), {"x": 1})
            self.assertEqual(self.native.request("POST", "/", raw=b"binary", content_type="test/type", binary=True), b'{"ok":true}')
            self.assertEqual(self.backend.calls[-1][2]["Content-Type"], "test/type")
            self.assertEqual(self.backend.calls[-1][3], b"binary")
            self.native.raw_request("GET", "/", headers={"Authorization": "evil", "Host": "evil"})
            self.assertEqual(self.backend.calls[-1][2]["Authorization"], "Bearer " + TOKEN)

    def test_redirect_is_not_followed(self):
        self.backend.redirect = self.url + "/stolen"
        status, _, headers = self.native.raw_request("GET", "/redirect")
        self.assertEqual(status, 302)
        self.assertEqual(headers["location"], self.backend.redirect)
        self.assertEqual(len(self.backend.calls), 1)
        with self.assertRaises(APIError) as caught:
            self.native.request("GET", "/redirect")
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual(len(self.backend.calls), 2)

    def test_error_contract(self):
        with self.assertRaises(APIError) as caught:
            self.native.request("GET", "/error")
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("nope", str(caught.exception))

    def test_success_and_error_bodies_are_bounded_for_both_apis(self):
        for path in ("/large", "/large-error", "/large-unframed", "/large-error-unframed", "/large-chunked", "/large-error-chunked"):
            for request in (self.native.request, self.native.raw_request):
                with self.subTest(path=path, request=request), self.assertRaises(ProtocolError) as caught:
                    request("GET", path)
                self.assertEqual(caught.exception.code, "BACKEND_RESPONSE_TOO_LARGE")
                self.assertFalse(self.native._active)
        self.assertEqual(self.native.request("GET", "/"), {"ok": True})

    def test_absolute_deadline_covers_trickle_headers_and_body(self):
        for path in ("/headers", "/body"):
            for request in (self.native.request, self.native.raw_request):
                started = time.monotonic()
                with self.subTest(path=path, request=request), self.assertRaises(TimeoutError):
                    request("GET", path)
                self.assertLess(time.monotonic() - started, 1.0)
                self.assertFalse(self.native._active)
        self.assertEqual(self.native.request("GET", "/"), {"ok": True})

    def test_connect_deadline_interrupts_registered_socket(self):
        class BlockedSocket:
            def __init__(self):
                self.stopped = threading.Event()
            def settimeout(self, value):
                pass
            def connect(self, address):
                if not self.stopped.wait(1):
                    raise AssertionError("connect was not interrupted")
                raise OSError("interrupted")
            def shutdown(self, how):
                self.stopped.set()
            def close(self):
                pass
        sock = BlockedSocket()
        started = time.monotonic()
        with patch("nset_compat.upstream.socket.socket", return_value=sock):
            with self.assertRaises(TimeoutError):
                self.native.raw_request("GET", "/")
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(sock.stopped.is_set())
        self.assertFalse(self.native._active)

    def test_tls_keeps_verification_hostname_sni_and_host(self):
        native = NativeTransport("https://localhost:" + str(self.backend.server_port), TOKEN)
        self.addCleanup(native.close)
        self.assertTrue(native._tls.check_hostname)
        self.assertEqual(native._tls.verify_mode, ssl.CERT_REQUIRED)
        seen = []
        class WrappedSocket:
            def __init__(self, sock):
                self.sock = sock
            def __getattr__(self, name):
                return getattr(self.sock, name)
            def do_handshake(self):
                seen.append("handshake")
        def wrap(sock, *, server_hostname, do_handshake_on_connect):
            seen.append((server_hostname, do_handshake_on_connect))
            return WrappedSocket(sock)
        # An instrumented TLS boundary verifies wiring without external cert tools.
        with patch.object(native._tls, "wrap_socket", side_effect=wrap):
            self.assertEqual(native.request("GET", "/"), {"ok": True})
        self.assertEqual(seen, [("localhost", False), "handshake"])
        self.assertEqual(self.backend.calls[-1][2]["Host"], "localhost:" + str(self.backend.server_port))

    def test_tls_handshake_is_interrupted_at_deadline(self):
        native = NativeTransport("https://localhost:" + str(self.backend.server_port), TOKEN, timeout=0.3)
        self.addCleanup(native.close)
        class StalledTLS:
            def __init__(self, sock):
                self.sock = sock
            def __getattr__(self, name):
                return getattr(self.sock, name)
            def do_handshake(self):
                # Backend waits for a request; the client waits for TLS bytes.
                self.sock.recv(1)
        with patch.object(native._tls, "wrap_socket", side_effect=lambda sock, **kw: StalledTLS(sock)):
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                native.request("GET", "/")
            self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(native._active)

    def test_failed_connection_and_close_release_active_requests(self):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))  # Bound but not listening.
            native = NativeTransport("http://127.0.0.1:" + str(reserved.getsockname()[1]), TOKEN, timeout=0.2)
            self.addCleanup(native.close)
            with self.assertRaises((ConnectionError, TimeoutError)):
                native.request("GET", "/")
            self.assertFalse(native._active)
        self.native.timeout = 20
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.native.request, "GET", "/stall")
            self.assertTrue(self.backend.entered.wait(1))
            started = time.monotonic()
            self.native.close()
            with self.assertRaises(ConnectionError):
                future.result(timeout=1)
            self.assertLess(time.monotonic() - started, 1)
        with self.assertRaises(ConnectionError):
            self.native.request("GET", "/")
        self.assertFalse(self.native._active)

    def gateway(self, cap=128):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ctx = CompatContext(self.url, TOKEN, temp.name, "http://localhost")
        self.addCleanup(ctx.close)
        old = ctx.native
        if hasattr(old, "close"):
            old.close()
        ctx.native = self.native  # Parent wires this into production CompatContext.
        server = make_server(ctx, workers=1, max_body_bytes=cap)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.addCleanup(cleanup)
        return ctx, server

    def fetch(self, server, method, path):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def test_gateway_head_metadata_and_invalid_length(self):
        _, server = self.gateway()
        for method in ("GET", "HEAD"):
            status, body, headers = self.fetch(server, method, "/file")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Length"], "13")
            self.assertEqual(body, b"nonempty-file" if method == "GET" else b"")
        self.assertEqual(self.fetch(server, "HEAD", "/bad-head")[0], 502)

    def test_gateway_response_cap_applies_to_proxy_and_receipts(self):
        ctx, server = self.gateway(cap=8)
        self.assertEqual(self.fetch(server, "GET", "/")[0], 502)
        with self.assertRaises(ProtocolError):
            ctx.native.request("GET", "/")
        # HEAD metadata is representation size, not transferred response bytes.
        self.assertEqual(self.fetch(server, "HEAD", "/file")[2]["Content-Length"], "13")

    def test_gateway_deadline_recovers_worker_slot(self):
        _, server = self.gateway()
        for path in ("/headers", "/body"):
            self.assertEqual(self.fetch(server, "GET", path)[0], 504)
            deadline = time.monotonic() + 1
            while server._active and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertFalse(server._active)
            self.assertEqual(self.fetch(server, "GET", "/")[0], 200)

    def test_gateway_shutdown_interrupts_upstream_before_joining(self):
        _, server = self.gateway()
        self.native.timeout = 20
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        self.addCleanup(connection.close)
        connection.request("GET", "/stall")
        self.assertTrue(self.backend.entered.wait(1))
        server.shutdown()
        started = time.monotonic()
        closer = threading.Thread(target=server.server_close, daemon=True)
        closer.start()
        closer.join(1)
        self.assertFalse(closer.is_alive(), "server_close waited for upstream timeout")
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(server._active)
        self.assertFalse(self.native._active)


if __name__ == "__main__":
    unittest.main()
