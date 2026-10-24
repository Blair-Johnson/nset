"""HTTP transport without hidden retries of non-idempotent writes."""
import json
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class APIError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a bearer token to a redirected host.


class Transport:
    def __init__(self, url, token, timeout=30):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("url must be an absolute HTTP(S) address")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("url must not contain credentials, query, or fragment")
        if not token or any(c in token for c in "\r\n"):
            raise ValueError("a nonempty single-line token is required")
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, payload=None, *, query=None, raw=None,
                content_type="application/json", binary=False):
        suffix = "?" + urlencode(query) if query else ""
        body = raw if raw is not None else (
            json.dumps(payload, allow_nan=False).encode() if payload is not None else None
        )
        request = Request(self.url + path + suffix, data=body, method=method,
                          headers={"Authorization": "Bearer " + self.token,
                                   "Content-Type": content_type})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                data = response.read()
                return data if binary else json.loads(data)
        except HTTPError as exc:
            data = exc.read()
            try:
                message = json.loads(data).get("error", "request failed")
            except (ValueError, AttributeError):
                message = "request failed"
            raise APIError(exc.code, message) from None
