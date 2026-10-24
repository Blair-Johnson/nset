"""Gateway-only native HTTP transport with bounded IO and no redirects.

DNS is resolved synchronously at construction (startup), not in HTTP workers.
The resulting addresses remain pinned until a new transport is constructed.
"""
import http.client
import json
import math
import socket
import ssl
import threading
import time
from urllib.parse import urlencode, urlsplit

from nset_client.transport import APIError
from .common import ProtocolError


class _Exchange:
    """Retain the socket even when HTTPConnection hands it to a response."""
    def __init__(self, deadline):
        self.deadline = deadline
        self.lock = threading.Lock()
        self.sock = None
        self.reason = None

    def check(self):
        if self.reason == "deadline" or time.monotonic() >= self.deadline:
            raise TimeoutError("Native response deadline exceeded")
        if self.reason:
            raise ConnectionError("Native transport closed")

    def attach(self, sock):
        with self.lock:
            try:
                self.check()
            except BaseException:
                sock.close()
                raise
            self.sock = sock

    def abort(self, reason):
        with self.lock:
            self.reason = self.reason or reason
            if self.sock is not None:
                try:
                    self.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.sock.close()

    def connect(self, addresses, tls, hostname):
        last_error = None
        for family, kind, proto, _, address in addresses:
            self.check()
            sock = socket.socket(family, kind, proto)
            self.attach(sock)
            try:
                sock.settimeout(max(0.001, self.deadline - time.monotonic()))
                sock.connect(address)  # Numeric sockaddr: no worker-side DNS.
                if tls is not None:
                    # Wrapping must not perform blocking IO while holding lock.
                    with self.lock:
                        self.check()
                        sock = tls.wrap_socket(sock, server_hostname=hostname,
                                               do_handshake_on_connect=False)
                        self.sock = sock
                    sock.do_handshake()
                self.check()
                return sock
            except OSError as exc:
                sock.close()
                self.check()
                last_error = exc
        raise ConnectionError("Native backend is unavailable") from last_error


class _Connection(http.client.HTTPConnection):
    def __init__(self, host, port, exchange, addresses, tls):
        super().__init__(host, port, timeout=max(0.001, exchange.deadline - time.monotonic()))
        self.exchange = exchange
        self.addresses = addresses
        self.tls = tls

    def connect(self):
        self.sock = self.exchange.connect(self.addresses, self.tls, self.host)


class NativeTransport:
    def __init__(self, url, token, timeout=10, max_response_bytes=33554432):
        parsed = urlsplit(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or "?" in url or "#" in url
                or "\\" in url or any(ord(c) <= 32 or ord(c) == 127 for c in url)):
            raise ValueError("native url must be an HTTP(S) origin without credentials, query, or fragment")
        if not token or any(ord(c) < 32 or ord(c) == 127 for c in token):
            raise ValueError("a nonempty single-line token is required")
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        if type(max_response_bytes) is not int or max_response_bytes < 1:
            raise ValueError("max_response_bytes must be a positive integer")
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._host = parsed.hostname.encode("idna").decode("ascii")
        self._port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        if not 1 <= self._port <= 65535:
            raise ValueError("native port must be 1..65535")
        self._tls = ssl.create_default_context() if parsed.scheme == "https" else None
        self._addresses = socket.getaddrinfo(self._host, self._port, type=socket.SOCK_STREAM)
        if not self._addresses:
            raise ValueError("native hostname resolved to no addresses")
        self._lock = threading.Lock()
        self._active = set()
        self._closed = False

    def close(self):
        """Reject new requests and interrupt all active socket IO."""
        with self._lock:
            self._closed = True
            active = list(self._active)
        for exchange in active:
            exchange.abort("closed")

    def raw_request(self, method, path, body=None, headers=None, query=None):
        parsed = urlsplit(path)
        if (not path.startswith("/") or path.startswith("//") or parsed.scheme
                or parsed.netloc or parsed.fragment or "\\" in path
                or any(ord(c) < 32 or ord(c) == 127 for c in path)):
            raise ValueError("native request path must be origin-relative")
        target = path + (("&" if parsed.query else "?") + urlencode(query) if query else "")
        outgoing = {key: value for key, value in (headers or {}).items()
                    if key.lower() not in ("authorization", "host", "connection", "transfer-encoding", "content-length")}
        outgoing["Authorization"] = "Bearer " + self.token
        outgoing["Connection"] = "close"
        # Explicit Host preserves the configured authority, including HTTPS's
        # default port (HTTPConnection otherwise assumes port 80).
        authority = "[" + self._host + "]" if ":" in self._host else self._host
        default_port = 443 if self._tls is not None else 80
        outgoing["Host"] = authority + (":" + str(self._port) if self._port != default_port else "")
        exchange = _Exchange(time.monotonic() + self.timeout)
        with self._lock:
            if self._closed:
                raise ConnectionError("Native transport closed")
            self._active.add(exchange)
        timer = threading.Timer(max(0, exchange.deadline - time.monotonic()), exchange.abort, args=("deadline",))
        timer.daemon = True
        connection = _Connection(self._host, self._port, exchange, self._addresses, self._tls)
        response = None
        try:
            timer.start()
            exchange.check()
            connection.request(method, target, body=body, headers=outgoing)
            response = connection.getresponse()
            exchange.check()
            lengths = response.headers.get_all("Content-Length", [])
            length = None
            if lengths:
                value = lengths[0].strip()
                if len(lengths) != 1 or not value.isascii() or not value.isdecimal() or len(value) > 20:
                    raise ConnectionError("Invalid native Content-Length")
                length = int(value)
            has_body = method.upper() != "HEAD" and response.status not in (204, 304) and response.status >= 200
            limit = self.max_response_bytes
            if has_body and length is not None and length > limit:
                raise ProtocolError(502, "BACKEND_RESPONSE_TOO_LARGE", "Native response exceeds configured limit")
            chunks, size = [], 0
            while has_body:
                exchange.check()
                chunk = response.read1(min(65536, limit + 1 - size))
                exchange.check()
                if not chunk:
                    if response.length not in (None, 0):
                        raise ConnectionError("Incomplete native response")
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > limit:
                    raise ProtocolError(502, "BACKEND_RESPONSE_TOO_LARGE", "Native response exceeds configured limit")
            exchange.check()
            return response.status, b"".join(chunks), {key.lower(): value for key, value in response.getheaders()}
        except (OSError, http.client.HTTPException) as exc:
            exchange.check()
            if isinstance(exc, TimeoutError):
                raise
            raise ConnectionError("Native backend is unavailable") from exc
        finally:
            timer.cancel()
            if timer.ident is not None:
                timer.join()
            if response is not None:
                response.close()
            connection.close()
            with self._lock:
                self._active.discard(exchange)

    def request(self, method, path, payload=None, *, query=None, raw=None,
                content_type="application/json", binary=False):
        body = raw if raw is not None else (
            json.dumps(payload, allow_nan=False).encode() if payload is not None else None)
        status, data, _ = self.raw_request(method, path, body,
                                           {"Content-Type": content_type}, query)
        if status >= 300:
            try:
                message = json.loads(data).get("error", "request failed")
            except (ValueError, AttributeError):
                message = "request failed"
            raise APIError(status, message)
        return data if binary else json.loads(data)
