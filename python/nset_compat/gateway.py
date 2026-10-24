"""Bounded stdlib HTTP gateway. Adapter modules are imported only when available."""
import base64
import binascii
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib
import json
import socket
from socketserver import ThreadingMixIn
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit
from urllib.request import Request as URLRequest
import zlib

from nset_client.transport import APIError
from .common import ProtocolError, Request, Response
from .context import MAX_BODY_BYTES

_PROTOCOL_PREFIXES = ("/api/2.0/", "/ajax-api/", "/graphql", "/compat/", "/wandb/", "/files/", "/artifacts/")
_PROXY_HEADERS = {"content-type", "content-encoding", "cache-control", "etag", "last-modified", "location", "content-disposition", "content-security-policy", "x-content-type-options"}


def _protocol_path(path):
    return path in ("/api/2.0", "/ajax-api", "/compat", "/wandb", "/files", "/artifacts") or path.startswith(_PROTOCOL_PREFIXES)


def _error(exc, path=""):
    body = {"error_code": exc.code, "message": exc.message}
    if path.startswith("/graphql"):
        body["errors"] = [{"message": exc.message, "extensions": {"code": exc.code}}]
    return Response(exc.status, body)


def _authorized(ctx, headers):
    authorization = headers.get("authorization", "")
    kind, _, value = authorization.partition(" ")
    if kind.lower() == "bearer":
        candidate = value.encode()
    elif kind.lower() == "basic":
        try:
            decoded = base64.b64decode(value, validate=True)
            username, sep, candidate = decoded.partition(b":")
            if username != b"api" or not sep:
                return False
        except (ValueError, binascii.Error):
            return False
    else:
        return False
    return hmac.compare_digest(candidate, ctx.token.encode())


def _load_adapters():
    handlers = []
    for name in ("mlflow", "wandb", "tensorboard"):
        module_name = __package__ + "." + name
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            if exc.name != module_name:
                raise  # Missing dependencies inside an installed adapter are real errors.
        else:
            handler = getattr(module, "handle", None)
            # TensorBoard may expose only a collector, not an HTTP handler.
            if handler is not None:
                handlers.append(handler)
    return handlers


def _proxy(ctx, request):
    suffix = "?" + urlencode(request.query) if request.query else ""
    target = ctx.native.url + request.path + suffix
    headers = {"Authorization": "Bearer " + ctx.token,
               "Content-Type": request.headers.get("content-type", "application/json")}
    for key in ("accept", "if-none-match", "if-modified-since"):
        if key in request.headers:
            headers[key] = request.headers[key]
    outgoing = URLRequest(target, data=request.body if request.body else None, headers=headers, method=request.method)
    try:
        upstream = ctx.native.opener.open(outgoing, timeout=ctx.native.timeout)
    except HTTPError as exc:
        upstream = exc  # Preserve native status/body, including redirects; never follow them.
    with upstream:
        deadline = time.monotonic() + ctx.native.timeout
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise ProtocolError(504, "DEADLINE_EXCEEDED", "Native response deadline exceeded")
            chunk = upstream.read1(min(65536, ctx.max_body_bytes + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > ctx.max_body_bytes:
                raise ProtocolError(502, "BACKEND_RESPONSE_TOO_LARGE", "Native response exceeds configured limit")
        return Response(upstream.code, b"".join(chunks), {key: value for key, value in upstream.headers.items() if key.lower() in _PROXY_HEADERS})


class GatewayServer(ThreadingMixIn, HTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, address, ctx, workers, max_body_bytes):
        self.ctx = ctx
        self.max_body_bytes = max_body_bytes
        self.adapters = _load_adapters()
        self.socket_timeout = 10.0
        self.request_timeout = 30.0
        self._slots = threading.BoundedSemaphore(workers)
        self._active = {}
        self._active_lock = threading.Lock()
        super().__init__(address, GatewayHandler)

    def process_request(self, request, client_address):
        request.settimeout(self.socket_timeout)
        if not self._slots.acquire(blocking=False):
            try:
                request.settimeout(0.1)
                body = b'{"error_code":"RESOURCE_EXHAUSTED","message":"Gateway worker capacity exhausted","errors":[{"message":"Gateway worker capacity exhausted","extensions":{"code":"RESOURCE_EXHAUSTED"}}]}'
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        with self._active_lock:
            self._active[request] = time.monotonic() + self.request_timeout
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release(request)
            raise

    def _release(self, request):
        with self._active_lock:
            self._active.pop(request, None)
        self._slots.release()

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release(request)

    def service_actions(self):
        # Absolute connection deadline defeats slow trickle headers/bodies; this
        # runs in the accept loop and needs no per-connection timer threads.
        now = time.monotonic()
        with self._active_lock:
            expired = [sock for sock, deadline in self._active.items() if deadline <= now]
        for sock in expired:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def serve_forever(self, poll_interval=0.1):
        super().serve_forever(poll_interval=poll_interval)

    def server_close(self):
        with self._active_lock:
            sockets = list(self._active)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        super().server_close()

    def handle_error(self, request, client_address):
        # Never dump request bodies, credentials, or exception values to logs.
        pass


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "NsetCompat"
    sys_version = ""
    protocol_version = "HTTP/1.0"  # One request per connection; no pipelining ambiguity.

    def log_message(self, format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self._send(_error(ProtocolError(code, "INVALID_REQUEST", "Invalid HTTP request"), getattr(self, "path", "")))

    def _send(self, response):
        if isinstance(response.body, bytes):
            body = response.body
            content_type = "application/octet-stream"
        else:
            body = json.dumps(response.body, allow_nan=False, separators=(",", ":")).encode()
            content_type = "application/json"
        headers = {key.lower(): value for key, value in response.headers.items()}
        if any(any(c in str(key) + str(value) for c in "\r\n\x00") for key, value in headers.items()):
            raise ProtocolError(500, "INTERNAL_ERROR", "Invalid response header")
        self.close_connection = True
        self.send_response(response.status)
        self.send_header("Content-Type", headers.pop("content-type", content_type))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in headers.items():
            if key not in ("content-length", "connection", "transfer-encoding", "server", "date", "x-content-type-options"):
                self.send_header(key, str(value))
        self.end_headers()
        if getattr(self, "command", "") != "HEAD":
            self.wfile.write(body)

    def _check_deadline(self):
        with self.server._active_lock:
            deadline = self.server._active.get(self.connection, 0)
        if time.monotonic() >= deadline:
            raise ProtocolError(504, "DEADLINE_EXCEEDED", "Request deadline exceeded")

    def _request(self):
        self._check_deadline()
        target = urlsplit(self.path)
        decoded = unquote(target.path)
        if (not self.path.startswith("/") or self.path.startswith("//") or target.scheme or target.netloc or target.fragment
                or "\\" in decoded or any(ord(c) < 32 for c in decoded)
                or any(p in (".", "..") for p in decoded.split("/"))):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Invalid request path")
        try:
            pairs = parse_qsl(target.query, keep_blank_values=True, max_num_fields=256, errors="strict")
        except (ValueError, UnicodeError):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Invalid query parameters") from None
        if len({key for key, _ in pairs}) != len(pairs):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Duplicate query parameter")
        headers = {key.lower(): value for key, value in self.headers.items()}
        for key in ("content-length", "content-encoding", "authorization", "host", "content-type"):
            if len(self.headers.get_all(key, [])) > 1:
                raise ProtocolError(400, "INVALID_REQUEST", "Duplicate framing or authentication header")
        if "transfer-encoding" in headers:
            raise ProtocolError(400, "INVALID_REQUEST", "Transfer-Encoding is not supported; send Content-Length")
        if headers.get("expect"):
            raise ProtocolError(417, "INVALID_REQUEST", "Expect is not supported")
        request = Request(self.command, target.path, dict(pairs), headers)
        protected = self.command not in ("GET", "HEAD") or decoded.startswith("/api") or _protocol_path(decoded)
        if protected and not _authorized(self.server.ctx, headers):
            signed = self.command in ("GET", "HEAD") and self.server.ctx.valid_signature(target.path, request.query)
            if not signed:
                raise ProtocolError(401, "UNAUTHENTICATED", "Valid gateway credentials are required")
        length = headers.get("content-length", "0")
        if not length.isascii() or not length.isdecimal() or len(length) > 20:
            raise ProtocolError(400, "INVALID_REQUEST", "Invalid Content-Length")
        length = int(length)
        if length > self.server.max_body_bytes:
            raise ProtocolError(413, "REQUEST_TOO_LARGE", "Request body exceeds configured limit")
        if self.command in ("POST", "PUT", "PATCH") and "content-length" not in headers:
            raise ProtocolError(411, "INVALID_REQUEST", "Content-Length is required")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ProtocolError(400, "INVALID_REQUEST", "Incomplete request body")
        encoding = headers.get("content-encoding", "identity").lower()
        if encoding == "gzip":
            try:
                inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
                body = inflater.decompress(body, self.server.max_body_bytes + 1)
                if len(body) > self.server.max_body_bytes or inflater.unconsumed_tail:
                    raise ProtocolError(413, "REQUEST_TOO_LARGE", "Decompressed body exceeds configured limit")
                if not inflater.eof or inflater.unused_data:
                    raise ValueError("incomplete or multiple gzip streams")
            except (zlib.error, ValueError):
                raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Invalid gzip body") from None
            request.headers.pop("content-encoding", None)
        elif encoding != "identity":
            raise ProtocolError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content encoding")
        self._check_deadline()
        request.body = body
        request.headers["content-length"] = str(len(body))
        return request

    def _handle(self):
        try:
            request = self._request()
            response = None
            for handler in self.server.adapters:
                response = handler(self.server.ctx, request)
                if response is not None:
                    break
            if response is None:
                if _protocol_path(unquote(request.path)):
                    raise ProtocolError(501, "NOT_IMPLEMENTED", "Unsupported compatibility route")
                response = _proxy(self.server.ctx, request)
            self._send(response)
        except ProtocolError as exc:
            self._send(_error(exc, self.path))
        except APIError as exc:
            self._send(_error(ProtocolError(exc.status, "NATIVE_ERROR", str(exc)), self.path))
        except (TimeoutError, socket.timeout):
            self._send(_error(ProtocolError(504, "DEADLINE_EXCEEDED", "Request deadline exceeded"), self.path))
        except (URLError, ConnectionError):
            self._send(_error(ProtocolError(502, "BACKEND_UNAVAILABLE", "Native backend is unavailable"), self.path))
        except (sqlite3.Error, OSError):
            self._send(_error(ProtocolError(503, "TEMPORARILY_UNAVAILABLE", "Storage or transport unavailable"), self.path))
        except Exception:
            self._send(_error(ProtocolError(500, "INTERNAL_ERROR", "Gateway request failed"), self.path))

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _handle


def make_server(ctx, host="127.0.0.1", port=0, workers=16, max_body_bytes=MAX_BODY_BYTES):
    """Construct but do not start a gateway. The caller owns ctx lifetime."""
    if type(workers) is not int or not 1 <= workers <= 256:
        raise ValueError("workers must be 1..256")
    if type(max_body_bytes) is not int or not 1 <= max_body_bytes <= 1024**3:
        raise ValueError("max_body_bytes must be 1..1073741824")
    ctx.max_body_bytes = max_body_bytes
    server_type = GatewayServer
    if ":" in host:
        class IPv6GatewayServer(GatewayServer):
            address_family = socket.AF_INET6
        server_type = IPv6GatewayServer
    return server_type((host, port), ctx, workers, max_body_bytes)
